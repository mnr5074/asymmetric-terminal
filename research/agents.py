#!/usr/bin/env python3
"""AI Agents desk builder (weighted to Virtuals). Free sources only: Virtuals public API (api.virtuals.io, the endpoints its web
app calls), Virtuals whitepaper (launch modules), CoinGecko free, DefiLlama, DexScreener, GeckoTerminal, Google News RSS,
GitHub public API, Base archive RPC (DOT burn/supply checks). Writes data/agents.json. Never invents numbers: anything not
available is null with a reason. Not financial advice."""
import json, math, os, re, sys, time, statistics, html, urllib.parse, xml.etree.ElementTree as ET
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agents_common import *

NOW = time.time()
CG = 'https://api.coingecko.com/api/v3'
def iso(ts): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts)) if ts else None
def pts(s):
    if not s: return None
    import datetime
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
def cg(path, ttl=900):
    u = CG + path
    return jcache('cg', u, lambda: http(u, min_gap=7), ttl)
def text(u, timeout=25):
    r = urllib.request.Request(u, headers={'user-agent': UA})
    with urllib.request.urlopen(r, timeout=timeout) as f: return f.read().decode('utf8', 'replace')
def gnews(q, days=7, ttl=3 * 3600):
    u = 'https://news.google.com/rss/search?q=' + urllib.parse.quote(f'{q} when:{days}d') + '&hl=en-US&gl=US&ceid=US:en'
    def f():
        try: root = ET.fromstring(text(u))
        except Exception as e: return {'error': str(e)[:120], 'items': []}
        items = []
        for it in root.iter('item'):
            items.append({'title': (it.findtext('title') or '')[:200], 'link': it.findtext('link'), 'date': it.findtext('pubDate'), 'source': (it.find('source').text if it.find('source') is not None else None)})
        return {'items': items}
    return jcache('gnews', u, f, ttl)
SRC = {}
def src(k, fn):
    try: v = fn(); SRC[k] = 'ok'; return v
    except Exception as e: SRC[k] = 'error: ' + str(e)[:160]; return None

# ---------------- VIRTUAL token ----------------
def virtual_token():
    c = cg('/coins/virtual-protocol?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false')
    md = c['market_data']; g = lambda k: (md.get(k) or {}).get('usd') if isinstance(md.get(k), dict) else md.get(k)
    out = {'price_usd': g('current_price'), 'mcap_usd': g('market_cap'), 'fdv_usd': g('fully_diluted_valuation'), 'volume24h_usd': g('total_volume'),
           'circulating': md.get('circulating_supply'), 'total_supply': md.get('total_supply'), 'max_supply': md.get('max_supply'),
           'ch24h_pct': md.get('price_change_percentage_24h'), 'ch7d_pct': md.get('price_change_percentage_7d'), 'ch30d_pct': md.get('price_change_percentage_30d'),
           'ch200d_pct': md.get('price_change_percentage_200d'), 'ch1y_pct': md.get('price_change_percentage_1y'),
           'ath_usd': g('ath'), 'ath_date': (md.get('ath_date') or {}).get('usd'), 'ath_drawdown_pct': g('ath_change_percentage'), 'mcap_rank': c.get('market_cap_rank'), 'source': 'CoinGecko /coins/virtual-protocol'}
    ch = cg('/coins/virtual-protocol/market_chart?vs_currency=usd&days=90&interval=daily', ttl=3600)
    px = ch.get('prices') or []
    if len(px) > 80:
        out['ch90d_pct'] = round((px[-1][1] / px[0][1] - 1) * 100, 2); out['ch90d_from'] = iso(px[0][0] / 1000)
        vols = [v for _, v in ch.get('total_volumes') or []]; out['avg_daily_volume_90d_usd'] = round(statistics.mean(vols)) if vols else None
    out['protocol'] = llama_protocol('virtuals-protocol')
    news = gnews('"Virtuals Protocol" buyback OR burn', 30)
    out['buyback_news'] = [i for i in news.get('items', []) if re.search(r'buy ?back|burn', i['title'], re.I)][:6]
    out['buyback_note'] = ('DefiLlama reports holders revenue (buybacks/burns/distributions) of $%s over 30 days.' % f"{round(out['protocol']['holders_revenue_30d']):,}") if (out['protocol'] or {}).get('holders_revenue_30d') else 'DefiLlama shows no holders-revenue (buyback/burn) series for Virtuals; see the headlines for any announced buybacks (not verified on-chain here).'
    return out

def llama_protocol(slug):
    out = {'slug': slug}
    for dt, key in (('dailyFees', 'fees'), ('dailyRevenue', 'revenue'), ('dailyHoldersRevenue', 'holders_revenue')):
        u = f'https://api.llama.fi/summary/fees/{slug}?dataType={dt}'
        try: d = jcache('llama', u, lambda: http(u, min_gap=0.5), 6 * 3600)
        except Exception: d = None
        if not d or not d.get('totalDataChart'): continue
        ch = d['totalDataChart']; vals = [v for _, v in ch]
        out[f'{key}_24h'] = d.get('total24h'); out[f'{key}_30d'] = sum(vals[-30:]) if len(vals) >= 30 else None; out[f'{key}_prior30d'] = sum(vals[-60:-30]) if len(vals) >= 60 else None
        out[f'{key}_90d'] = sum(vals[-90:]) if len(vals) >= 90 else None; out[f'{key}_all_time'] = d.get('totalAllTime')
        out[f'{key}_30d_trend_pct'] = round((out[f'{key}_30d'] / out[f'{key}_prior30d'] - 1) * 100, 1) if out.get(f'{key}_prior30d') else None
        if key == 'revenue': out['revenue_annualized'] = out['revenue_30d'] * 365 / 30 if out.get('revenue_30d') else None
    return out

