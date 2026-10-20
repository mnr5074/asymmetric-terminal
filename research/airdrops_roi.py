#!/usr/bin/env python3
"""Airdrop ROI ranking (extends the Airdrop Desk; output data/airdrop_roi.json, served at /api/airdrops/roi).

Question it answers: WHAT to farm for the best expected return per dollar and hour, given saturation.
  EV per wallet = P(token) x FDV x community% x your share            (ranges lo/base/hi, every input labelled)
  your share:  weekly_pool   -> your points / total points (published weekly pools, participant counts)
               capital_share -> deposit / TVL x time-in-window x multiplier (capital-weighted programs)
               per_wallet    -> pool / participants x your weight vs the average wallet
               calibration   -> when FDV or participants are unknown: per-wallet $ of past drops of a similar crowd size
                                (small <150k wallets, mid 150-600k, mega >600k) x P(token) x your weight x survivor haircut
  ROI = EV / (direct costs + capital opportunity cost + expected loss + time value)
Calibration: past drops (data/airdrop_roi_seed.json, sourced wallet counts) priced with DefiLlama coins (free):
  per-wallet $ at the first daily price on/after TGE, plus 30d/90d price change. Tests Martin's saturation thesis.
Free sources only: DefiLlama coins/TVL. X counts are read separately (free x MCP, data/airdrop_roi_xcounts.json) and carried
with their own as-of time. Weekly refresh: scripts/airdrop_roi_weekly.sh or the server scheduler (file older than 7 days).
Estimates, not advice. No keys, no wallets, no auto-trading."""
import json, math, os, sys, time, statistics as st, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('DATA_DIR') or os.path.join(HERE, '..', 'data')
CACHE = os.path.join(HERE, 'cache_airdrop_roi')
os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'asymmetric-terminal-airdrop-roi/1.0'}
NOW = time.time()
REFRESH = '--refresh' in sys.argv
S = ('lo', 'base', 'hi')


def get(url, name, ttl_h=24, immutable=False):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and (immutable or not REFRESH) and NOW - os.path.getmtime(p) < ttl_h * 3600:
        return json.load(open(p))
    for a in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                js = json.load(r)
            json.dump(js, open(p, 'w'))
            return js
        except Exception as e:
            sys.stderr.write(f'fetch {name}: {e}\n'); time.sleep(5 * (a + 1))
    return json.load(open(p)) if os.path.exists(p) else None


def ts(d):
    return int(dt.datetime.strptime(d, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc).timestamp())


