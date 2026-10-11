#!/usr/bin/env python3
"""Airdrop / points campaign ranker. Output: data/airdrops.json
Sources (keyless, verified 2026-10-11):
  airdrops.io listing pages /latest/ /hot/ /speculative/ (public HTML: status, heat, published date, actions, official host, KYC flag)
  DefiLlama api.llama.fi/protocols (TVL, tokenless protocols, listing date, official URL)
  DefiLlama defillama.com/raises page data (api.llama.fi/raises now returns 402 "paid plan"; the public page embeds the same list)
Not used: CryptoRank (403 without key), DropsTab (no public API), CoinGecko airdrops page (404).
Participant counts are not available from any free source; airdrops.io "heat" (interest) is used as a crowding proxy.
Grades are heuristic ESTIMATES of allocation potential, not advice. Airdrops are never guaranteed."""
import json, math, os, re, time, html, urllib.request, datetime as dt
from common import DATA_DIR
from calltrack import Tracker

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)'}
def fetch(url, timeout=40):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')
def next_data(h):
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', h, re.S)
    return json.loads(m.group(1))['props']['pageProps'] if m else {}
def norm(s):
    s = (s or '').lower()
    for w in ('finance', 'protocol', 'network', 'labs', 'exchange'): s = s.replace(w, '')
    return re.sub(r'[^a-z0-9]', '', s)

TOP_BACKERS = ['paradigm', 'a16z', 'andreessen', 'polychain', 'coinbase ventures', 'pantera', 'binance labs', 'yzi', 'multicoin', 'dragonfly', 'sequoia', 'founders fund',
               'electric capital', 'framework', 'hack vc', 'delphi', 'jump', 'galaxy', 'variant', 'haun', 'lightspeed', 'robot ventures', 'placeholder', '1kx', 'standard crypto', 'hashed']

def parse_airdrops_io(kind, h):
    out = []
    for m in re.finditer(r'<article id="post-\d+"\s*class="([^"]*)"([^>]*)>(.*?)</article>', h, re.S):
        cls, attrs, body = m.groups()
        if 'airdrop-click' not in cls: continue
        a = dict(re.findall(r'data-([a-z-]+)="([^"]*)"', attrs))
        name = re.search(r'<h3>(.*?)</h3>', body); link = re.search(r'<a href=(https://airdrops\.io/[^ >]+/)>', body)
        status = re.search(r'status-indicator ([a-z-]+)"><span class="status-dot"></span>([^<]+)<', body)
        actions = re.search(r"Actions: <span>(.*?)</span>", body)
        value = re.search(r"Value: <span>(.*?)</span>", body)
        host = re.search(r'data-outbound-host="([^"]+)"', body)
        out.append({'name': html.unescape(name.group(1)).strip() if name else '?', 'page': link.group(1) if link else None, 'kind': kind,
                    'heat': int(a.get('temperature') or 0), 'published': a.get('published', '')[:8], 'kyc': a.get('kyc-required') == '1',
                    'status': (status.group(2).strip() if status else ''), 'actions': html.unescape(actions.group(1)) if actions else '',
                    'est_value': html.unescape(value.group(1)) if value else None, 'official_host': host.group(1) if host else None,
                    'categories': [c.replace('categories-', '') for c in cls.split() if c.startswith('categories-')]})
    return out