# ---------------- Virtuals launchpad ----------------
def vu_now(): return virtual_usd(NOW - 120)

def launch_row(v, vu, start_mcap):
    li = v.get('launchInfo') or {}
    m = (v.get('mcapInVirtual') or 0) * vu
    t_l = pts(v.get('launchedAt')); t_g = pts(v.get('lpCreatedAt'))
    socials = v.get('socials') or {}; vl = (socials.get('VERIFIED_LINKS') or {}) if isinstance(socials, dict) else {}
    base = start_mcap.get(v.get('factory'))
    return {'id': v['id'], 'name': v.get('name'), 'symbol': v.get('symbol'), 'chain': (v.get('chain') or '').lower(), 'status': 'graduated' if v.get('lpAddress') else 'bonding curve',
            'token': v.get('tokenAddress') or v.get('preToken'), 'lp': v.get('lpAddress'), 'factory': v.get('factory'), 'category': v.get('category'),
            'launched_at': v.get('launchedAt'), 'graduated_at': v.get('lpCreatedAt'), 'age_h': round((NOW - t_l) / 3600, 1) if t_l else None,
            'curve_to_grad_h': round((t_g - t_l) / 3600, 2) if (t_l and t_g and t_g >= t_l) else None,
            'mcap_usd': round(m), 'mcap_virtual': round(v.get('mcapInVirtual') or 0), 'volume24h': v.get('volume24h'), 'liquidity_usd': v.get('liquidityUsd'), 'holders': v.get('holderCount'),
            'holders_ch24h_pct': v.get('holderCountPercent24h'), 'top10_pct': v.get('top10HolderPercentage'), 'dev_pct': v.get('devHoldingPercentage'), 'ch24h_pct': v.get('priceChangePercent24h'),
            'x_since_curve_start': round(v['mcapInVirtual'] / base, 2) if (base and v.get('mcapInVirtual')) else None,
            'modules': {'radar': li.get('launchRadarEnabled'), '60days': li.get('isProject60days'), 'acf': li.get('needAcf'), 'antiSniper': li.get('antiSniperTaxType'), 'airdropPct': li.get('airdropPercent'), 'robotics': li.get('isRobotics')},
            'verified': v.get('isVerified'), 'dev_committed': v.get('isDevCommitted'), 'twitter': vl.get('TWITTER'), 'website': vl.get('WEBSITE'), 'url': f"https://app.virtuals.io/virtuals/{v['id']}"}

def start_mcaps():
    """Curve start mcap (VIRTUAL) per factory = most common mcapInVirtual among brand-new 1-holder prototypes (data-derived)."""
    rows = vapi_all('virtuals', {'filters[holderCount][$lte]': 1, 'sort[0]': 'createdAt:desc'}, max_pages=3)
    by = {}
    for v in rows:
        if v.get('mcapInVirtual'): by.setdefault(v.get('factory'), []).append(round(v['mcapInVirtual']))
    return {f: statistics.mode(x) for f, x in by.items() if len(x) >= 3}

def launchpad(vu):
    sm = src('virtuals_start_mcap', start_mcaps) or {}
    since30 = iso(NOW - 30 * 86400); since7 = iso(NOW - 7 * 86400)
    grads = vapi_all('virtuals', {'filters[lpCreatedAt][$gt]': since30, 'sort[0]': 'lpCreatedAt:desc'}, max_pages=3)
    hot = vapi_all('virtuals', {'filters[launchedAt][$gt]': since7, 'filters[launchedAt][$lt]': iso(NOW), 'filters[holderCount][$gte]': 25, 'sort[0]': 'mcapInVirtual:desc'}, max_pages=2)
    top = vapi_all('virtuals', {'filters[lpAddress][$notNull]': 'true', 'sort[0]': 'mcapInVirtual:desc'}, max_pages=1, page_size=40)
    seen = set(); recent = []
    for v in grads + hot:
        if v['id'] in seen: continue
        seen.add(v['id']); recent.append(launch_row(v, vu, sm))
    recent.sort(key=lambda r: -(r['mcap_usd'] or 0))
    # counts per chain over 30d
    counts = {}
    for ch in ('BASE', 'ROBINHOOD', 'SOLANA', 'ETHEREUM', 'ARC'):
        try:
            c = vapi('virtuals', {'filters[chain]': ch, 'filters[createdAt][$gt]': since30, 'pagination[pageSize]': 1})['meta']['pagination']['total']
            g = vapi('virtuals', {'filters[chain]': ch, 'filters[lpCreatedAt][$gt]': since30, 'pagination[pageSize]': 1})['meta']['pagination']['total']
            counts[ch.lower()] = {'created_30d': c, 'graduated_30d': g}
        except Exception: pass
    return {'recent': recent[:80], 'top_agents': [launch_row(v, vu, sm) for v in top], 'counts_30d': counts, 'curve_start_mcap_virtual_by_factory': sm,
            'graduation_threshold_virtual': 42000, 'graduation_threshold_usd': round(42000 * vu)}

