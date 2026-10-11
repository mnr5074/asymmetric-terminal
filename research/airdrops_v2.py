#!/usr/bin/env python3
"""Airdrop Desk v2 (additive to research/airdrops.py). Output: data/airdrop_desk.json
 1. Tracker of anticipated airdrops: tokenless protocols (DefiLlama /protocols, grouped by parent) with funding (defillama.com/raises
    page data + per-protocol raises), points/season evidence (official site keywords, news), estimated timeline from evidence.
 2. Under-farmed score: low TVL vs funding, young program, low attention (news count, airdrops.io heat), points evidence, token hints.
 3. Comparables: past points/usage airdrops (data/airdrop_seed.json), TGE-day price from DefiLlama coins API, TVL at TGE from DefiLlama,
    total raised from defillama raises -> airdrop $ value, FDV, FDV/raised, airdrop $ per $1 of TVL, funding->TGE lag.
 4. Speculation tracker: official hints vs community signals (Google News RSS headlines, airdrops.io listing), confirmed vs unconfirmed.
All sources keyless. Numbers are pulled, never typed in, except the curated facts in data/airdrop_seed.json (each with a source URL).
Estimates, not advice: airdrops can be cancelled, delayed, sybil-filtered or worth nothing."""
import json, math, os, re, time, html, statistics as st, urllib.request, urllib.parse, datetime as dt, concurrent.futures as cf
from common import DATA_DIR
from airdrops import fetch, next_data, norm, TOP_BACKERS

