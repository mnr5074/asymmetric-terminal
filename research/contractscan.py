#!/usr/bin/env python3
"""Contract vulnerability scan: universe builder + historical correlation (stdlib only, keyless, no Nansen/X).

  python3 research/contractscan.py universe   -> data/contractscan_universe.json (crash catalog + eco runners + research DB
                                                 cohorts + same-category CoinGecko control group + terminal watchlist)
  node lib/contractscan.js batch              -> data/contractscan.json (+ data/contractscan_cache/*)
  python3 research/contractscan.py stats      -> data/contractscan_corr.json, data/contractscan_coverage.json,
                                                 data/contractscan_templates.json
  python3 research/contractscan.py all        -> all three

Outcome groups (defined here, from existing data only):
  crashed   : >= 70% below peak now (crash catalog, eco tokens, research DB, CG control set)
  runner    : ran >= 10x (ATH/ATL on CoinGecko, launch->peak in research DB, run_multiple_closes for eco) AND still within 50% of peak
  died      : research-DB cohort 'died' (graduated, now <=10% of peak with < $10K liquidity or < $50K mcap, or never took off)
  fast_crash / slow_bleed : among crashed tokens with a daily close series (data/cg_series, eco closes):
              days from the peak close to the first close <= 30% of peak: <= 7 days = fast_crash, > 30 days = slow_bleed
"""
import json, os, sys, re, math, time, glob, sqlite3, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import get, DATA_DIR, ROOT

CACHE = os.path.join(DATA_DIR, 'contractscan_cache')
os.makedirs(CACHE, exist_ok=True)
def rj(f, d=None):
    try: return json.load(open(os.path.join(DATA_DIR, f)))
    except Exception: return d
def wj(f, v): 
    p = os.path.join(DATA_DIR, f); tmp = p + '.tmp'; json.dump(v, open(tmp, 'w'), indent=None, separators=(',', ':'), default=str); os.replace(tmp, p)

PLAT = {'solana': 'solana', 'ethereum': 'ethereum', 'base': 'base', 'binance-smart-chain': 'bsc', 'arbitrum-one': 'arbitrum', 'polygon-pos': 'polygon',
        'avalanche': 'avalanche', 'optimistic-ethereum': 'optimism', 'blast': 'blast', 'robinhood': 'robinhood', 'tron': 'tron', 'sui': 'sui', 'the-open-network': 'ton'}
HINT = [('solana', ('solana', 'pump-fun', 'pump.fun', 'letsbonk', 'believe', 'moonshot', 'bags', 'metadao', 'raydium')), ('base', ('base', 'virtuals', 'clanker', 'zora')),
        ('bsc', ('four-meme', 'four.meme', 'bsc', 'binance')), ('robinhood', ('robinhood', 'pons'))]
PRIO = ['solana', 'ethereum', 'base', 'bsc', 'robinhood', 'arbitrum', 'polygon', 'avalanche', 'optimism', 'blast', 'tron', 'sui', 'ton']
CATS = ['pump-fun', 'solana-meme-coins', 'base-meme-coins', 'ai-agents', 'virtuals-protocol-ecosystem', 'four-meme-ecosystem', 'letsbonk-fun-ecosystem', 'clanker-ecosystem', 'robinhood-chain-meme', 'pons-launchpad', 'meme-token']

def cg_platforms():
    p = os.path.join(CACHE, 'cg_coins_list.json')
    if not os.path.exists(p) or time.time() - os.path.getmtime(p) > 7 * 86400:
        d = get('https://api.coingecko.com/api/v3/coins/list?include_platform=true'); json.dump(d, open(p, 'w'))
    return {c['id']: {k: v for k, v in (c.get('platforms') or {}).items() if v} for c in json.load(open(p))}