def team_info(v):
    try: d = vapi(f"virtuals/{v['id']}/project-members", ttl=6 * 3600)
    except Exception: d = None
    mem = (d or {}).get('data') if isinstance(d, dict) else d
    return mem if isinstance(mem, list) else []

def github_activity(url):
    m = re.match(r'https?://github\.com/([^/]+)(?:/([^/?#]+))?', url or '')
    if not m: return None
    owner, repo = m.group(1), m.group(2)
    try:
        if repo:
            r = jcache('gh', f'{owner}/{repo}', lambda: http(f'https://api.github.com/repos/{owner}/{repo}', min_gap=1), 12 * 3600)
            return {'repo': f'{owner}/{repo}', 'stars': r.get('stargazers_count'), 'pushed_at': r.get('pushed_at'), 'created_at': r.get('created_at')}
        r = jcache('gh', f'{owner}', lambda: http(f'https://api.github.com/users/{owner}/repos?sort=pushed&per_page=5', min_gap=1), 12 * 3600)
        if isinstance(r, list) and r: return {'org': owner, 'public_repos_sampled': len(r), 'last_push': max(x.get('pushed_at') or '' for x in r), 'top_stars': max(x.get('stargazers_count') or 0 for x in r)}
    except Exception: return None

def upcoming(vu):
    """Scheduled / pre-launch projects: launchedAt in the future (Launch Radar or scheduled), plus 60-Days projects still in their trial."""
    fut = vapi_all('virtuals', {'filters[launchedAt][$gt]': iso(NOW), 'sort[0]': 'launchedAt:asc'}, max_pages=2)
    radar_recent = vapi_all('virtuals', {'filters[launchInfo][launchRadarEnabled][$eq]': 'true', 'filters[createdAt][$gt]': iso(NOW - 14 * 86400), 'sort[0]': 'launchedAt:desc'}, max_pages=1)
    sixty = vapi_all('virtuals', {'filters[launchInfo][isProject60days][$eq]': 'true', 'filters[launchedAt][$gt]': iso(NOW - 60 * 86400), 'sort[0]': 'mcapInVirtual:desc'}, max_pages=1, page_size=30)
    out = []; seen = set()
    for kind, rows in (('scheduled', fut), ('launch_radar', radar_recent), ('60_days_trial', sixty)):
        for v in rows:
            if v['id'] in seen: continue
            seen.add(v['id'])
            full = (vapi(f"virtuals/{v['id']}", ttl=3600) or {}).get('data') or v
            r = launch_row(full, vu, {})
            socials = full.get('socials') or {}
            links = [u for d in (socials.values() if isinstance(socials, dict) else []) if isinstance(d, dict) for u in d.values() if isinstance(u, str)]
            gh = next((github_activity(u) for u in links if 'github.com' in u), None)
            team = team_info(full)
            nm = re.sub(r'\s+by Virtuals$', '', full.get('name') or '').strip()
            news = gnews(f'"{nm}" virtuals', 14) if len(nm) >= 4 else {'items': []}
            nn = len(news.get('items', []))
            t_l = pts(full.get('launchedAt'))
            # anticipation score (0-100): transparent sum of observable signals
            parts = {'launch_radar': 15 if r['modules'].get('radar') else 0, 'verified_by_virtuals': 15 if full.get('isVerified') else 0,
                     'verified_links': min(10, 5 * sum(1 for k in ('twitter', 'website') if r.get(k))), 'team_listed': min(15, 5 * len(team)),
                     'github': 10 if gh and (gh.get('pushed_at') or gh.get('last_push') or '') > iso(NOW - 30 * 86400) else (5 if gh else 0),
                     'news_mentions_14d': min(20, 4 * nn), 'pre_launch_holders': min(15, round(math.log1p(full.get('holderCount') or 0) * 3)),
                     'founder_video': 5 if full.get('showFounderVideo') else 0}
            sc = sum(parts.values())
            if kind == 'scheduled' and (t_l or 0) - NOW > 365 * 86400: continue  # placeholder dates years out
            out.append({**r, 'kind': kind, 'starts_in_h': round((t_l - NOW) / 3600, 1) if t_l and t_l > NOW else None, 'anticipation': sc, 'anticipation_parts': parts,
                        'team': [{'name': m.get('name') or m.get('displayName'), 'role': m.get('role') or m.get('title'), 'x': m.get('twitter') or m.get('xHandle')} for m in team[:6] if isinstance(m, dict)],
                        'github': gh, 'news': news.get('items', [])[:3], 'news_n': nn, 'description': (full.get('description') or '')[:280], 'tokenomics_n': len(full.get('tokenomics') or [])})
    out.sort(key=lambda r: (-(r['kind'] == 'scheduled'), -r['anticipation']))
    junk = [r for r in out if r['kind'] == 'scheduled' and (r.get('holders') or 0) <= 2 and r['anticipation'] < 20]
    return {'items': out[:40], 'n_scheduled': sum(1 for r in out if r['kind'] == 'scheduled'), 'n_scheduled_low_signal': len(junk),
            'note': 'Since Genesis ended (Oct 2025) Virtuals has no pledge window: launches open trading immediately on a bonding curve. "Upcoming" = projects with a future launch time (Launch Radar or scheduled) and live 60-Days trials. Anticipation score adds observable signals only (radar, Virtuals verification, verified links, listed team, GitHub pushes, news mentions, pre-launch holders).'}