NOW = time.time()
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
def jget(url, timeout=40): return json.loads(fetch(url, timeout))
def day(ts): return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime('%Y-%m-%d')
def ts_of(d): return int(dt.datetime.strptime(d, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc).timestamp())
def fnum(v, m=1.0):
    try: v = float(v); return v * m if v > 0 else None
    except (TypeError, ValueError): return None
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def q(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    k = (len(xs) - 1) * p; f = math.floor(k); c = math.ceil(k)
    return xs[f] if f == c else xs[f] + (xs[c] - xs[f]) * (k - f)

SKIP_CAT = {'CEX', 'Chain', 'Canonical Bridge', 'Risk Curators', 'Payments', 'Crypto Card Issuer', 'Developer Tools', 'Wallets', 'Services',
            'Token Locker', 'Ponzi', 'Luck Games', 'Telegram Bot', 'Onchain Capital Allocator', 'Liquid Staking', 'Staking Pool', 'Domains'}
SALE_ROUNDS = re.compile(r'public (token )?sale|token sale|ico\b|ido\b|community sale|launchpad', re.I)
CRYPTO_WORDS = re.compile(r'airdrop|\btokens?\b|\btge\b|crypto|\bdefi\b|blockchain|re?staking|stablecoin|web3|on-?chain|\bdex\b|perps?\b|perpetual|testnet|mainnet|tokenomics|points program|\b(monad|solana|ethereum|arbitrum|sui|bnb chain|hyperliquid|aptos|berachain|movement)\b|\$[A-Z]{2,8}\b|raises \$|seed round|series a|lending protocol', re.I)
TEMPLATE = re.compile(r'funding rounds, token sale review|price today|to usd chart|how to (easily )?buy|price (prediction|forecast)|learn to purchase|kabul university', re.I)
PRICE_PAGE = re.compile(r'price today|to usd chart|price (prediction|forecast)|how to (easily )?buy', re.I)
CONFIRMED = re.compile(r'tokenomics|tge (date|on|set)|token generation event (on|set|date)|airdrop (is )?(live|confirmed|checker|claim)|claim (is )?(live|open)|listing on|lists? \$?[A-Z]{2,8}|token sale|public sale|launches? (its )?\$?[A-Z]{2,8} token', re.I)
SPECUL = re.compile(r'potential airdrop|possible airdrop|how to (get|farm|qualify)|airdrop guide|points (program|campaign)|season \d|could airdrop|retroactive', re.I)
SITE_KW = {'points': r'\bpoints?\b', 'season': r'\bseason\s*\d|\bseason\b', 'leaderboard': r'leaderboard|ranking', 'airdrop': r'airdrop',
           'tge': r'\bTGE\b|token generation', 'tokenomics': r'tokenomics', 'xp/miles': r'\b(xp|miles|shards|pills|marks|gems|sats)\b'}

def google_news(name, days=120):
    """Headlines mentioning the project (keyless Google News RSS). Filters out name collisions by requiring the name + a crypto word."""
    qs = urllib.parse.quote(f'"{name}" (airdrop OR points OR TGE OR token OR crypto)')
    try: h = fetch(f'https://news.google.com/rss/search?q={qs}&hl=en-US&gl=US&ceid=US:en', 25)
    except Exception as e: return None, str(e)
    out = []
    for it in re.findall(r'<item>(.*?)</item>', h, re.S):
        t = html.unescape(re.sub(r'<[^>]+>', '', (re.search(r'<title>(.*?)</title>', it, re.S) or [None, ''])[1] if re.search(r'<title>(.*?)</title>', it, re.S) else ''))
        link = (re.search(r'<link>(.*?)</link>', it) or [None, ''])[1] if re.search(r'<link>(.*?)</link>', it) else ''
        pd = re.search(r'<pubDate>(.*?)</pubDate>', it)
        try: tt = dt.datetime.strptime(pd.group(1), '%a, %d %b %Y %H:%M:%S %Z').replace(tzinfo=dt.timezone.utc).timestamp() if pd else None
        except Exception: tt = None
        if not tt or NOW - tt > days * 86400: continue
        if not re.search(r'(?<![A-Za-z0-9])' + re.escape(name) + r'(?![A-Za-z0-9])', t, re.I) or not CRYPTO_WORDS.search(t): continue
        tpl = bool(TEMPLATE.search(t))
        out.append({'t': day(tt), 'title': t[:200], 'url': link, 'template': tpl, 'price_page': bool(PRICE_PAGE.search(t)),
                    'confirmed_kw': bool(CONFIRMED.search(t)) and not tpl, 'spec_kw': bool(SPECUL.search(t))})
    out.sort(key=lambda x: x['t'], reverse=True)
    return out, 'ok'

def site_scan(url):
    if not url or not url.startswith('http'): return None
    try: h = fetch(url, 15)[:600000]
    except Exception as e: return {'error': str(e)[:80]}
    txt = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<script.*?</script>|<style.*?</style>', ' ', h, flags=re.S)))
    hits = {k: bool(re.search(p, txt, re.I)) for k, p in SITE_KW.items()}
    return {'hits': [k for k, v in hits.items() if v], 'bytes': len(h), 'spa': len(txt) < 1500}

def tvl_stats(series):
    if not series: return {}
    s = [(x['date'], x.get('totalLiquidityUSD') or 0) for x in series]
    s.sort(); last_t, last = s[-1]
    def ago(d):
        tgt = last_t - d * 86400; best = min(s, key=lambda x: abs(x[0] - tgt))
        return best[1] if abs(best[0] - tgt) < 10 * 86400 else None
    first = next((t for t, v in s if v > 1e5), s[0][0])
    peak_t, peak = max(s, key=lambda x: x[1])
    ch = lambda d: (last / ago(d) - 1) if ago(d) else None
    weekly = [[day(t), round(v)] for t, v in s[::7]] + [[day(last_t), round(last)]]
    return {'tvl': last, 'ch30': ch(30), 'ch90': ch(90), 'ch180': ch(180), 'first_100k': day(first), 'age_days': round((NOW - first) / 86400),
            'peak': peak, 'peak_date': day(peak_t), 'from_peak': (last / peak - 1) if peak else None, 'weekly': weekly[-80:]}

def build_comparables(seed, raises_by):
    rows = []
    for c in seed['comparables']:
        r = {k: c.get(k) for k in ('name', 'symbol', 'tge', 'supply', 'airdrop_pct', 'airdrop_note', 'src')}
        t0 = ts_of(c['tge'])
        price, price7 = c.get('ref_price'), None
        if c.get('gecko'):
            for off, key in ((86399, 'price'), (7 * 86400 + 86399, 'price7')):
                try:
                    d = jget(f"https://coins.llama.fi/prices/historical/{t0 + off}/coingecko:{c['gecko']}?searchWidth=12h", 25)['coins'].get('coingecko:' + c['gecko'])
                    if d: (price := d['price']) if key == 'price' else (price7 := d['price'])
                except Exception: pass
        r['price_tge'] = price; r['price_7d'] = price7
        tokens = c.get('airdrop_tokens') or (c['supply'] * c['airdrop_pct'] / 100 if c.get('airdrop_pct') else None)
        if tokens and not r['airdrop_pct']: r['airdrop_pct'] = round(tokens / c['supply'] * 100, 2)
        r['airdrop_tokens'] = tokens
        r['fdv_tge'] = price * c['supply'] if price else None
        r['airdrop_usd'] = tokens * price if (tokens and price) else None
        r['airdrop_usd_7d'] = tokens * price7 if (tokens and price7) else None
        tvl = None
        try:
            if c.get('tvl_slug'):
                ser = jget(f"https://api.llama.fi/protocol/{c['tvl_slug']}", 60).get('tvl') or []
                pts = [x for x in ser if abs(x['date'] - t0) < 4 * 86400]; tvl = pts[0]['totalLiquidityUSD'] if pts else None
            elif c.get('tvl_chain'):
                ser = jget(f"https://api.llama.fi/v2/historicalChainTvl/{c['tvl_chain']}", 60)
                pts = [x for x in ser if abs(x['date'] - t0) < 4 * 86400]; tvl = pts[0]['tvl'] if pts else None
        except Exception: pass
        r['tvl_at_tge'] = tvl
        r['airdrop_per_tvl'] = (r['airdrop_usd'] / tvl) if (r['airdrop_usd'] and tvl) else None
        rz = [x for n in c.get('raise_names', []) for x in raises_by.get(norm(n), [])]
        rz = list({(x.get('date'), x.get('amountUsd'), x.get('round')): x for x in rz}.values())
        pre = [x for x in rz if (x.get('date') or 0) < t0 and not SALE_ROUNDS.search(x.get('round') or '')]
        raised = sum((x.get('amountUsd') or 0) for x in pre)
        r['raised_before_tge'] = raised or None
        r['fdv_per_raised'] = (r['fdv_tge'] / raised) if (raised and r['fdv_tge']) else None
        r['months_last_round_to_tge'] = round((t0 - max(x['date'] for x in pre)) / 86400 / 30.4, 1) if pre else None
        r['months_first_round_to_tge'] = round((t0 - min(x['date'] for x in pre)) / 86400 / 30.4, 1) if pre else None
        rows.append(r)
    S = lambda k: [r[k] for r in rows if r.get(k) is not None and r['name'] != 'YO Protocol']
    stats = {k: {'p25': q(S(k), .25), 'median': q(S(k), .5), 'p75': q(S(k), .75), 'n': len(S(k))}
             for k in ('airdrop_pct', 'fdv_tge', 'fdv_per_raised', 'airdrop_per_tvl', 'months_last_round_to_tge', 'months_first_round_to_tge')}
    return rows, stats

def timeline(rz, news, site, stats):
    ev, bucket = [], 'unknown'
    sale = [x for x in rz if SALE_ROUNDS.search(x.get('round') or '')]
    if sale:
        s = max(sale, key=lambda x: x.get('date') or 0)
        ev.append({'kind': 'funding', 'confirmed': True, 'text': f"{s.get('round')} on {day(s['date'])} (${(s.get('amountUsd') or 0) / 1e6:.2f}M): public token sales usually precede TGE by weeks to a few months", 't': day(s['date'])})
        bucket = 'near'
    conf = [n for n in news if n['confirmed_kw']]
    if conf:
        ev.append({'kind': 'news', 'confirmed': True, 'text': f"Headline: {conf[0]['title']}", 't': conf[0]['t'], 'url': conf[0]['url']}); bucket = 'near'
    seas = [n for n in news if re.search(r'season\s*\d', n['title'], re.I)]
    if seas: ev.append({'kind': 'news', 'confirmed': False, 'text': f"Season mention: {seas[0]['title']}", 't': seas[0]['t'], 'url': seas[0]['url']})
    if site and 'tge' in (site.get('hits') or []) or site and 'tokenomics' in (site.get('hits') or []):
        ev.append({'kind': 'official', 'confirmed': False, 'text': 'Official site mentions TGE/tokenomics'}); bucket = 'near' if bucket == 'unknown' else bucket
    priced = [x for x in rz if not SALE_ROUNDS.search(x.get('round') or '') and x.get('date')]
    est = None
    if priced:
        last = max(x['date'] for x in priced); m = stats['months_last_round_to_tge']
        if m['median'] is not None:
            lo, mid, hi = (last + (m[k] or 0) * 30.4 * 86400 for k in ('p25', 'median', 'p75'))
            est = {'from': day(lo), 'mid': day(mid), 'to': day(hi), 'method': f"last priced round {day(last)} + comparables' last-round-to-TGE lag (p25 {m['p25']:.0f} / median {m['median']:.0f} / p75 {m['p75']:.0f} months, n={m['n']})"}
            if bucket == 'unknown': bucket = 'overdue' if hi < NOW else 'mid' if lo < NOW + 180 * 86400 else 'far'
    return {'bucket': bucket, 'window': est, 'evidence': ev}

def main():
    seed = json.load(open(os.path.join(DATA_DIR, 'airdrop_seed.json')))
    status = {}
    protos = jget('https://api.llama.fi/protocols', 60); status['defillama /protocols'] = f'ok ({len(protos)})'
    try: raises = next_data(fetch('https://defillama.com/raises', 60)).get('raises') or []; status['defillama raises page'] = f'ok ({len(raises)})'
    except Exception as e: raises = []; status['defillama raises page'] = f'failed: {e}'
    RZ = {}
    for r in raises: RZ.setdefault(norm(r.get('name')), []).append(r)
    try: v1 = {c['key']: c for c in json.load(open(os.path.join(DATA_DIR, 'airdrops.json')))['campaigns'] if c.get('heat') is not None}; status['airdrops.io (via airdrops.json)'] = f'ok ({len(v1)})'
    except Exception as e: v1 = {}; status['airdrops.io (via airdrops.json)'] = f'missing: {e}'

    try: CG = jget('https://api.coingecko.com/api/v3/coins/list', 40); status['coingecko coins/list'] = f'ok ({len(CG)})'
    except Exception as e: CG = []; status['coingecko coins/list'] = f'failed: {e}'
    CGN = {}
    for c in CG: CGN.setdefault(norm(c.get('name')), []).append(f"{c['id']} ({(c.get('symbol') or '').upper()})")
    comps, cstats = build_comparables(seed, RZ); status['comparables'] = f"ok ({sum(1 for c in comps if c['airdrop_usd'])}/{len(comps)} priced)"
    log('comparables', [(c['name'], c['airdrop_usd'] and round(c['airdrop_usd'] / 1e6), c['fdv_per_raised'] and round(c['fdv_per_raised'])) for c in comps])

    # group protocols by parent
    E = {}
    for p in protos:
        k = p.get('parentProtocol') or f"id#{p['id']}"
        e = E.setdefault(k, {'key': k, 'children': [], 'tvl': 0.0, 'chains': set(), 'cats': {}, 'url': None, 'twitter': None, 'listed': None, 'token': False})
        e['children'].append(p); t = p.get('tvl') or 0; e['tvl'] += t
        e['chains'].update(p.get('chains') or []); e['cats'][p.get('category')] = e['cats'].get(p.get('category'), 0) + t
        e['url'] = e['url'] or p.get('url'); e['twitter'] = e['twitter'] or p.get('twitter')
        if p.get('listedAt'): e['listed'] = min(e['listed'] or 1e12, p['listedAt'])
        if (p.get('symbol') not in (None, '-', '')) or p.get('gecko_id'): e['token'] = True
    seeds = {f.get('defillama_slug') for f in seed['farms'].values()}
    cands = []
    for k, e in E.items():
        if e['token']: continue
        e['slug'] = k.split('#', 1)[1] if k.startswith('parent#') else e['children'][0]['slug']
        e['name'] = e['children'][0]['name'] if len(e['children']) == 1 else re.sub(r'\s+(V\d|Lending|Vaults?|Loop Vaults|Perps?|DEX|Bridge|AMM)$', '', e['children'][0]['name'], flags=re.I)
        cat = max(e['cats'].items(), key=lambda x: x[1])[0] if e['cats'] else None
        e['category'] = cat
        names = {norm(e['name']), norm(e['slug'])} | {norm(c['name']) for c in e['children']}
        e['raises_page'] = list({(x.get('date'), x.get('amountUsd'), x.get('round')): x for n in names for x in RZ.get(n, [])}.values())
        e['v1'] = next((v1[n] for n in names if n in v1), None)
        if e['slug'] in seeds: cands.append(e); continue
        if cat in SKIP_CAT or e['tvl'] < 3e5 or e['tvl'] > 2e9: continue
        if not e['raises_page'] and not e['v1']: continue
        cands.append(e)
    for e in cands:
        raised = sum((x.get('amountUsd') or 0) for x in e['raises_page'])
        e['pre'] = (math.log10(max(raised, 1e5)) - 5) * 2 - abs(math.log10(max(e['tvl'], 1e5)) - 7) + (2 if e['v1'] else 0) + (50 if e['slug'] in seeds else 0)
    cands.sort(key=lambda e: -e['pre']); cands = cands[:int(os.environ.get('AD2_N', 70))]
    log('candidates', len(cands))

    def detail(e):
        try: d = jget(f"https://api.llama.fi/protocol/{e['slug']}", 60)
        except Exception as ex: d = {}; e['detail_err'] = str(ex)[:80]
        if d.get('symbol') not in (None, '-', '') or d.get('gecko_id'): e['token'] = True
        e['name'] = d.get('name') or e['name']; e['url'] = d.get('url') or e['url']; e['description'] = (d.get('description') or '')[:300]
        tv = d.get('tvl') or []
        e['tvlh'] = tvl_stats(tv)
        rz = d.get('raises') or []
        e['raises'] = [{'date': x.get('date'), 'round': x.get('round'), 'amountUsd': fnum(x.get('amount'), 1e6),
                        'lead': x.get('leadInvestors') or [], 'other': x.get('otherInvestors') or [], 'valuationUsd': fnum(x.get('valuation'), 1e6)} for x in rz] or \
                     [{'date': x.get('date'), 'round': x.get('round'), 'amountUsd': x.get('amountUsd'), 'lead': x.get('leadInvestors') or [], 'other': x.get('otherInvestors') or [], 'valuationUsd': x.get('valuationUsd')} for x in e['raises_page']]
        e['site'] = site_scan(e['url'])
        return e
    with cf.ThreadPoolExecutor(6) as ex: cands = list(ex.map(detail, cands))
    cands = [e for e in cands if not e['token']]
    for i, e in enumerate(cands):
        e['news'], ns = google_news(e['name']); e['news'] = e['news'] or []; time.sleep(0.6)
    status['google news rss'] = f"ok ({sum(1 for e in cands if e['news'])} with headlines)"

    pct_med, pct_lo, pct_hi = cstats['airdrop_pct']['median'], cstats['airdrop_pct']['p25'], cstats['airdrop_pct']['p75']
    mul = cstats['fdv_per_raised']
    out = []
    for e in cands:
        th = e['tvlh']; tvl = th.get('tvl') or e['tvl']
        priced = [x for x in e['raises'] if not SALE_ROUNDS.search(x.get('round') or '')]
        raised = sum((x.get('amountUsd') or 0) for x in priced)
        backers = sorted({b for x in e['raises'] for b in x['lead'] + x['other']})
        top = [b for b in backers if any(t in b.lower() for t in TOP_BACKERS)]
        val = max([x.get('valuationUsd') or 0 for x in e['raises']] or [0]) or None
        news90 = [n for n in e['news'] if NOW - ts_of(n['t']) < 90 * 86400 and not n['template']]
        tok_match = CGN.get(norm(e['name']), []) + CGN.get(norm(e['slug']), [])
        tok_match = sorted(set(tok_match))[:4]
        price_pages = [n['title'] for n in e['news'] if n['price_page']][:2]
        heat = (e['v1'] or {}).get('heat')
        site_hits = (e.get('site') or {}).get('hits') or []
        pts_ev = bool(set(site_hits) & {'points', 'season', 'leaderboard', 'xp/miles'}) or any(re.search(r'points|season|xp\b', n['title'], re.I) for n in e['news']) or bool(e['v1'])
        tl = timeline(e['raises'], e['news'], e.get('site'), cstats)
        age = th.get('age_days') or (round((NOW - e['listed']) / 86400) if e.get('listed') else None)
        # ---- under-farmed score (0-100) ----
        s_tvl = clamp(1 - math.log10(max(tvl, 5e6) / 5e6) / math.log10(200)) * (0.7 if tvl < 5e5 else 1)
        s_fund = clamp((math.log10(raised / tvl) + 2) / 3) if raised and tvl else 0.0
        s_young = clamp(1 - (age or 540) / 540)
        s_quiet = clamp(1 - len(news90) / 25) * (clamp(1 - heat / 150) if heat is not None else 1)
        s_pts = 1.0 if pts_ev else 0.3
        s_hint = {'near': 1.0, 'mid': 0.7, 'far': 0.4, 'overdue': 0.1, 'unknown': 0.2}[tl['bucket']]
        score = 25 * s_tvl + 20 * s_fund + 15 * s_young + 15 * s_quiet + 15 * s_pts + 10 * s_hint + (3 if top else 0)
        flags = []
        if th.get('ch90') is not None and th['ch90'] < -0.6: score -= 8; flags.append(f"TVL fell {th['ch90'] * 100:.0f}% in 90d")
        if (age or 0) > 1095: score -= 10; flags.append('live 3+ years without a token: drop increasingly unlikely')
        if tok_match or price_pages: score -= 12; flags.append('possible existing token: ' + '; '.join(tok_match + price_pages)[:160] + ' (name match, verify)')
        if tl['bucket'] == 'overdue': flags.append("past the comparables' usual funding-to-TGE window with no token news")
        score = round(clamp(score, 0, 100), 1)
        if not pts_ev: score = min(score, 57.9)
        # ---- allocation expectation (comparables) ----
        fdv_src, fdv_lo, fdv_mid, fdv_hi = None, None, None, None
        if val: fdv_lo, fdv_mid, fdv_hi, fdv_src = val, val * 1.5, val * 3, 'last disclosed valuation x1 / x1.5 / x3'
        elif raised and mul['median']: fdv_lo, fdv_mid, fdv_hi, fdv_src = raised * mul['p25'], raised * mul['median'], raised * mul['p75'], f"raised x comparables FDV/raised (p25 {mul['p25']:.0f}x / median {mul['median']:.0f}x / p75 {mul['p75']:.0f}x)"
        pool = {'lo': fdv_lo * pct_lo / 100, 'mid': fdv_mid * pct_med / 100, 'hi': fdv_hi * pct_hi / 100} if fdv_mid else None
        per1k = {k: v * 1000 / tvl for k, v in pool.items()} if (pool and tvl) else None
        why = [f"TVL ${tvl / 1e6:.2f}M" + (f" ({th['ch30'] * 100:+.0f}% 30d)" if th.get('ch30') is not None else ''),
               (f"raised ${raised / 1e6:.1f}M = {raised / tvl:.2f}x TVL" if raised and tvl else 'no disclosed priced round') + (f"; backers incl. {', '.join(top[:3])}" if top else ''),
               f"TVL since {th.get('first_100k')} ({age}d)" if age is not None else 'age unknown',
               f"{len(news90)} crypto headlines in 90d" + (f", airdrops.io heat {heat}" if heat is not None else ', not on airdrops.io'),
               ('points/season evidence: ' + ', '.join(site_hits or ['news/airdrops.io'])) if pts_ev else 'no points program found on homepage/news (may be an SPA: check manually)']
        out.append({'key': e['slug'], 'name': e['name'], 'category': e['category'], 'chains': sorted(e['chains'])[:6], 'url': e['url'], 'twitter': e.get('twitter'),
                    'defillama': f"https://defillama.com/protocol/{e['slug']}", 'description': e.get('description'),
                    'tvl': tvl, 'tvl_hist': th, 'raised_usd': raised or None, 'valuation_usd': val, 'raises': [{**x, 'date': day(x['date']) if x.get('date') else None} for x in e['raises']],
                    'backers': backers[:15], 'top_backers': top, 'age_days': age, 'news': [n for n in e['news'] if not n['template']][:8], 'news_90d': len(news90), 'heat': heat,
                    'airdrops_io': (e['v1'] or {}).get('page'), 'site': e.get('site'), 'points_evidence': pts_ev, 'timeline': tl,
                    'parts': {'low_tvl': round(s_tvl, 2), 'funding_vs_tvl': round(s_fund, 2), 'young': round(s_young, 2), 'quiet': round(s_quiet, 2), 'points': s_pts, 'token_hint': s_hint},
                    'flags': flags, 'token_name_match': tok_match, 'score': score, 'grade': 'A' if score >= 70 else 'B' if score >= 58 else 'C' if score >= 45 else 'D' if score >= 32 else 'F', 'why': why,
                    'alloc': {'fdv': {'lo': fdv_lo, 'mid': fdv_mid, 'hi': fdv_hi, 'method': fdv_src}, 'pool_usd': pool, 'pct_used': [pct_lo, pct_med, pct_hi], 'per_1k_at_today_tvl': per1k}})
    out.sort(key=lambda x: -x['score'])
    # farms (seed) + live DefiLlama history
    farms = {}
    for k, f in seed['farms'].items():
        try: th = tvl_stats(jget(f"https://api.llama.fi/protocol/{f['defillama_slug']}", 60).get('tvl') or [])
        except Exception: th = {}
        farms[k] = {**f, 'tvl_hist': th, 'news': (google_news(f['name'].split(' (')[0])[0] or [])[:10]}
    res = {'generatedAt': int(NOW * 1000), 'sources': status, 'comparables': comps, 'comparable_stats': cstats, 'candidates': out, 'farms': farms,
           'methods': {
               'underfarmed': 'Score 0-100 = 25*low TVL (1 at <=$5M, 0 at $1B, x0.7 under $0.5M) + 20*funding vs TVL (log10(raised/TVL): 0.01x=0, 10x=1) + 15*young (1 - days since TVL first >$100K / 540) + 15*quiet (1 - crypto headlines in 90d / 25, x (1 - airdrops.io heat/150)) + 15*points evidence (1 found, 0.3 unknown) + 10*token hint (near 1, mid 0.7, far 0.4, overdue 0.3, unknown 0.2) + 3 if top-tier backer; -8 if TVL fell >60% in 90d; -10 if live 3+ years; -12 if a CoinGecko coin has the same name or price-page headlines exist (possible token); capped at C (57.9) without points evidence.',
               'timeline': "Evidence first: public token sale round, 'tokenomics/TGE/claim' headlines, TGE/tokenomics on the official site => near. Otherwise window = last priced round + comparables' last-round-to-TGE lag (p25/median/p75).",
               'allocation': 'Community pool $ = FDV estimate x airdrop % (comparables p25/median/p75). FDV estimate = disclosed valuation x1/1.5/3, else total raised x comparables FDV/raised p25/median/p75. Per $1k = pool x 1000 / today TVL: a ceiling that assumes the whole pool is split by capital at today\'s TVL. Real programs weight time, boosts and referrals, and TVL grows.',
               'value_user': 'Your $ = your share of total points x community pool $. Share = your points / total points when total is published; otherwise only a capital share (your deposit / TVL) can be used as a rough proxy for capital-weighted programs.'},
           'limits': ['No free source publishes participant counts for most points programs; news headline count and airdrops.io heat are attention/crowding proxies.',
                      'Homepage keyword scan misses single-page apps that render text with JavaScript; "no points evidence" is not proof there is no program.',
                      'Google News name matching can pick up unrelated companies with the same name; headlines are filtered to ones containing a crypto word.',
                      'Comparables are 2024-2026 large airdrops (survivorship: famous drops); small protocols often airdrop far less or never.',
                      'DefiLlama /raises API is paid (402); funding comes from the public defillama.com/raises page data and per-protocol raises.']}
    with open(os.path.join(DATA_DIR, 'airdrop_desk.json'), 'w') as f: json.dump(res, f)
    log('done', len(out), status)
    for x in out[:15]: log(x['grade'], x['score'], x['name'], round(x['tvl'] / 1e6, 2), x['raised_usd'], x['timeline']['bucket'], x['news_90d'], x['points_evidence'])

if __name__ == '__main__': main()