def cg_markets(cat):
    p = os.path.join(CACHE, f'cg_markets_{cat}.json')
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 3 * 86400: return json.load(open(p))
    d = get(f'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category={cat}&order=market_cap_desc&per_page=250&page=1') or []
    json.dump(d, open(p, 'w')); return d

def pick_chain(plats, hints):
    ours = {PLAT[k]: v for k, v in plats.items() if k in PLAT}
    h = ' '.join(hints).lower()
    for ch, keys in HINT:
        if ch in ours and any(k in h for k in keys): return ch, ours[ch], ours
    for ch in PRIO:
        if ch in ours: return ch, ours[ch], ours
    return None, None, ours

def norm(ch, a): return f"{ch}:{a if ch in ('solana', 'tron', 'sui', 'ton') else a.lower()}"

def speed_from_closes(closes, start_idx=0):
    """days from the max close to the first close <= 30% of it (None if never)."""
    xs = [c for c in closes if c]
    if len(xs) < 10: return None
    pk = max(range(len(closes)), key=lambda i: closes[i] or 0); P = closes[pk]
    for j in range(pk + 1, len(closes)):
        if closes[j] and closes[j] <= 0.3 * P: return j - pk
    return None

def universe():
    plats = cg_platforms()
    U = {}
    def add(chain, addr, **kw):
        if not chain or not addr: return None
        k = norm(chain, addr)
        e = U.setdefault(k, {'key': k, 'chain': chain, 'address': addr if chain in ('solana', 'tron', 'sui', 'ton') else addr.lower(), 'groups': [], 'src': []})
        for g in kw.pop('groups', []):
            if g not in e['groups']: e['groups'].append(g)
        s = kw.pop('src', None)
        if s and s not in e['src']: e['src'].append(s)
        for kk, v in kw.items():
            if v is not None and e.get(kk) is None: e[kk] = v
        return e
    unres = []
    # 1) crash catalog
    cat = rj('crash_catalog.json', {}).get('catalog', [])
    for c in cat:
        g = ['catalog'] + (['crashed'] if (c.get('crash_depth_pct') or 0) <= -70 else [])
        if c.get('address'):
            add(c['chain'], c['address'], groups=g, src='crash_catalog', symbol=c.get('symbol'), name=c.get('name'), crash_depth_pct=c.get('crash_depth_pct'), peak_date=c.get('peak_date') or c.get('ath_date'), created=c.get('created') or c.get('first_trade'), run_multiple=c.get('run_multiple'), db_cohort=c.get('cohort'), launchpad=c.get('launchpad'))
            continue
        p = plats.get(c['id'], {})
        ch, a, ours = pick_chain(p, [c.get('launchpad') or ''] + (c.get('categories') or []))
        if not ch:
            unres.append({'id': c['id'], 'symbol': c.get('symbol'), 'why': 'no contract on CoinGecko (native coin)' if not p else 'only on chains the scanner cannot read: ' + ', '.join(sorted(p)), 'platforms': sorted(p)})
            continue
        add(ch, a, groups=g, src='crash_catalog', symbol=c.get('symbol'), name=c.get('name'), cg_id=c['id'], crash_depth_pct=c.get('crash_depth_pct'), peak_date=c.get('ath_date'), run_multiple=c.get('run_multiple_ath_over_atl'), launchpad=c.get('launchpad'), other_chains=sorted(set(ours) - {ch}) or None)
    # 2) eco tokens (closes series)
    for e in rj('crash_catalog_final.json', {}).get('eco_tokens_ranked', []):
        if e.get('status') == 'bad_tick': continue
        d, m = e.get('crash_depth_pct'), e.get('run_multiple_closes') or 0
        g = ['eco'] + (['crashed'] if d is not None and d <= -70 else []) + (['runner'] if m >= 10 and d is not None and d > -50 else [])
        add(e['chain'], e['address'], groups=g, src='eco_tokens_ranked', symbol=e.get('symbol'), crash_depth_pct=d, peak_date=e.get('peak_date'), created=e.get('first_day'), run_multiple=m, launchpad=','.join(e.get('pads') or []))
    eco_closes = {}
    for t in rj('crash_eco.json', {}).get('tokens', []):
        cl = (t.get('ohlcv') or {}).get('closes')
        if cl: eco_closes[norm(t['chain'], t['address'])] = cl
    # 3) research DB cohorts
    try:
        db = sqlite3.connect(os.path.join(DATA_DIR, 'moonshot.db')); db.row_factory = sqlite3.Row
        for r in db.execute("select mint,symbol,name,chain,cohort,multiple,cur_vs_peak,created_ts,peak_ts,launchpad,mint_auth,freeze_auth,lp_locked_pct,rugcheck_rugged,updated_at from tokens where cohort in ('mooned','died','middle')"):
            cvp = r['cur_vs_peak']; m = r['multiple'] or 0
            g = ['research_db', 'db_' + r['cohort']] + (['died'] if r['cohort'] == 'died' else []) + (['crashed'] if cvp is not None and cvp <= 0.3 and r['cohort'] != 'died' else []) + (['runner'] if m >= 10 and cvp is not None and cvp >= 0.5 else [])
            add(r['chain'] or 'solana', r['mint'], groups=g, src='moonshot.db', symbol=r['symbol'], name=r['name'], db_cohort=r['cohort'], run_multiple=m,
                crash_depth_pct=(cvp - 1) * 100 if cvp is not None else None, created=time.strftime('%Y-%m-%d', time.gmtime((r['created_ts'] or 0) / 1000)) if r['created_ts'] else None,
                peak_date=time.strftime('%Y-%m-%d', time.gmtime((r['peak_ts'] or 0) / 1000)) if r['peak_ts'] else None, launchpad=r['launchpad'],
                db_snapshot={'mint_auth': r['mint_auth'], 'freeze_auth': r['freeze_auth'], 'lp_locked_pct': r['lp_locked_pct'], 'rugcheck_rugged': r['rugcheck_rugged'], 'at': r['updated_at']})
    except Exception as ex: print('db error', ex)
    # 4) same-category CoinGecko control group (runners that held / middles), sourced like the crash catalog
    for catn in CATS:
        for m in cg_markets(catn):
            ath, atl, px = m.get('ath'), m.get('atl'), m.get('current_price')
            if not (ath and atl and px): continue
            depth = (px / ath - 1) * 100; run = ath / atl if atl > 0 else None
            g = ['cg_control'] + (['crashed'] if depth <= -70 else []) + (['runner'] if run and run >= 10 and depth > -50 else [])
            if 'crashed' not in g and 'runner' not in g: g.append('cg_middle')
            p = plats.get(m['id'], {})
            ch, a, ours = pick_chain(p, [catn])
            if not ch: continue
            if 'crashed' in g and norm(ch, a) not in U: continue  # crashed CG coins outside the catalog are not needed (catalog already samples them)
            add(ch, a, groups=g, src='cg_markets:' + catn, symbol=(m.get('symbol') or '').upper(), name=m.get('name'), cg_id=m['id'], crash_depth_pct=depth, peak_date=(m.get('ath_date') or '')[:10] or None, run_multiple=run)
    # 5) terminal watchlist (public/app.js DEFAULT_WL) + perps_watch.json symbols
    js = open(os.path.join(ROOT, 'public', 'app.js')).read()
    blk = js[js.find('const DEFAULT_WL'):js.find('];', js.find('const DEFAULT_WL'))]
    wl = re.findall(r"\['(\w+)',\s*'?([A-Za-z0-9_-]+)'?\]", blk.replace("WSOL", "'So11111111111111111111111111111111111111112'"))
    for ch, a in wl: add(ch, a, groups=['watchlist'], src='public/app.js DEFAULT_WL')
    # cohort speed (fast crash vs slow bleed) from daily closes
    for k, e in U.items():
        cl = None
        if e.get('cg_id') and os.path.exists(os.path.join(DATA_DIR, 'cg_series', e['cg_id'] + '.json')):
            try: cl = [p[1] for p in json.load(open(os.path.join(DATA_DIR, 'cg_series', e['cg_id'] + '.json'))).get('prices', [])]
            except Exception: cl = None
            e['series'] = 'cg_series (365d daily)' if cl else None
        if not cl and k in eco_closes: cl = eco_closes[k]; e['series'] = 'crash_eco closes'
        if cl and 'crashed' in e['groups']:
            d = speed_from_closes(cl)
            e['days_peak_to_-70'] = d
            if d is not None and d <= 7: e['groups'].append('fast_crash')
            elif d is not None and d > 30: e['groups'].append('slow_bleed')
            elif d is None and len(cl) >= 30 and max(cl) == cl[0]: e['series_note'] = 'peak at series start (older ATH): speed unknown'
    out = {'generatedAt': int(time.time() * 1000), 'count': len(U), 'tokens': list(U.values()), 'unresolved_catalog': unres,
           'group_counts': dict(collections.Counter(g for e in U.values() for g in e['groups'])), 'chain_counts': dict(collections.Counter(e['chain'] for e in U.values())),
           'catalog_total': len(cat), 'definitions': __doc__.split('Outcome groups')[1].strip()}
    wj('contractscan_universe.json', out)
    print('universe', len(U), out['group_counts'], out['chain_counts'], 'unresolved', len(unres))