# ---------------- Genesis history + current mechanics ----------------
def genesis_history(vu):
    g = vapi_all('geneses', {'sort[0]': 'id:asc'}, max_pages=5)
    st = {}
    for x in g: st[x['status']] = st.get(x['status'], 0) + 1
    fin = [x for x in g if x['status'] == 'FINALIZED']; fail = [x for x in g if x['status'] == 'FAILED']
    tv = [x.get('totalVirtuals') or 0 for x in fin]; tp = [x.get('totalParticipants') or 0 for x in fin]
    # current value of finalized Genesis tokens (Virtuals API mcap)
    cur = []
    for x in fin:
        vid = (x.get('virtual') or {}).get('id')
        if not vid: continue
        try: v = (vapi(f'virtuals/{vid}', ttl=12 * 3600) or {}).get('data') or {}
        except Exception: continue
        m = (v.get('mcapInVirtual') or 0) * vu
        cur.append({'symbol': v.get('symbol'), 'genesis_end': x.get('endsAt'), 'pledged_virtual': round(x.get('totalVirtuals') or 0), 'participants': x.get('totalParticipants'), 'mcap_usd_now': round(m),
                    'pledge_x_vs_42k': round((x.get('totalVirtuals') or 0) / 42000, 2), 'id': vid})
    cur.sort(key=lambda r: -r['mcap_usd_now'])
    mc = [r['mcap_usd_now'] for r in cur]
    dates = sorted(x['endsAt'] for x in fin if x.get('endsAt'))
    return {'counts': st, 'n_total': len(g), 'first_end': dates[0] if dates else None, 'last_end': dates[-1] if dates else None,
            'success_rate': round(len(fin) / max(1, len(fin) + len(fail)), 3),
            'finalized_pledged_virtual': {'median': round(statistics.median(tv)), 'p90': round(pct(tv, .9)), 'max': round(max(tv))} if tv else None,
            'finalized_participants': {'median': round(statistics.median(tp)), 'max': max(tp)} if tp else None,
            'failed_pledged_virtual_median': round(statistics.median([x.get('totalVirtuals') or 0 for x in fail])) if fail else None,
            'oversubscription_vs_42k_median': round(statistics.median(tv) / 42000, 2) if tv else None,
            'reserve_tiers_virtual': (vapi('geneses/parameters', ttl=86400) or {}).get('data', {}).get('reserveAmountTiers'),
            'finalized_now': {'n_priced': len(mc), 'median_mcap_usd': round(statistics.median(mc)) if mc else None, 'n_above_1m': sum(1 for x in mc if x >= 1e6), 'n_above_10m': sum(1 for x in mc if x >= 10e6), 'n_below_100k': sum(1 for x in mc if x < 1e5)},
            'top_now': cur[:12],
            'caveats': 'Pledges above the reserve target were refunded, so "pledged / 42,000" is a demand multiple, not the allocation odds; per-launch reserve tier (21k/42k/100k VIRTUAL) and launch FDV are not exposed by the API, so entry-price returns cannot be computed honestly here. Current mcap uses the Virtuals API value x VIRTUAL/USD.'}

MECHANICS = {
    'as_of': '2026-10 (Virtuals whitepaper, verified this run)',
    'headline': 'There is no pledge or points allocation any more. Genesis (Virgen points + VIRTUAL pledges) ran Apr-Oct 2025 and was sunset; Virgen points were phased out. In 2026 every Virtuals launch opens trading immediately on a public bonding curve: no presale, whitelist or allocation cap.',
    'ways_to_get_in': [
        {'what': 'Buy on the bonding curve at launch', 'how': 'Trade on app.virtuals.io the moment trading opens. If the founder enabled Anti-Sniper Protection, buys pay a tax that starts at 99% and decays to 1% over 0 s / 60 s / 10 min / 98 min (founder choice); tax proceeds buy back the token for the team (3-month cliff, 9-month vesting). Buying in the first minutes of a 98-minute window can cost most of your money in tax.', 'caps': 'none', 'refund': 'none (except 60 Days wind-down)'},
        {'what': 'Stake VIRTUAL for veVIRTUAL (airdrops)', 'how': 'Lock VIRTUAL for up to 2 years; veVIRTUAL decays linearly to 0 at unlock (Auto Max-Lock keeps the full 2-year weight). Launches that turn on the Airdrop Distribution module give up to 5% of supply (50M tokens) to stakers pro-rata to veVIRTUAL.', 'caps': 'pro-rata, only launches with the module on', 'refund': 'locked until unlock date'},
        {'what': 'Growth Allocation (60 Days launches only)', 'how': 'Deposit USDC into the pool at a fixed FDV set by the founder (up to 5% of the team allocation). Oversubscribed pools are pro-rated and unused USDC is refunded. Tokens vest linearly over 6 months if the founder commits.', 'caps': 'pool size set by founder; pro-rata', 'refund': 'full refund if the founder does not commit by day 60'},
        {'what': '60 Days holder refund', 'how': 'If a 60 Days founder walks away, the LP is drained and released ACF funds + the founder\'s 70% fee share + remaining VIRTUAL in the LP go back to eligible holders pro-rata (public-launch buys and airdrops; pre-buy only shares the LP part). Refunds are not guaranteed to be full.', 'caps': '-', 'refund': 'partial, depends on funds left'},
        {'what': 'Hyperboost (after graduation)', 'how': 'Every token graduating after 2026-07-27 releases a reserved reward pool over 14 days: 1/14 per day, split between traders (pro-rata to daily volume) and content about the token.', 'caps': 'daily pool', 'refund': '-'},
        {'what': 'Launch Radar (watch, not allocation)', 'how': 'Founders pay 100 VIRTUAL to list a project before trading opens. It gives visibility only: no reserved allocation.', 'caps': '-', 'refund': '-'},
    ],
    'fees': '1% trading fee from day one: 70% to the creator (locked during a 60 Days trial), 30% to the Virtuals treasury. Graduation at 42,000 VIRTUAL into a Uniswap V2 pool with a 10-year LP lock.',
    'titan': 'Titan launches (established teams) need >= ~$50M valuation and >= $500K USDC-equivalent VIRTUAL liquidity at TGE; first one was Fabric Foundation (Feb 2026).',
    'sources': ['https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/virtuals-launch-mechanics', 'https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/60-days',
                'https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/airdrop-distribution', 'https://whitepaper.virtuals.io/info-hub/usdvirtual-token-base-asset-for-ai-agents/usdvirtual-staking-and-vevirtual',
                'https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/launch-radar', 'https://www.kucoin.com/news/flash/virtuals-protocol-launches-pegasus-unicorn-and-titan-ai-agent-project-launch-mechanisms', 'https://www.bitget.com/news/detail/12560604990467'],
}