def main():
    log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
    status, camps = {}, {}
    for kind in ('latest', 'hot', 'speculative'):
        try:
            xs = parse_airdrops_io(kind, fetch(f'https://airdrops.io/{kind}/')); status[f'airdrops.io/{kind}'] = f'ok ({len(xs)})'
            for x in xs:
                k = norm(x['name'])
                if k in camps:
                    camps[k]['lists'].append(kind); camps[k]['heat'] = max(camps[k]['heat'] or 0, x['heat'])
                    if kind == 'speculative': camps[k]['kind'] = 'speculative'
                else: x['lists'] = [kind]; camps[k] = x
        except Exception as e: status[f'airdrops.io/{kind}'] = f'failed: {e}'
        time.sleep(1)
    try: protos = json.loads(fetch('https://api.llama.fi/protocols')); status['defillama protocols'] = f'ok ({len(protos)})'
    except Exception as e: protos = []; status['defillama protocols'] = f'failed: {e}'
    try: raises = next_data(fetch('https://defillama.com/raises', 60)).get('raises') or []; status['defillama raises (page data)'] = f'ok ({len(raises)})'
    except Exception as e: raises = []; status['defillama raises (page data)'] = f'failed: {e}'
    P = {}
    for p in protos: P.setdefault(norm(p.get('name')), p)
    RZ = {}
    for r in raises: RZ.setdefault(norm(r.get('name')), []).append(r)
    skip_cat = ('CEX', 'Chain', 'Canonical Bridge', 'Risk Curators', 'RWA', 'Liquid Staking', 'Payments', 'Onchain Capital Allocator')
    for p in protos:
        if (p.get('symbol') in (None, '-', '')) and not p.get('gecko_id') and (p.get('tvl') or 0) >= 5e6 and p.get('category') not in skip_cat and norm(p['name']) in RZ:
            k = norm(p['name'])
            if k not in camps:
                camps[k] = {'name': p['name'], 'page': None, 'kind': 'defillama-tokenless', 'lists': ['defillama-tokenless'], 'heat': None, 'published': None, 'kyc': False,
                            'status': 'No token, no announced program', 'actions': '', 'est_value': None, 'official_host': None, 'categories': [p.get('category')]}
    now = time.time(); out = []
    for k, c in camps.items():
        p = P.get(k); rz = RZ.get(k, [])
        raised = sum((r.get('amountUsd') or 0) for r in rz)
        backers = sorted({i for r in rz for i in (r.get('leadInvestors') or []) + (r.get('otherInvestors') or [])})
        top = [b for b in backers if any(t in b.lower() for t in TOP_BACKERS)]
        last_round = max((r.get('date') or 0 for r in rz), default=None)
        valuation = max((r.get('valuationUsd') or 0 for r in rz), default=0) or None
        tvl = (p or {}).get('tvl'); listed = (p or {}).get('listedAt')
        has_token = bool(p and (p.get('symbol') not in (None, '-', '') or p.get('gecko_id')))
        st = (c.get('status') or '').lower()
        claim_live = any(w in st for w in ('claim', 'ended', 'distribut', 'expired'))
        pub = dt.datetime.strptime(c['published'], '%Y%m%d').timestamp() if c.get('published') else None
        first_raise = min((r.get('date') or now for r in rz), default=None)
        first_seen = min([t for t in (pub, listed, first_raise) if t] or [now])
        age_d = (now - first_seen) / 86400
        s_tok = 0.0 if has_token else 1.0
        s_fund = min(1.0, max(0.0, math.log10(max(raised, 1) / 1e6) / 2)) if raised else 0.0
        s_early = max(0.0, 1 - age_d / 365)
        s_crowd = max(0.0, 1 - (c['heat'] if c['heat'] is not None else 60) / 150)
        s_dil = max(0.0, min(1.0, 1 - math.log10(max(tvl, 1e5) / 1e6) / 3)) if tvl else 0.5
        score = 25 * s_tok + 20 * s_fund + 20 * s_early + 15 * s_crowd + 10 * s_dil + (5 if top else 0) + (5 if c['kind'] == 'speculative' else 0)
        reasons = ['no token yet' if not has_token else f"token already exists ({(p or {}).get('symbol')}): any new drop is a later season"]
        reasons.append((f'raised ${raised / 1e6:.1f}M in {len(rz)} round(s)' + (f'; backers incl. {", ".join(top[:3])}' if top else '')) if raised else 'no disclosed funding')
        reasons.append(f'first seen {age_d:.0f}d ago' + (' (early)' if age_d < 60 else ' (mature: many farmers already in)' if age_d > 180 else ''))
        if c['heat'] is not None: reasons.append(f"airdrops.io heat {c['heat']}°" + (' (crowded)' if c['heat'] >= 100 else ' (quiet)' if c['heat'] < 50 else ''))
        if tvl: reasons.append(f'TVL ${tvl / 1e6:.1f}M' + (' (large capital base: heavier dilution of capital-weighted points)' if tvl > 3e8 else ''))
        if c['kyc']: score -= 5; reasons.append('KYC required')
        if claim_live: score -= 35; reasons.append('claim live / distribution done: farming window likely over')
        if 'tge' in st: score -= 15; reasons.append('TGE announced: late')
        score = max(0.0, min(100.0, score))
        if not raised and not (tvl and tvl >= 1e6) and score > 54.9:
            score = 54.9; reasons.append('capped at C: unverified project (no disclosed funding and under $1M TVL), high risk the drop is worth little or never happens')
        g = 'A' if score >= 70 else 'B' if score >= 55 else 'C' if score >= 40 else 'D' if score >= 25 else 'F'
        official = (p or {}).get('url') or (f"https://{c['official_host']}" if c.get('official_host') else None)
        out.append({**c, 'key': k, 'grade': g, 'score': round(score, 1), 'reasons': reasons, 'has_token': has_token, 'claim_live': claim_live,
                    'raised_usd': raised or None, 'valuation_usd': valuation, 'backers': backers[:12], 'top_backers': top, 'last_round': last_round,
                    'tvl': tvl, 'tvl_change_7d': (p or {}).get('change_7d'), 'category': (p or {}).get('category') or (c['categories'][0] if c['categories'] else None),
                    'chains': (p or {}).get('chains') or [], 'defillama': f"https://defillama.com/protocol/{p['slug']}" if p and p.get('slug') else None,
                    'official_url': official, 'twitter': (p or {}).get('twitter'), 'age_days': round(age_d), 'participants_est': None, 'tvl_per_user': None,
                    'parts': {'no_token': s_tok, 'funding': round(s_fund, 2), 'early': round(s_early, 2), 'uncrowded': round(s_crowd, 2), 'low_dilution': round(s_dil, 2)}})
    out.sort(key=lambda x: -x['score'])
    # call log: 'value' = 1 while farming; outcome tracked as token launch (has_token / claim live) after the call
    tr = Tracker('airdrops')
    for x in out:
        tr.log(x['key'], x['grade'], x['score'], 1.0, x['name'], {'raised': x['raised_usd'], 'tvl': x['tvl'], 'heat': x['heat'], 'age_days': x['age_days']}, x.get('page') or x.get('official_url'))
        for c in tr.calls:
            if c['key'] == x['key'] and (x['has_token'] or x['claim_live']) and not c.get('outcome'): c['outcome'] = {'t': int(time.time()), 'event': 'token/claim live', 'grade_at_call': c['grade']}
    tr.save()
    res = {'generatedAt': int(now * 1000), 'count': len(out), 'sources': status, 'campaigns': out,
           'grade_formula': 'Score 0-100 = 25*no-token + 20*funding (log10 $ raised: $1M=0, $100M+=1) + 20*early-ness (1 - days since first seen/365; first seen = earliest of airdrops.io listing, DefiLlama listing, first funding round) + 15*uncrowded (1 - airdrops.io heat/150) + 10*low dilution (TVL $1M=1 ... $1B=0) + 5 top-tier backer + 5 speculative (no confirmed program yet); capped at C without disclosed funding or $1M TVL; -5 KYC, -15 TGE announced, -35 claim live/ended. A>=70, B>=55, C>=40, D>=25, else F.',
           'limits': ['No free source publishes participant counts or points totals, so TVL per user cannot be computed; airdrops.io heat (interest) is the crowding proxy.',
                      'DefiLlama /raises API is now paid (HTTP 402); funding comes from the public defillama.com/raises page data, matched by project name (can miss or mismatch).',
                      'airdrops.io includes low-quality and sponsored campaigns. Always verify the official site and contract addresses yourself.',
                      'Grades estimate allocation potential from public signals only. Airdrops can be cancelled, delayed, sybil-filtered or worth nothing.']}
    with open(os.path.join(DATA_DIR, 'airdrops.json'), 'w') as f: json.dump(res, f)
    log('done', len(out), status)
    for x in out[:15]: log(x['grade'], x['score'], x['name'], x['kind'], x['status'], x['raised_usd'], x['tvl'], x['heat'], x['age_days'])

if __name__ == '__main__': main()