# ---------------- statistics ----------------
def fisher_p(a, b, c, d):
    """two-sided Fisher exact p for [[a,b],[c,d]]"""
    n1, n2, m1, n = a + b, c + d, a + c, a + b + c + d
    lg = lambda x: math.lgamma(x + 1)
    def pr(x): return math.exp(lg(n1) + lg(n2) + lg(m1) + lg(n - m1) - lg(n) - lg(x) - lg(n1 - x) - lg(m1 - x) - lg(n2 - m1 + x))
    p0 = pr(a); lo, hi = max(0, m1 - n2), min(n1, m1)
    return min(1.0, sum(pr(x) for x in range(lo, hi + 1) if pr(x) <= p0 * (1 + 1e-7)))
def odds(a, b, c, d):
    """a = feature & outcome, b = feature & control, c = no-feature & outcome, d = no-feature & control. Haldane-corrected OR + Woolf 95% CI."""
    aa, bb, cc, dd = (x + 0.5 for x in (a, b, c, d)) if 0 in (a, b, c, d) else (a, b, c, d)
    orr = (aa * dd) / (bb * cc); se = math.sqrt(1 / aa + 1 / bb + 1 / cc + 1 / dd)
    return orr, math.exp(math.log(orr) - 1.96 * se), math.exp(math.log(orr) + 1.96 * se)