def q(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p; f = math.floor(k); c = math.ceil(k)
    return xs[f] if f == c else xs[f] + (xs[c] - xs[f]) * (k - f)


def spearman(a, b):
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    n = len(pairs)
    if n < 4:
        return None, n
    def rank(v):
        o = sorted(range(n), key=lambda i: v[i]); r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[o[j + 1]] == v[o[i]]:
                j += 1
            for k in range(i, j + 1):
                r[o[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    ra, rb = rank([p[0] for p in pairs]), rank([p[1] for p in pairs])
    ma, mb = st.mean(ra), st.mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return (round(num / den, 3) if den else None), n


def bucket_of(n):
    return 'small' if n < 150000 else 'mid' if n <= 600000 else 'mega'


# ---------------- calibration ----------------
def calibration(seed):
    rows = []
    for c in seed['calibration']:
        t0 = ts(c['tge'])
        js = get(f"https://coins.llama.fi/chart/coingecko:{c['gecko']}?start={t0}&span=100&period=1d", f"chart_{c['gecko']}_{c['tge']}.json", ttl_h=24 * 365, immutable=True)
        pts = ((js or {}).get('coins') or {}).get('coingecko:' + c['gecko'], {}).get('prices') or []
        pts = sorted((p['timestamp'], p['price']) for p in pts if p.get('price'))
        p0 = pts[0] if pts else None
        def at(days):
            if not p0:
                return None
            tgt = p0[0] + days * 86400
            best = min(pts, key=lambda x: abs(x[0] - tgt))
            return best[1] if abs(best[0] - tgt) < 4 * 86400 else None
        price0 = p0[1] if p0 else None
        pool = c['tokens'] * price0 if price0 else None
        pw = pool / c['wallets'] if pool else None
        p30, p90 = at(30), at(90)
        rows.append({**{k: c.get(k) for k in ('sym', 'tge', 'tokens', 'wallets', 'src', 'note', 'tge_kind')},
                     'price_day': dt.datetime.fromtimestamp(p0[0], dt.timezone.utc).strftime('%Y-%m-%d') if p0 else None,
                     'price0': price0, 'pool_usd': pool, 'per_wallet_usd': pw,
                     'ret30': (p30 / price0 - 1) if (p30 and price0) else None, 'ret90': (p90 / price0 - 1) if (p90 and price0) else None,
                     'per_wallet_90d_usd': (pw * p90 / price0) if (pw and p90) else None, 'bucket': bucket_of(c['wallets'])})
    ok = [r for r in rows if r['per_wallet_usd']]
    lw = [math.log10(r['wallets']) for r in ok]
    rho_pw, n1 = spearman(lw, [math.log10(r['per_wallet_usd']) for r in ok])
    rho_pool, _ = spearman(lw, [math.log10(r['pool_usd']) for r in ok])
    rho_r90, n3 = spearman(lw, [r['ret90'] for r in ok])
    rho_pool_pw, _ = spearman([math.log10(r['pool_usd']) for r in ok], [math.log10(r['per_wallet_usd']) for r in ok])
    buckets = {}
    for b in ('small', 'mid', 'mega'):
        xs = [r for r in ok if r['bucket'] == b]
        buckets[b] = {'n': len(xs), 'names': [r['sym'] for r in xs],
                      'per_wallet_p25': q([r['per_wallet_usd'] for r in xs], .25), 'per_wallet_median': q([r['per_wallet_usd'] for r in xs], .5),
                      'per_wallet_p75': q([r['per_wallet_usd'] for r in xs], .75),
                      'per_wallet_90d_median': q([r['per_wallet_90d_usd'] for r in xs], .5),
                      'ret90_median': q([r['ret90'] for r in xs], .5), 'ret30_median': q([r['ret30'] for r in xs], .5)}
    crit = 0.52 if n1 >= 14 else 0.55 if n1 >= 12 else 0.65  # ~p<0.05 two-sided critical rho
    verdict = []
    if rho_pw is not None:
        verdict.append(f"More wallets -> lower $ per wallet: Spearman rho = {rho_pw} (n={n1}); {'statistically meaningful at ~5%' if abs(rho_pw) >= crit else 'not significant at ~5%'} (critical |rho| ~{crit}).")
    if rho_pool is not None:
        verdict.append(f"Bigger crowds did NOT come with proportionally bigger pools: rho(wallets, pool $) = {rho_pool}.")
    if rho_r90 is not None:
        verdict.append(f"Crowd size vs 90-day price change after TGE: rho = {rho_r90} (n={n3}).")
    strength = 'weak (backtested on n=%d past drops, famous-drop survivorship)' % n1 if (rho_pw is not None and abs(rho_pw) >= crit) else 'unproven (n=%d)' % n1
    return {'rows': rows, 'buckets': buckets, 'rho_wallets_perwallet': rho_pw, 'rho_wallets_pool': rho_pool, 'rho_wallets_ret90': rho_r90,
            'rho_pool_perwallet': rho_pool_pw, 'n': n1, 'critical_rho': crit, 'verdict': verdict, 'strength': strength,
            'caveats': ['Wallet counts are eligible (not claimed) addresses; TIA had only 191k claimers, so its per-claimer value was ~3x the per-eligible figure.',
                        'Per-wallet is a mean; distributions are tiered/skewed, so a typical wallet got less than the mean.',
                        'These are famous drops (survivorship): many points programs never paid at all, which no sample here captures.',
                        'Price = first DefiLlama daily price on/after the claim date; some TGE dates are approximate (marked assumed).',
                        'Hype is proxied only by crowd size; there is no free historical hype measure for these launches.']}


# ---------------- candidates ----------------
def rng(d, s):
    if d is None or d.get('kind') == 'unknown':
        return None
    return d.get(s, d.get('base'))


def rank_share(rank, n, z):
    h = sum(r ** -z for r in range(1, int(n) + 1))
    return rank ** -z / h


def rank_ladder(c):
    """What moving up the leaderboard is worth (base FDV/comm/P), and the points multiple it needs."""
    n = c['participants']['base']; out = []
    pool = c['p_token']['base'] * c['fdv']['base'] * c['comm_pct']['base'] / 100
    me = c['rank']['base']
    for r in (1000, 500, me, 100, 50, 10):
        row = {'rank': r}
        for s, z in (('steep', c['zipf_s']['lo']), ('mid', c['zipf_s']['base']), ('flat', c['zipf_s']['hi'])):
            row['ev_' + s] = round(pool * rank_share(r, n, z), 2)
            row['pts_x_' + s] = round((me / r) ** z, 2)
        # weekly points rate needed for the rest of the season vs your average so far: (pts_x - 1) x weeks elapsed / weeks left + 1
        el, wl = c.get('weeks_elapsed', {}).get('base'), c['weeks_left']['base']
        row['rate_x_mid'] = round((row['pts_x_mid'] - 1) * el / wl + 1, 1) if (el and r < me) else None
        out.append(row)
    return {'pool_base_usd': pool, 'rows': out, 'weeks_elapsed': c.get('weeks_elapsed'), 'note': 'Base pool (P x FDV x community %) split by a Zipf curve; steep/mid/flat = s 1.2/1.0/0.8. pts_x = total points needed vs yours now; rate_x = weekly points rate needed for the rest of the season vs your average so far (others standing still, so a floor).'}


def model(c, cal, you, live):
    out = {'inputs': {}, 'ev': {}, 'cost': {}, 'roi': {}, 'net': {}}
    inv = {'lo': 'hi', 'base': 'base', 'hi': 'lo'}  # pessimistic scenario uses the 'hi' end of crowd/cost inputs
    for s in S:
        p = rng(c['p_token'], s); k = rng(c['k'], s); wk = rng(c['weeks_left'], s) or 0
        m = c['model']; ev = None
        if m == 'weekly_pool':
            parts = rng(c['participants'], inv[s]); tot = rng(c['total_points'], inv[s]); wp = rng(c['weekly_pool'], s)
            left = rng(c.get('points_left'), s) if c.get('points_left') else wp * wk
            your = min(left, wp * wk) * k / parts if parts else None
            ev = p * rng(c['fdv'], s) * rng(c['comm_pct'], s) / 100 * your / tot if your is not None else None
        elif m == 'capital_share':
            tvl = live.get('tvl', {}).get(c['tvl_live'])
            if tvl:
                share = rng(c['deposit'], 'base') / tvl * min(1, wk / rng(c['window_weeks'], s)) * k
                ev = p * rng(c['fdv'], s) * rng(c['comm_pct'], s) / 100 * rng(c['window_share'], s) * share
        elif m == 'rank_share':  # leaderboard rank -> share of points under a Zipf curve (total points unpublished)
            share = rank_share(rng(c['rank'], s), rng(c['participants'], s), rng(c['zipf_s'], s))
            ev = p * rng(c['fdv'], s) * rng(c['comm_pct'], s) / 100 * share * k
            out['share'] = out.get('share', {}); out['share'][s] = share
        elif m == 'per_wallet':
            parts = rng(c['participants'], inv[s])
            ev = p * rng(c['fdv'], s) * rng(c['comm_pct'], s) / 100 / parts * k
        if ev is None:  # calibration fallback
            b = cal['buckets'].get(c.get('bucket') or 'small') or {}
            key = {'lo': 'per_wallet_p25', 'base': 'per_wallet_median', 'hi': 'per_wallet_p75'}[s]
            if b.get(key):
                ev = p * b[key] * k * rng(you['survivor_haircut'], s)
                out['ev_method'] = f"calibration: {c.get('bucket') or 'small'}-crowd past drops ({', '.join(b['names'])}) per-wallet p25/median/p75 x P(token) x your weight x survivor haircut"
        out['ev'][s] = ev
        # costs (pessimistic scenario uses high cost rates)
        cs = inv[s]
        hours = rng(c['hours_week'], cs) * wk * rng(you['hourly_value_usd'], 'base')
        direct = rng(c['weekly_cost'], cs) * wk
        cap = rng(c['capital'], 'base')
        opp = 0 if c.get('capital_is_yielding') else cap * rng(you['opportunity_rate_yr'], 'base') * wk / 52
        risk = cap * c['risk_yr']['base'] * wk / 52
        cost = hours + direct + opp + risk
        out['cost'][s] = {'total': round(cost, 2), 'time': round(hours, 2), 'direct': round(direct, 2), 'opportunity': round(opp, 2), 'risk': round(risk, 2), 'weeks': wk}
        out['roi'][s] = round(ev / cost, 2) if (ev is not None and cost >= 10) else None  # cost under $10: ROI not meaningful, use EV
        out['net'][s] = round(ev - cost, 2) if ev is not None else None
        out['ev'][s] = round(ev, 2) if ev is not None else None
    out['share'] = out.get('share')
    out.setdefault('ev_method', {'weekly_pool': 'your points (weeks left x weekly pool x your weight / active accounts) / total points x pool $', 'capital_share': 'deposit / TVL x share of the remaining window x multiplier x window allocation x pool $', 'per_wallet': 'pool $ / participants x your weight', 'rank_share': 'pool $ x your share of points implied by your leaderboard rank (Zipf curve over all accounts, since total points are unpublished)'}.get(c['model'], 'unknown (no calibration bucket available)'))
    return out


def saturation(c, x):
    fdv = rng(c.get('fdv'), 'base'); comm = rng(c.get('comm_pct'), 'base'); p = rng(c['p_token'], 'base')
    parts = rng(c.get('participants'), 'base')
    pool = (p * fdv * comm / 100) if (fdv and comm) else None
    left_frac = None
    if pool and c['model'] == 'weekly_pool':  # only the part of the pool still to be distributed matters to a new farmer
        wp = rng(c['weekly_pool'], 'base'); wk = rng(c['weeks_left'], 'base') or 0; tot = rng(c['total_points'], 'base')
        left = min(rng(c['points_left'], 'base'), wp * wk) if c.get('points_left') else wp * wk
        left_frac = left / tot
    rem = pool * left_frac if (pool and left_frac is not None) else pool
    dpp = rem / parts if (rem is not None and parts) else None
    if rem == 0:
        dpp = 0
    s1 = (max(0, min(1, (math.log10(dpp) - 1) / 3)) if dpp > 0 else 0) if dpp is not None else None
    if parts:
        s2 = max(0, min(1, 1 - (math.log10(parts) - 3) / 3.5))
    else:
        s2 = {'small': 0.7, 'mid': 0.4, 'mega': 0.05}.get(c.get('bucket'), 0.5)
    posts = (x or {}).get('posts7d')
    s3 = max(0, min(1, 1 - math.log10(max(posts, 1)) / 4)) if posts is not None else None
    parts_w = [(0.45, s1), (0.35, s2), (0.2, s3)]
    w = sum(a for a, v in parts_w if v is not None)
    score = round(100 * sum(a * v for a, v in parts_w if v is not None) / w, 1) if w else None
    return {'score': score, 'expected_pool_usd': pool, 'remaining_fraction': left_frac, 'remaining_pool_usd': rem, 'pool_per_participant_usd': dpp, 'participants_base': parts, 'x_posts7d': posts,
            'parts': {'pool_per_head': s1, 'crowd': s2, 'quiet_on_x': s3}}


def main():
    seed = json.load(open(os.path.join(DATA, 'airdrop_roi_seed.json')))
    try:
        xc = json.load(open(os.path.join(DATA, 'airdrop_roi_xcounts.json')))
    except Exception:
        xc = {'counts': {}}
    cal = calibration(seed)
    live = {'tvl': {}, 'price': {}}
    for c in seed['candidates']:
        if c.get('tvl_live'):
            js = get(f"https://api.llama.fi/tvl/{c['tvl_live']}", f"tvl_{c['tvl_live']}.json", ttl_h=12)
            if isinstance(js, (int, float)):
                live['tvl'][c['tvl_live']] = float(js)
        if c.get('pool_gecko'):
            js = get(f"https://coins.llama.fi/prices/current/coingecko:{c['pool_gecko']}", f"px_{c['pool_gecko']}.json", ttl_h=12)
            pr = ((js or {}).get('coins') or {}).get('coingecko:' + c['pool_gecko'], {}).get('price')
            if pr:
                live['price'][c['pool_gecko']] = pr
    you = seed['you']; home = you['jurisdiction']
    out = []
    for c in seed['candidates']:
        m = model(c, cal, you, live)
        x = xc.get('counts', {}).get(c.get('x_key') or '')
        sat = saturation(c, x)
        inputs = {k: c[k] for k in ('p_token', 'fdv', 'comm_pct', 'participants', 'total_points', 'weekly_pool', 'points_left', 'weeks_left', 'k', 'deposit', 'window_share',
                                    'capital', 'weekly_cost', 'hours_week', 'risk_yr', 'funding', 'pool_tokens', 'rank', 'zipf_s') if k in c}
        kinds = [v.get('kind') for v in inputs.values() if isinstance(v, dict)]
        n_src = sum(1 for k in kinds if k in ('sourced', 'derived')); n_all = len(kinds)
        tier = ('allowed' if c['us'] == 'allowed' else 'unknown' if c['us'] == 'unknown' else 'restricted') if home == 'US' else 'allowed'
        eligible = tier == 'allowed'
        extra = {}
        if c.get('pool_gecko') and live['price'].get(c['pool_gecko']) and c.get('pool_tokens'):
            extra['pool_usd_live'] = round(c['pool_tokens']['base'] * live['price'][c['pool_gecko']])
            extra['pool_note'] = f"{c['pool_tokens']['base']:,.0f} tokens x live price ${live['price'][c['pool_gecko']]:.3f} (DefiLlama coins)"
        if c['model'] == 'rank_share':
            extra['ladder'] = rank_ladder(c); extra['share'] = m.get('share')
        if c.get('tvl_live') and live['tvl'].get(c['tvl_live']):
            extra['tvl_usd'] = round(live['tvl'][c['tvl_live']])
        out.append({'key': c['key'], 'name': c['name'], 'chain': c['chain'], 'cat': c['cat'], 'url': c['url'], 'status': c['status'], 'status_src': c['status_src'],
                    'confirmed': c.get('confirmed', 'confirmed' in c['status'].lower() and 'not confirmed' not in c['status'].lower() and 'no token' not in c['status'].lower()),
                    'us': c['us'], 'tier': tier, 'us_src': c.get('us_src'), 'us_note': c.get('us_note'), 'eligible_for_you': eligible,
                    'model': c['model'], 'inputs': inputs, 'ev': m['ev'], 'cost': m['cost'], 'roi': m['roi'], 'net': m['net'], 'ev_method': m['ev_method'],
                    'saturation': sat, 'x': x, 'extra': extra, 'plan': c['plan'], 'farming': c.get('farming'),
                    'strength': f"unproven (model estimate; {n_src} of {n_all} inputs sourced/derived, rest assumed)",
                    'inputs_sourced': n_src, 'inputs_total': n_all})
    # rank: eligible first, then base net EV (EV minus all costs), ROI shown alongside
    out.sort(key=lambda r: ({'allowed': 0, 'unknown': 1, 'restricted': 2}[r['tier']], -(r['net']['base'] if r['net']['base'] is not None else -1e9)))
    for i, r in enumerate(out):
        r['rank'] = i + 1
    glob = sorted(out, key=lambda r: -(r['net']['base'] if r['net']['base'] is not None else -1e9))
    for i, r in enumerate(glob):
        r['rank_if_eligible'] = i + 1
    res = {'generatedAt': int(NOW * 1000), 'reviewed': seed['reviewed'], 'you': you, 'candidates': out, 'calibration': cal, 'rejected': seed['rejected'],
           'x_counts_asof': xc.get('fetchedAt'), 'x_counts_source': xc.get('source'), 'live': live,
           'method': {'rank': 'Tiers by your jurisdiction (seed.you): allowed, then terms unknown (check before farming), then restricted (never use a VPN), then base-case net EV = EV - (time + fees + opportunity cost + expected loss). ROI = EV / cost.',
                      'scenarios': 'lo = pessimistic end of every input (incl. larger crowd and higher costs), hi = optimistic end; base = middle. They are not probabilities.',
                      'saturation': 'Score 0-100 (higher = less crowded): 45% expected pool $ per participant (log, $10 -> 0, $10k -> 1), 35% crowd size (log, 1k -> 1, ~3M -> 0; bucket default when unknown), 20% quiet on X (7-day post count, log). Renormalised over available parts.',
                      'refresh': 'Weekly: scripts/airdrop_roi_weekly.sh (prices, TVL, calibration). Seed facts and X counts are re-checked by hand (dates shown).'}}
    json.dump(res, open(os.path.join(DATA, 'airdrop_roi.json'), 'w'), indent=1)
    print('calibration:', cal['verdict'], cal['strength'])
    for b, v in cal['buckets'].items():
        print(b, v['n'], v['names'], v['per_wallet_p25'] and round(v['per_wallet_p25']), v['per_wallet_median'] and round(v['per_wallet_median']), v['per_wallet_p75'] and round(v['per_wallet_p75']), v['ret90_median'])
    for r in out:
        print(r['rank'], r['name'], r['tier'], 'EV', r['ev'], 'cost', r['cost']['base']['total'], 'ROI', r['roi'], 'net', r['net']['base'], 'sat', r['saturation']['score'])


if __name__ == '__main__':
    main()