# ---------------- protocol comparison ----------------
PROTOS = [  # (name, coingecko id, defillama slug, kind, github repo, thesis weight)
    ('Virtuals Protocol', 'virtual-protocol', 'virtuals-protocol', 'Agent launchpad + agent commerce (Base, Solana, Robinhood, Arc)', 'Virtual-Protocol/acp-cli', 2.0),
    ('Bittensor', 'bittensor', None, 'Decentralized AI network (subnets)', 'opentensor/bittensor', 1.0),
    ('Fetch.ai / ASI', 'fetch-ai', None, 'Agent framework + ASI Alliance token (FET)', 'fetchai/uAgents', 1.0),
    ('SingularityNET (AGIX)', 'singularitynet', None, 'AI marketplace; AGIX merged into ASI (FET), legacy token', 'singnet/snet-daemon', 0.5),
    ('ElizaOS (ex-ai16z)', 'elizaos', None, 'Open-source agent framework (Solana)', 'elizaOS/eliza', 1.0),
    ('Olas', 'autonolas', None, 'Autonomous agent services + staking', 'valory-xyz/open-autonomy', 1.0),
    ('Creator.bid', 'creatorbid', 'creator-bid', 'Agent launchpad (Base/BSC)', None, 1.0),
    ('Clanker', 'tokenbot-2', 'clanker', 'Base/Farcaster token launch bot', None, 1.0),
    ('Bankr', 'bankercoin-2', 'bankr', 'Base AI trading agent + launchpad', None, 1.0),
    ('Holoworld', 'holoworld', None, 'Solana agent studio + HoloLaunch launchpad', None, 1.0),
    ('ARC (Rig)', 'ai-rig-complex', None, 'Rust agent framework (Solana)', '0xPlaygrounds/rig', 1.0),
    ('Griffain', 'griffain', None, 'Solana agent platform', None, 1.0),
    ('Kaito', 'kaito', 'kaito-capital-launchpad', 'InfoFi + Capital Launchpad', None, 1.0),
    ('Zora', 'zora', 'zora-coins', 'Base creator-coin launchpad', None, 0.5),
    ('AWE (STP)', 'stp-network', None, 'Autonomous Worlds Engine (agent worlds)', None, 1.0),
    ('Clawpump', 'clawpump-tech', None, 'Newer agent launchpad (2026)', None, 1.0),
    ('Morpheus', 'morpheusai', 'morpheusai', 'Decentralized AI agent network', None, 1.0),
    ('Venice', 'venice-token', 'venice', 'Private AI inference (VVV), DOT\'s main comparable', None, 0.5),
]
def github_30d(repo):
    if not repo: return None
    def f():
        r = http(f'https://api.github.com/repos/{repo}', min_gap=1)
        c = http(f'https://api.github.com/repos/{repo}/commits?since={iso(NOW - 30 * 86400)}&per_page=100', min_gap=1)
        return {'repo': repo, 'stars': r.get('stargazers_count'), 'pushed_at': r.get('pushed_at'), 'commits_30d': len(c) if isinstance(c, list) else None, 'commits_30d_capped': isinstance(c, list) and len(c) >= 100}
    try: return jcache('gh30', repo, f, 12 * 3600)
    except Exception: return None