BOOL_FEATS = {
    'evm': ['honeypot', 'mintable', 'owner_retained', 'owner_eoa', 'proxy', 'verified_source', 'blacklist', 'whitelist', 'pausable', 'trading_switch', 'anti_whale', 'anti_whale_modifiable', 'tax_modifiable',
            'hidden_owner', 'owner_change_balance', 'selfdestruct', 'external_call', 'tx_origin_checks', 'tax_gt_5', 'tax_gt_0', 'hidden_tax', 'owner_multisig_or_timelock', 'launch_owner_renounced_after_peak'],
    'solana': ['mint_authority', 'freeze_authority', 'metadata_mutable', 'token2022', 'transfer_fee_any', 'transfer_hook', 'permanent_delegate', 'default_frozen', 'non_transferable', 'pausable', 'mint_close_authority',
               'rugcheck_danger_any', 'rugcheck_contract_danger', 'creator_rug_history', 'lp_unlocked', 'honeypot_mechanics', 'gp_balance_mutable', 'launch_mint_authority', 'launch_freeze_authority', 'db_mint_auth_then', 'db_freeze_auth_then'],
}
def derived(t):
    f = dict(t.get('features') or {})
    if t.get('kind') == 'evm':
        mt = f.get('max_tax')
        f['tax_gt_5'] = None if mt is None else mt > 5; f['tax_gt_0'] = None if mt is None else mt > 0.5
        f['owner_multisig_or_timelock'] = bool(f.get('owner_multisig') or f.get('owner_timelock')) if f.get('owner_retained') else None
        oh = (t.get('evidence') or {}).get('ownershipHistory') or {}
        f['launch_owner_renounced_after_peak'] = None
        if oh.get('status') == 'ok' and oh.get('hasOwnable') and t.get('peak_date'):
            pk = time.mktime(time.strptime(t['peak_date'], '%Y-%m-%d'))
            f['launch_owner_renounced_after_peak'] = (oh.get('renouncedAt') is None) or oh['renouncedAt'] > pk  # owner still active at the peak
    else:
        f['transfer_fee_any'] = (f.get('transfer_fee_bps') or 0) > 0 if f.get('transfer_fee_bps') is not None else None
        f['rugcheck_danger_any'] = bool(f.get('rugcheck_danger')) if 'rugcheck_danger' in f else None  # LEAKY: mostly market-state risks (Low Liquidity, concentration)
        dn = f.get('rugcheck_danger') or []
        f['rugcheck_contract_danger'] = any(re.search(r'Mint Authority|Freeze Authority|Mismatch|Mutable|Transfer|Permanent|Hook', x) for x in dn) if 'rugcheck_danger' in f else None
        f['creator_rug_history'] = any('Creator history' in x for x in dn) if 'rugcheck_danger' in f else None
        f['lp_unlocked'] = None if f.get('lp_locked_pct') is None else f['lp_locked_pct'] < 50
        s = t.get('db_snapshot') or {}
        f['db_mint_auth_then'] = None if s.get('mint_auth') is None else bool(s['mint_auth'])
        f['db_freeze_auth_then'] = None if s.get('freeze_auth') is None else bool(s['freeze_auth'])
    return f

COMPARISONS = [('crashed', 'not_crashed', 'crashed (>=70% below peak) vs not crashed (drawdown < 70%, not dead)'),
               ('crashed', 'runner', 'crashed (>=70% below peak) vs runner (>=10x and still within 50% of peak)'),
               ('died', 'runner', 'died (research-DB dead cohort) vs runner'),
               ('fast_crash', 'slow_bleed', 'fast crash (<=7 days to -70%) vs slow bleed (>30 days)'),
               ('slow_bleed', 'runner', 'slow bleed vs runner')]

def mantel_haenszel(strata):
    """strata: list of (a,b,c,d). MH common OR, Robins-Breslow-Greenland 95% CI, CMH chi2 p (continuity-corrected)."""
    st = [x for x in strata if sum(x) >= 2 and (x[0] + x[2]) > 0 and (x[1] + x[3]) > 0]
    if not st: return None
    R_ = S_ = PR = PSQR = QS = 0.0; A = EA = VA = 0.0
    for a, b, c, d in st:
        n = a + b + c + d; r, s_ = a * d / n, b * c / n; P, Q = (a + d) / n, (b + c) / n
        R_ += r; S_ += s_; PR += P * r; PSQR += P * s_ + Q * r; QS += Q * s_
        A += a; EA += (a + b) * (a + c) / n
        if n > 1: VA += (a + b) * (c + d) * (a + c) * (b + d) / (n * n * (n - 1))
    if R_ == 0 or S_ == 0: return {'or': None, 'note': 'a zero margin in every stratum', 'strata': len(st)}
    orr = R_ / S_; v = PR / (2 * R_ ** 2) + PSQR / (2 * R_ * S_) + QS / (2 * S_ ** 2); se = math.sqrt(v)
    chi = (abs(A - EA) - 0.5) ** 2 / VA if VA > 0 else 0
    return {'or': round(orr, 2), 'ci95': [round(math.exp(math.log(orr) - 1.96 * se), 2), round(math.exp(math.log(orr) + 1.96 * se), 2)], 'p': float('%.3g' % math.erfc(math.sqrt(chi / 2))), 'strata': len(st)}