def protocols():
    ids = ','.join(p[1] for p in PROTOS)
    mk = cg(f'/coins/markets?vs_currency=usd&ids={ids}&price_change_percentage=24h,7d,30d,1y', ttl=900)
    by = {c['id']: c for c in mk or []}
    rows = []
    for name, cid, slug, kind, repo, w in PROTOS:
        c = by.get(cid) or {}
        ll = llama_protocol(slug) if slug else None
        gh = github_30d(repo)
        rows.append({'name': name, 'cg_id': cid, 'symbol': (c.get('symbol') or '').upper() or None, 'kind': kind, 'price_usd': c.get('current_price'), 'mcap_usd': c.get('market_cap'), 'fdv_usd': c.get('fully_diluted_valuation'),
                     'volume24h_usd': c.get('total_volume'), 'ch24h_pct': c.get('price_change_percentage_24h_in_currency'), 'ch7d_pct': c.get('price_change_percentage_7d_in_currency'), 'ch30d_pct': c.get('price_change_percentage_30d_in_currency'),
                     'ch1y_pct': c.get('price_change_percentage_1y_in_currency'), 'ath_drawdown_pct': c.get('ath_change_percentage'),
                     'fees_30d': (ll or {}).get('fees_30d'), 'revenue_30d': (ll or {}).get('revenue_30d'), 'revenue_trend_pct': (ll or {}).get('revenue_30d_trend_pct'), 'holders_revenue_30d': (ll or {}).get('holders_revenue_30d'),
                     'llama_slug': slug, 'github': gh, 'thesis_weight': w})
    # objective score: rank-percentiles of mcap, 30d change, 30d fees, volume/mcap and dev activity (missing = skipped)
    def pr(vals, x):
        v = [a for a in vals if a is not None]
        return None if x is None or not v else sum(1 for a in v if a <= x) / len(v)
    cols = {'mcap': [r['mcap_usd'] for r in rows], 'ch30': [r['ch30d_pct'] for r in rows], 'fees': [r['fees_30d'] for r in rows],
            'turn': [(r['volume24h_usd'] / r['mcap_usd']) if (r['mcap_usd'] and r['volume24h_usd']) else None for r in rows], 'dev': [((r['github'] or {}).get('commits_30d')) for r in rows]}
    W = {'mcap': .25, 'ch30': .2, 'fees': .3, 'turn': .1, 'dev': .15}
    for i, r in enumerate(rows):
        parts = {k: pr(cols[k], cols[k][i]) for k in W}
        got = {k: v for k, v in parts.items() if v is not None}
        r['objective_score'] = round(100 * sum(W[k] * v for k, v in got.items()) / sum(W[k] for k in got), 1) if got else None
        r['objective_parts'] = {k: (round(v, 2) if v is not None else None) for k, v in parts.items()}
        r['desk_score'] = round(min(100, (r['objective_score'] or 0) * (1 + 0.25 * (r['thesis_weight'] - 1))), 1)
    rows.sort(key=lambda r: -(r['desk_score'] or 0))
    for i, r in enumerate(rows): r['desk_rank'] = i + 1
    for i, r in enumerate(sorted(rows, key=lambda r: -(r['objective_score'] or 0))): r['objective_rank'] = i + 1
    return {'rows': rows, 'method': 'Objective score = weighted percentile ranks inside this peer group: 30d fees/revenue (30%), market cap (25%), 30d price change (20%), GitHub commits in 30d (15%), volume/mcap turnover (10%); missing inputs are skipped. Desk score = objective x (1 + 0.25 x (thesis weight - 1)); Virtuals has thesis weight 2.0 (user thesis), so it is lifted 25%. Both ranks are shown so the tilt is visible.'}

# ---------------- cross-reference with pump detector + narratives ----------------
def crossref(rows):
    def rd(f):
        try: return json.load(open(os.path.join(DATA, f)))
        except Exception: return None
    feed = rd('live_feed.json') or {}; nb = rd('narratives_boost.json') or {}; nar = rd('narratives.json') or {}
    items = {(it.get('key') or '').lower(): it for it in feed.get('items') or []}
    by_sym = {}
    for it in feed.get('items') or []: by_sym.setdefault((it.get('symbol') or '').upper(), []).append(it)
    th = {t['id']: t for t in nar.get('themes') or []}
    ai = th.get('ai_agents') or {}
    theme = {'id': 'ai_agents', 'status': ai.get('status'), 'momentum': ai.get('momentum'), 'crowd': ai.get('crowdLevel'), 'mcap7d_pct': round((ai.get('mcapGrowth7') or 0) * 100, 1) if ai.get('mcapGrowth7') is not None else None,
             'mcap30d_pct': round((ai.get('mcapGrowth30') or 0) * 100, 1) if ai.get('mcapGrowth30') is not None else None, 'breadth7': ai.get('breadth7'), 'launches24': ai.get('launches24'), 'leader7': ai.get('leader7'),
             'news7d': (ai.get('googleNews') or {}).get('n7d'), 'generatedAt': nar.get('generatedAt')}
    hot = theme['status'] in ('emerging', 'heating')
    out = []
    for r in rows:
        ch = r['chain']; a = (r.get('token') or '').lower()
        it = items.get(f'{ch}:{a}') or next((x for x in by_sym.get((r.get('symbol') or '').upper(), []) if (x.get('address') or '').lower() == a), None)
        b = nb.get('byKey', {}).get(f'{ch}:{a}') or nb.get('byAddress', {}).get(a) or nb.get('byAddress', {}).get(r.get('token') or '')
        early = (r.get('age_h') is not None and r['age_h'] < 24) or r.get('status') == 'bonding curve'
        flags = []
        if it and it.get('grade') in ('A', 'B'): flags.append(f"pump detector grade {it['grade']} (score {it.get('score')})")
        if early and hot: flags.append(f"early-launch pattern in a {theme['status']} AI-agents theme")
        if b and (b.get('boost') or 0) > 0: flags.append(f"narrative boost +{b['boost']}")
        out.append({'id': r['id'], 'symbol': r['symbol'], 'chain': ch, 'token': r.get('token'), 'detector': {'grade': it.get('grade'), 'score': it.get('score'), 'risk': it.get('risk'), 'overall': it.get('overall'), 'reasons': (it.get('reasons') or [])[:4], 'veto': it.get('veto')} if it else None,
                    'narrative_boost': b, 'early_pattern': early, 'flags': flags})
    return {'theme': theme, 'rows': out, 'feed_generatedAt': feed.get('generatedAt'), 'feed_chains': feed.get('chains'),
            'note': 'Pump-detector rows come from data/live_feed.json (same grades as the Crypto desk); it only scans tokens it has seen, so most Virtuals curve tokens have no grade. Early-launch pattern = <24 h old or still on the bonding curve.'}