def stratum(r):  # confounders: chain (EVM) / sampling source (Solana: research-DB pump.fun feed vs CoinGecko/eco lists)
    if r.get('kind') == 'evm': return r['chain']
    return 'research_db' if 'moonshot.db' in r.get('src', []) else 'cg_or_eco'

def stats():
    U = {t['key']: t for t in rj('contractscan_universe.json', {}).get('tokens', [])}
    R = rj('contractscan.json', {}).get('tokens', {})
    rows = []
    for k, u in U.items():
        r = R.get(k)
        if u.get('crash_depth_pct') is not None and u['crash_depth_pct'] > -70 and 'died' not in u['groups'] and 'crashed' not in u['groups']: u['groups'] = u['groups'] + ['not_crashed']
        if r: rows.append({**u, **{kk: r.get(kk) for kk in ('kind', 'features', 'evidence', 'scannable', 'reason', 'flags', 'market', 'skeleton', 'selectors')}})
    # coverage
    cov = {'generatedAt': int(time.time() * 1000), 'by_chain': {}, 'by_group': {}, 'reasons': collections.Counter(), 'catalog': {}}
    for r in [{**u, **(R.get(k) or {})} for k, u in U.items()]:
        ch = r['chain']; c = cov['by_chain'].setdefault(ch, {'tokens': 0, 'scanned': 0, 'scannable': 0, 'goplus_ok': 0, 'honeypot_is_ok': 0, 'rugcheck_ok': 0, 'own_sim': 0, 'own_sim_sell_path': 0, 'verified_known': 0, 'live_pair': 0, 'dead_pair_or_none': 0})
        c['tokens'] += 1
        if k_has(r, 'scannedAt'): c['scanned'] += 1
        if r.get('scannable'): c['scannable'] += 1
        elif r.get('reason'): cov['reasons'][f"{ch}: {r['reason']}"] += 1
        else: cov['reasons'][f'{ch}: not scanned yet'] += 1
        s = r.get('sources') or {}
        if s.get('goplus') == 'ok': c['goplus_ok'] += 1
        if s.get('honeypot_is') == 'ok': c['honeypot_is_ok'] += 1
        if s.get('rugcheck') == 'ok': c['rugcheck_ok'] += 1
        sim = (r.get('evidence') or {}).get('simulation') or {}
        ss = (r.get('evidence') or {}).get('sellSim') or {}
        if sim.get('runs') or ss.get('tries'): c['own_sim'] += 1
        if ss.get('sellOk') is not None: c['own_sim_sell_path'] += 1
        if any(x['label'].startswith('sell') for x in sim.get('runs') or []): c['own_sim_sell_path'] += 1
        if (r.get('features') or {}).get('verified_source') is not None: c['verified_known'] += 1
        liq = (r.get('market') or {}).get('liqUsd') or 0
        if liq >= 1000: c['live_pair'] += 1
        elif r.get('scannable'): c['dead_pair_or_none'] += 1
        for g in r['groups']:
            gg = cov['by_group'].setdefault(g, {'tokens': 0, 'scannable': 0}); gg['tokens'] += 1; gg['scannable'] += 1 if r.get('scannable') else 0
    for ch, c in cov['by_chain'].items(): c['scannable_pct'] = round(100 * c['scannable'] / c['tokens'], 1) if c['tokens'] else None
    uni = rj('contractscan_universe.json', {})
    unres = uni.get('unresolved_catalog', [])
    catk = [r for r in U.values() if 'catalog' in r['groups']]
    cov['catalog'] = {'entries': uni.get('catalog_total'), 'resolved_to_contract': len(catk), 'scannable': sum(1 for r in catk if (R.get(r['key']) or {}).get('scannable')),
                      'unresolved': len(unres), 'unresolved_reasons': dict(collections.Counter(re.sub(r':.*', '', x['why']) for x in unres)),
                      'unresolved_platforms': dict(collections.Counter(p for x in unres for p in x['platforms']).most_common(20))}
    cov['catalog']['scannable_pct_of_entries'] = round(100 * cov['catalog']['scannable'] / cov['catalog']['entries'], 1) if cov['catalog']['entries'] else None
    cov['reasons'] = dict(cov['reasons'].most_common(30))
    wj('contractscan_coverage.json', cov)
    # templates: bytecode skeletons of confirmed honeypots
    sk = collections.defaultdict(lambda: {'tokens': [], 'honeypots': 0, 'outcomes': collections.Counter()})
    for r in rows:
        if r.get('kind') != 'evm' or not r.get('skeleton'): continue
        s = sk[r['skeleton']]; s['tokens'].append(r['key']); hp = (r.get('features') or {}).get('honeypot') is True; s['honeypots'] += hp
        for g in r['groups']:
            if g in ('crashed', 'runner', 'died', 'fast_crash', 'slow_bleed'): s['outcomes'][g] += 1
    hps = [r for r in rows if r.get('kind') == 'evm' and (r.get('features') or {}).get('honeypot') is True and r.get('selectors')]
    nearest = {}
    for r in rows:
        if r.get('kind') != 'evm' or not r.get('selectors'): continue
        A = set(r['selectors']); best = None
        for h in hps:
            if h['key'] == r['key']: continue
            B = set(h['selectors']); j = len(A & B) / len(A | B) if A | B else 0
            if not best or j > best[0]: best = (j, h['key'])
        if best: nearest[r['address']] = {'jaccard': round(best[0], 3), 'to': best[1]}
    tpl = {'generatedAt': int(time.time() * 1000), 'note': 'Library = honeypots confirmed in our own scan (Honeypot.is / GoPlus / own simulation). Skeleton = runtime bytecode with metadata stripped and PUSH20+ immediates zeroed.',
           'honeypots': len(hps), 'skeletons': {k: {'n': len(v['tokens']), 'honeypots': v['honeypots'], 'outcomes': dict(v['outcomes']), 'self': [t.split(':', 1)[1] for t in v['tokens']][:50]} for k, v in sk.items() if len(v['tokens']) > 1 or v['honeypots']},
           'nearest': nearest}
    wj('contractscan_templates.json', tpl)
    # clone families (identical skeleton across >= 3 tokens) with outcomes
    fams = sorted([{'skeleton': k, **v} for k, v in tpl['skeletons'].items() if v['n'] >= 3], key=lambda x: -x['n'])[:15]
    # correlation
    for r in rows:
        if r.get('kind') == 'evm' and r.get('skeleton') and r['skeleton'] in tpl['skeletons']:
            v = tpl['skeletons'][r['skeleton']]; (r.setdefault('features', {}))['same_skeleton_as_honeypot'] = (v['honeypots'] - (1 if (r['features'] or {}).get('honeypot') else 0)) > 0
    BOOL_FEATS['evm'].append('same_skeleton_as_honeypot')
    corr = {'generatedAt': int(time.time() * 1000), 'comparisons': [], 'caveats': [
        'Features are measured NOW (scan date), not at launch: authorities revoked or ownership renounced later look clean; dead tokens may have had their LP pulled or pools closed.',
        'At-launch state is reconstructed only where free history reaches the creation tx (Solana mints with <=2,000 signatures; EVM OwnershipTransferred logs on Ethereum via Blockscout and on Robinhood Chain via RPC). Those rows are reported as launch_* features with their own n.',
        'db_*_then features are the research collector\'s earlier RugCheck snapshot (taken while the token was alive), a second independent time point.',
        'Groups are not random samples: the crash catalog was built from CoinGecko markets/launchpad feeds; runners come from the same CoinGecko categories (control set), the research DB and eco feeds. Survivorship and feed effects remain.',
        'p-values are two-sided Fisher exact, uncorrected for the number of features tested; with ~20 features per comparison, expect ~1 p<0.05 by chance.',
        'Odds ratios use the Haldane +0.5 correction when any cell is 0; CI is Woolf 95%.'], 'clone_families': fams}
    for oc, ctl, label in COMPARISONS:
        for kind in ('solana', 'evm'):
            grp = [r for r in rows if r.get('scannable') and r.get('kind') == kind]
            O = [r for r in grp if oc in r['groups'] and ctl not in r['groups']]; Cc = [r for r in grp if ctl in r['groups'] and oc not in r['groups']]
            res = {'outcome': oc, 'control': ctl, 'label': label, 'chain_kind': kind, 'n_outcome': len(O), 'n_control': len(Cc), 'features': []}
            if len(O) < 5 or len(Cc) < 5: res['note'] = 'too few scanned tokens in one group (<5) for a meaningful odds ratio'; corr['comparisons'].append(res); continue
            for feat in BOOL_FEATS[kind]:
                fo = [derived(r).get(feat) for r in O]; fc = [derived(r).get(feat) for r in Cc]
                a = sum(1 for x in fo if x is True); c = sum(1 for x in fo if x is False); b = sum(1 for x in fc if x is True); d = sum(1 for x in fc if x is False)
                if a + c < 3 or b + d < 3: continue
                if a + b == 0: res['features'].append({'feature': feat, 'n_outcome': a + c, 'n_control': b + d, 'rate_outcome': 0, 'rate_control': 0, 'note': 'never present in either group'}); continue
                if c + d == 0: res['features'].append({'feature': feat, 'n_outcome': a + c, 'n_control': b + d, 'rate_outcome': 1, 'rate_control': 1, 'note': 'present in every token of both groups'}); continue
                orr, lo, hi = odds(a, b, c, d)
                strata = collections.defaultdict(lambda: [0, 0, 0, 0])
                for r, x in zip(O, fo):
                    if x is True: strata[stratum(r)][0] += 1
                    elif x is False: strata[stratum(r)][2] += 1
                for r, x in zip(Cc, fc):
                    if x is True: strata[stratum(r)][1] += 1
                    elif x is False: strata[stratum(r)][3] += 1
                mh = mantel_haenszel([tuple(v) for v in strata.values()])
                res['features'].append({'mh_adjusted': mh, 'strata_cells': {k: v for k, v in strata.items()},'feature': feat, 'n_outcome': a + c, 'n_control': b + d, 'with_outcome': a, 'with_control': b, 'rate_outcome': round(a / (a + c), 3), 'rate_control': round(b / (b + d), 3),
                                        'odds_ratio': round(orr, 2), 'ci95': [round(lo, 2), round(hi, 2)], 'p': float('%.3g' % fisher_p(a, b, c, d))})
            res['features'].sort(key=lambda x: x.get('p', 1))
            corr['comparisons'].append(res)
    wj('contractscan_corr.json', corr)
    for c in corr['comparisons']:
        print('==', c['label'], c['chain_kind'], 'n', c['n_outcome'], c['n_control'], c.get('note', ''))
        for f in c['features'][:8]: print('   ', f)
    print(json.dumps(cov['by_chain'])); print(json.dumps(cov['catalog']))

def k_has(r, k): return r.get(k) is not None

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if cmd in ('universe', 'all'): universe()
    if cmd == 'all':
        import subprocess; subprocess.run(['node', os.path.join(ROOT, 'lib', 'contractscan.js'), 'batch'], check=False)
    if cmd in ('stats', 'all'): stats()