# ---------------- DOT (usedot.xyz) ----------------
DOT = '0x23a2847d772803f9efc64b4277b782b06296fe51'
def dot_tracker():
    st_f = os.path.join(DATA, 'agents_dot_state.json')
    try: st = json.load(open(st_f))
    except Exception: st = {'events': [], 'supply': {}}
    out = {'token': DOT, 'chain': 'base', 'name': 'Dot (usedot.xyz)', 'identity': 'Private/anonymous AI app on Base (no account, no logs; Smart Privacy strips identity before models see prompts; serves Venice-hosted models such as Dolph-24B-Venice). $DOT is a standard ERC-20 on Base, NOT Polkadot and NOT a Virtuals launch; website says Dot buys $DOT with platform revenue and burns it.', 'sources': ['https://usedot.xyz/']}
    ds = http(f'https://api.dexscreener.com/tokens/v1/base/{DOT}') or []
    if ds:
        p = max(ds, key=lambda p: (p.get('liquidity') or {}).get('usd') or 0)
        out['market'] = {'price_usd': float(p['priceUsd']) if p.get('priceUsd') else None, 'mcap_usd': p.get('marketCap'), 'fdv_usd': p.get('fdv'), 'liquidity_usd': (p.get('liquidity') or {}).get('usd'), 'volume24h_usd': (p.get('volume') or {}).get('h24'),
                         'ch': p.get('priceChange'), 'pair': p.get('pairAddress'), 'dex': p.get('dexId'), 'quote': (p.get('quoteToken') or {}).get('symbol'), 'pair_created': iso((p.get('pairCreatedAt') or 0) / 1000), 'url': p.get('url'), 'n_pairs': len(ds)}
    # site watch: staking / burn wording
    try:
        t = text('https://usedot.xyz/'); t2 = re.sub(r'<script.*?</script>|<style.*?</style>', '', t, flags=re.S); t2 = html.unescape(re.sub(r'<[^>]+>', ' ', t2)); t2 = re.sub(r'\s+', ' ', t2)
        out['site'] = {'mentions_staking': bool(re.search(r'\bstak', t2, re.I)), 'mentions_buyback_burn': bool(re.search(r'buys? \$?DOT back|burn', t2, re.I)),
                       'staking_snippets': [t2[max(0, m.start() - 80): m.end() + 80] for m in re.finditer(r'\bstak\w*', t2, re.I)][:3], 'checked_at': iso(NOW)}
    except Exception as e: out['site'] = {'error': str(e)[:120]}
    n = gnews('"usedot" OR "$DOT" private AI Base', 30)
    out['news'] = [i for i in n.get('items', []) if re.search(r'usedot|dot.*(private|privacy|venice|base)', i['title'], re.I)][:5]
    # on-chain: totalSupply and dead-address balance sampled daily since the pool was created (burn detection)
    try:
        start = pts((out.get('market') or {}).get('pair_created')) or (NOW - 30 * 86400)
        day = int(start // 86400) * 86400
        while day < NOW - 3600:
            k = str(day)
            if k not in st['supply']:
                bn = block_at('BASE', day + 86399 if day + 86399 < NOW - 120 else NOW - 300)
                ts_ = rpc('BASE', 'eth_call', [{'to': DOT, 'data': '0x18160ddd'}, hex(bn)])
                dead = rpc('BASE', 'eth_call', [{'to': DOT, 'data': '0x70a08231' + '000000000000000000000000000000000000000000000000000000000000dead'}, hex(bn)])
                zero = rpc('BASE', 'eth_call', [{'to': DOT, 'data': '0x70a08231' + '0' * 64}, hex(bn)])
                st['supply'][k] = [int(ts_, 16) / 1e18 if ts_ and ts_ != '0x' else None, int(dead, 16) / 1e18 if dead and dead != '0x' else 0, int(zero, 16) / 1e18 if zero and zero != '0x' else 0]
            day += 86400
        ks = sorted(st['supply'], key=int)
        burned = []
        for a, b in zip(ks, ks[1:]):
            s0, d0, z0 = st['supply'][a]; s1, d1, z1 = st['supply'][b]
            amt = ((s0 or 0) - (s1 or 0)) + (d1 - d0) + (z1 - z0)
            if amt > 1: burned.append({'day': iso(int(b)), 'burned': round(amt)})
        f0 = st['supply'][ks[0]]; f1 = st['supply'][ks[-1]]
        sup = f0[0] or 1e9
        one_off = [b for b in burned if b['burned'] >= 0.01 * sup]; recur = [b for b in burned if b['burned'] < 0.01 * sup]
        out['burns'] = {'one_off_supply_burns': one_off, 'recurring_burns_total': round(sum(b['burned'] for b in recur)), 'recurring_burns_pct_supply': round(sum(b['burned'] for b in recur) / sup * 100, 3),
                        'n_recurring_burn_days': len(recur), 'first_recurring_burn_day': recur[0]['day'] if recur else None, 'last_recurring_burn_day': recur[-1]['day'] if recur else None,
                        'first_day_sampled': iso(int(ks[0])), 'total_supply_first': f0[0], 'total_supply_now': f1[0], 'dead_balance_now': f1[1], 'zero_balance_now': f1[2], 'burn_days': burned[-30:], 'n_burn_days': len(burned),
                        'first_burn_day': burned[0]['day'] if burned else None, 'method': 'daily archive reads of totalSupply() and balances of 0x…dead and 0x0 (Base); a burn day is any day those show >1 DOT destroyed'}
    except Exception as e: out['burns'] = {'error': str(e)[:200]}
    # price reaction once a mechanism is live (buyburn methodology: forward returns from event day vs ETH benchmark)
    try:
        pair = (out.get('market') or {}).get('pair')
        u = f'https://api.geckoterminal.com/api/v2/networks/base/pools/{pair}/ohlcv/day?limit=180&currency=usd&token={DOT}'
        d = jcache('gt', u + time.strftime('%Y%m%d%H'), lambda: http(u, min_gap=2.3), 3 * 3600)
        ser = sorted((c[0], c[4]) for c in ((d or {}).get('data') or {}).get('attributes', {}).get('ohlcv_list', []))
        out['price_series_days'] = len(ser)
        if ser:
            hi = max(ser, key=lambda x: x[1]); out['ath_close'] = {'usd': hi[1], 'date': iso(hi[0]), 'drawdown_pct': round((ser[-1][1] / hi[1] - 1) * 100, 1)}
            out['ch30d_pct'] = round((ser[-1][1] / ser[-31][1] - 1) * 100, 1) if len(ser) > 31 else None
        ev = (out.get('burns') or {}).get('first_recurring_burn_day')
        if ev and ser:
            et = pts(ev); base_i = max((i for i, x in enumerate(ser) if x[0] <= et), default=None)
            if base_i is not None:
                ch = cg('/coins/ethereum/market_chart?vs_currency=usd&days=200&interval=daily', ttl=6 * 3600); eth = {int(t // 86400000) * 86400: p for t, p in ch.get('prices') or []}
                def fwd(dd):
                    j = base_i + dd
                    if j >= len(ser): return None
                    r = ser[j][1] / ser[base_i][1] - 1
                    e0, e1 = eth.get(int(ser[base_i][0] // 86400) * 86400), eth.get(int(ser[j][0] // 86400) * 86400)
                    return {'dot_pct': round(r * 100, 1), 'eth_pct': round((e1 / e0 - 1) * 100, 1) if e0 and e1 else None, 'excess_pct': round((r - (e1 / e0 - 1)) * 100, 1) if e0 and e1 else None}
                out['reaction_to_first_burn'] = {'event': 'first recurring (revenue-sized, <1% of supply) burn day', 'event_day': ev, '+1d': fwd(1), '+7d': fwd(7), '+30d': fwd(30), 'method': 'research/buyburn style: forward return from the event-day close, minus ETH over the same window'}
    except Exception as e: out['reaction_error'] = str(e)[:160]
    out['staking_status'] = 'announced on site' if (out.get('site') or {}).get('mentions_staking') else 'not mentioned on usedot.xyz as of this check (monitoring)'
    B_ = out.get('burns') or {}
    out['buyburn_status'] = ('live on-chain: %d recurring burn day(s) since %s, %s DOT (%s%% of supply) burned that way; separate one-off supply burns at launch: %s' % (B_['n_recurring_burn_days'], (B_['first_recurring_burn_day'] or '')[:10], f"{B_['recurring_burns_total']:,}", B_['recurring_burns_pct_supply'], ', '.join(f"{b['day'][:10]} {b['burned']:,}" for b in B_['one_off_supply_burns']) or 'none')) if B_.get('n_recurring_burn_days') else 'described on site; no on-chain burn (supply drop or transfers to 0x0/0x…dead) detected in the sampled days'
    json.dump(st, open(st_f, 'w'))
    return out

def main():
    vu = src('virtual_usd', vu_now) or 0
    out = {'generatedAt': int(NOW * 1000), 'virtual_usd': vu}
    out['virtual'] = src('virtual_token', virtual_token)
    out['launchpad'] = src('launchpad', lambda: launchpad(vu))
    out['upcoming'] = src('upcoming', lambda: upcoming(vu))
    out['genesis'] = src('genesis', lambda: genesis_history(vu))
    out['mechanics'] = MECHANICS
    out['protocols'] = src('protocols', protocols)
    rows = ((out.get('launchpad') or {}).get('recent') or []) + ((out.get('launchpad') or {}).get('top_agents') or [])
    out['crossref'] = src('crossref', lambda: crossref(rows))
    out['dot'] = src('dot', dot_tracker)
    out['sources'] = SRC
    out['disclaimer'] = 'Read-only research from public data. Not financial advice. Nothing here trades.'
    save('agents.json', out)
    log('agents.json written', SRC)

if __name__ == '__main__':
    main()
