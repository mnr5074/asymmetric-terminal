#!/usr/bin/env python3
"""Social sentiment collector (free X read tools via the assistant) -> data/sentiment_counts.json + data/sentiment_samples.json.

The terminal server cannot call the X MCP tools, so collection is split in two:
  1. `python3 research/sentiment.py plan [--tiers P,W,C] [--max-calls N]`
       prints/writes research/sentiment/raw/<run>/plan.json: the exact tool calls (namespace 'x') to make, and the file name each
       raw result must be saved as inside that run directory.
  2. the assistant makes those calls (write_to_file=true) and copies each result file to the named path.
  3. `python3 research/sentiment.py ingest research/sentiment/raw/<run>`
       parses the raw results, filters bots, scores language (VADER 3.3.2 + crypto lexicon), fetches 7d hourly prices
       (Binance public klines / GeckoTerminal / CoinGecko, all free), merges into the rolling data files and logs calls used.
  lib/sentiment.js reads the two data files and computes velocity z-scores, the 0-100 oscillator, divergence flags and the
  composite factor. Historical proxy study: research/sentiment/proxy_history.py (`python3 research/sentiment.py history`).
Never uses the paid X API (X_BEARER_TOKEN / lib/xapi.js). See research/sentiment/COLLECTOR.md for formats.
"""
import html, json, math, os, re, sys, time, datetime as dt, urllib.request, urllib.parse
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, 'research', 'sentiment')
DATA = os.path.join(ROOT, 'data')
sys.path.insert(0, os.path.join(HERE, 'vendor'))
F_COUNTS, F_SAMPLES, F_CALLS = (os.path.join(DATA, f) for f in ('sentiment_counts.json', 'sentiment_samples.json', 'sentiment_calls.json'))
KEEP_HOURS = 14 * 24          # hourly counts kept per token (rolling)
KEEP_POST_DAYS = 8            # sampled posts kept per token (rolling)
# refresh cadence in hours (COLLECTOR.md §3): ~230 X reads/day for 26 tokens
CADENCE_H = {'P_counts': 2, 'P_samples': 4, 'counts': 6, 'samples': 12, 'news': 12}
UA = {'user-agent': 'asymmetric-terminal-sentiment/1.0 (research; free public endpoints)'}

def now_ms(): return int(time.time() * 1000)
def iso(ms): return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
def pms(s): return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
def rj(p, d=None):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return d
def wj(p, o):
    tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(o, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, p)
def cfg(): return rj(os.path.join(HERE, 'queries.json'))

# ---------------------------------------------------------------- plan
def plan(args):
    c = cfg(); tiers = set((args.get('tiers') or 'P,W,C').split(',')); maxc = int(args.get('max-calls') or 40)
    samples = args.get('samples', 'auto')  # auto: cadence in CADENCE_H
    run = args.get('run') or dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%MZ')
    S = rj(F_SAMPLES, {}) or {}; C = rj(F_COUNTS, {}) or {}
    t = now_ms(); calls = []
    start24, start7, end_prior = iso(t - 24 * 3600e3 + 120e3), iso(t - 7 * 86400e3 + 300e3), iso(t - 24 * 3600e3)
    syms = set(x.strip().upper() for x in str(args['syms']).split(',')) if args.get('syms') else None
    for tok in c['tokens']:
        if tok['tier'] not in tiers or (syms and tok['sym'] not in syms): continue
        sym = tok['sym']; last_c = (C.get('tokens', {}).get(sym) or {}).get('fetchedAt'); age_c = (t - pms(last_c)) / 3600e3 if last_c else 1e9
        cad = tok.get('cadence_h') or {}   # per-token override, e.g. {"counts": 1, "samples": 1} for an hourly watch
        if age_c >= cad.get('counts', CADENCE_H['P_counts'] if tok['tier'] == 'P' else CADENCE_H['counts']) - 0.1 or args.get('force'):
            calls.append({'file': f'counts__{sym}.txt', 'tool': 'get_posts_counts_recent', 'arguments': {'query': f"{tok['q']} {c['suffix_counts']}", 'granularity': 'hour'}})
        runs = (S.get('tokens', {}).get(sym) or {}).get('runs') or []
        last_s = max([pms(r['fetchedAt']) for r in runs if r.get('window') == '24h'] or [0]); age_s = (t - last_s) / 3600e3
        if samples == 'all' or (samples == 'auto' and age_s >= cad.get('samples', CADENCE_H['P_samples'] if tok['tier'] == 'P' else CADENCE_H['samples']) - 0.1) or args.get('force'):
            base = {'max_results': 25, 'sort_order': 'relevancy', 'expansions': 'author_id', 'post.fields': 'created_at,public_metrics,lang,author_id', 'user.fields': 'public_metrics,created_at,verified,description'}
            calls.append({'file': f'samples__{sym}__24h.txt', 'tool': 'search_posts_all', 'arguments': {**base, 'query': f"{tok['q']} {c['suffix_samples']}", 'start_time': start24}})
            if args.get('force') or not any(r.get('window') == 'prior' and t - pms(r['fetchedAt']) < 24 * 3600e3 for r in runs):  # prior-window baseline at most once a day
                calls.append({'file': f'samples__{sym}__prior.txt', 'tool': 'search_posts_all', 'arguments': {**base, 'query': f"{tok['q']} {c['suffix_samples']}", 'start_time': start7, 'end_time': end_prior}})
        nw = (S.get('tokens', {}).get(sym) or {}).get('news') or {}
        if tok.get('news_q') and tok['tier'] == 'P' and (not nw.get('fetchedAt') or (t - pms(nw['fetchedAt'])) / 3600e3 >= CADENCE_H['news'] - 0.1):
            calls.append({'file': f'news__{sym}.txt', 'tool': 'search_news', 'arguments': {'query': tok['news_q'], 'max_results': 10, 'max_age_hours': 72}})
    pri = {'counts': 0, '24h': 1, 'prior': 2, 'news': 3}
    calls.sort(key=lambda x: pri[x['file'].split('__')[0]] if not x['file'].startswith('samples') else pri[x['file'].split('__')[2][:-4]])
    calls = calls[:maxc]
    d = os.path.join(HERE, 'raw', run); os.makedirs(d, exist_ok=True)
    out = {'run': run, 'createdAt': iso(t), 'namespace': 'x', 'calls': calls, 'n': len(calls), 'howto': 'call each tool with write_to_file=true, copy the result file to <run dir>/<file>, then: python3 research/sentiment.py ingest ' + os.path.relpath(d, ROOT)}
    wj(os.path.join(d, 'plan.json'), out); print(json.dumps({'run_dir': os.path.relpath(d, ROOT), 'n': len(calls), 'files': [x['file'] for x in calls]}))

# ---------------------------------------------------------------- parsing raw tool output
def parse_raw(path):
    s = open(path, encoding='utf-8', errors='replace').read()
    i = s.find('{'); obj = None
    if i >= 0:
        try: obj, _ = json.JSONDecoder().raw_decode(s[i:])
        except Exception: obj = None
    m = re.search(r'(\d+) of (\d+) today', s)
    return obj, (int(m.group(1)) if m else None)

# ---------------------------------------------------------------- language scoring
_SIA = None; _LEX = None
def sia():
    global _SIA, _LEX
    if _SIA is None:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        _LEX = rj(os.path.join(HERE, 'lexicon_crypto.json')); _SIA = SentimentIntensityAnalyzer(); _SIA.lexicon.update(_LEX['words'])
    return _SIA, _LEX
URL_RE = re.compile(r'https?://\S+'); TAG_RE = re.compile(r'[$#]([A-Za-z][A-Za-z0-9_]*)'); HANDLE_RE = re.compile(r'@\w+')
def prep(text):
    _, L = sia(); t = URL_RE.sub(' ', text); t = HANDLE_RE.sub(' ', t); t = TAG_RE.sub(lambda m: m.group(1), t)
    for e, w in L.get('emoji', {}).items(): t = t.replace(e, f' {w} ')
    low = t.lower()
    for p in sorted(L['phrases'], key=len, reverse=True): low = re.sub(r'(?<![a-z])' + re.escape(p) + r'(?![a-z])', ' ' + L['phrases'][p] + ' ', low)
    return low
def score_text(text):
    S, L = sia(); p = prep(text); vs = S.polarity_scores(p)
    hits = sorted({w for w in re.findall(r"[a-z0-9&]+", p) if w in L['words']})
    return round(vs['compound'], 4), hits

SPAM_RE = re.compile(r'giveaway|airdrop|claim (now|your|here)|presale|join (our|my)?\s*(official\s*)?(telegram|discord|tg|community|group|channel)|vip access|t\.me/|whitelist|free mint|dm (me|for)|send me|referral|promo code|bonus code|casino|1000x gem|next 100x|signals? group|vip group', re.I)
def bot_check(post, user, text, cashtags):
    r = []
    pm = (user or {}).get('public_metrics') or {}; fol, fng, tw = pm.get('followers_count', 0), pm.get('following_count', 0), pm.get('tweet_count', 0)
    age_d = None
    if user and user.get('created_at'): age_d = max(0.5, (now_ms() - pms(user['created_at'])) / 864e5)
    if age_d is not None and age_d < 14: r.append('account<14d')
    if fng >= 1000 and fol / max(fng, 1) < 0.05: r.append('follow-farm ratio')
    if age_d and tw / age_d > 200: r.append('>200 posts/day')
    if cashtags >= 5: r.append(f'{cashtags} cashtags (shill list)')
    if SPAM_RE.search(text): r.append('spam/giveaway wording')
    if re.search(r'\d{6,}$', (user or {}).get('username', '')) and fol < 50: r.append('default-handle low-follower')
    return r, fol, fng, tw, age_d
def weight(fol, m):
    eng = (m.get('like_count', 0) + 2 * m.get('retweet_count', 0) + m.get('reply_count', 0) + 2 * m.get('quote_count', 0))
    a = min(3.5, 0.5 + math.log10(1 + fol) / 2)       # 0.5 (0 followers) .. 3.5 (1M followers)
    b = min(2.0, 1 + math.log10(1 + eng) / 2)          # 1 (no engagement) .. 2 (~1000 weighted engagements)
    return round(a * b, 3)
def norm_dup(t): return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]', ' ', HANDLE_RE.sub('', URL_RE.sub('', t.lower())))).strip()[:120]

# ---------------------------------------------------------------- prices (free)
def get(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode())
def fetch_price(tok):
    p = tok.get('price') or {}; errs = []
    tries = []
    if p.get('binance_spot'): tries.append(('binance_spot:' + p['binance_spot'], f"https://data-api.binance.vision/api/v3/klines?symbol={p['binance_spot']}&interval=1h&limit=200"))
    fsym = p.get('binance_fapi') or p.get('binance_spot')
    if fsym: tries.append(('binance_fapi_mirror:' + fsym, f"https://www.binance.com/fapi/v1/klines?symbol={fsym}&interval=1h&limit=200"))
    for src, u in tries:
        try:
            k = get(u)
            if isinstance(k, list) and len(k) > 24: return {'source': src, 'fetchedAt': iso(now_ms()), 'hourly': [[int(x[0]), float(x[4]), float(x[2]), float(x[7])] for x in k]}
        except Exception as e: errs.append(f'{src}: {e}')
    if p.get('geckoterminal_token'):
        net, addr = p['geckoterminal_token'].split(':', 1)
        try:
            pools = get(f'https://api.geckoterminal.com/api/v2/networks/{net}/tokens/{addr}/pools?page=1')['data']
            best = None
            for pl in pools[:3]:  # top pools by GT ranking; keep the one with the longest hourly history (new pools have short history)
                pool = pl['attributes']['address']
                try: o = get(f'https://api.geckoterminal.com/api/v2/networks/{net}/pools/{pool}/ohlcv/hour?aggregate=1&limit=200&currency=usd&token={addr}')
                except Exception: continue
                rows = sorted(o['data']['attributes']['ohlcv_list'])
                if not best or len(rows) > len(best[1]) + 24: best = (pool, rows)
                time.sleep(0.5)
            if best and len(best[1]) > 6: return {'source': f'geckoterminal:{net}:{best[0]}', 'fetchedAt': iso(now_ms()), 'hourly': [[int(r[0]) * 1000, float(r[4]), float(r[2]), float(r[5])] for r in best[1]], 'note': 'hours with no trades are missing'}
        except Exception as e: errs.append(f'geckoterminal: {e}')
    if tok.get('cgId'):
        try:
            j = get(f"https://api.coingecko.com/api/v3/coins/{tok['cgId']}/market_chart?vs_currency=usd&days=7")
            return {'source': 'coingecko:' + tok['cgId'], 'fetchedAt': iso(now_ms()), 'hourly': [[int(a), float(b), None, None] for a, b in j['prices']]}
        except Exception as e: errs.append(f'coingecko: {e}')
    return {'source': None, 'error': '; '.join(errs)[:400], 'hourly': []}

# ---------------------------------------------------------------- ingest
def latest_run_dir():
    """Newest folder in research/sentiment/raw/ (run ids sort by time) that holds raw .txt results; falls back to the newest folder."""
    base = os.path.join(HERE, 'raw')
    runs = sorted((d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))), reverse=True) if os.path.isdir(base) else []
    if not runs: return None
    for d in runs:
        if any(f.endswith('.txt') for f in os.listdir(os.path.join(base, d))): return os.path.join(base, d)
    return os.path.join(base, runs[0])

def ingest(run_dir=None):
    if not run_dir:
        run_dir = latest_run_dir()
        if not run_dir: print('ingest: no run folders in research/sentiment/raw/ (run `plan` first)'); return
        print(f'ingest: no run dir given, using latest: {os.path.relpath(run_dir, ROOT)}')
    run_dir = os.path.join(ROOT, run_dir) if not os.path.isabs(run_dir) else run_dir
    if not os.path.isdir(run_dir): print(f'ingest: {run_dir} is not a directory'); return
    c = cfg(); toks = {t['sym']: t for t in c['tokens']}
    C = rj(F_COUNTS) or {'version': 1, 'tokens': {}}; S = rj(F_SAMPLES) or {'version': 1, 'tokens': {}}; L = rj(F_CALLS) or {'version': 1, 'runs': []}
    files = sorted(f for f in os.listdir(run_dir) if f.endswith('.txt'))
    planq = {x['file']: (x.get('arguments') or {}).get('query') for x in ((rj(os.path.join(run_dir, 'plan.json')) or {}).get('calls') or [])}
    rerun = any(r.get('run') == os.path.basename(run_dir.rstrip('/')) for r in L.get('runs') or [])
    t0 = now_ms(); used = Counter(); left = None; seen_syms = set(); report = []
    for f in files:
        kind, sym, *rest = f[:-4].split('__'); tok = toks.get(sym)
        if not tok: report.append(f'skip {f}: unknown symbol'); continue
        want = f"{tok['q']} {c['suffix_counts'] if kind == 'counts' else c['suffix_samples']}" if kind in ('counts', 'samples') else None
        if want and f in planq and planq[f] != want:   # raw result was fetched with an older query (regime break) -> never merge it under the new query
            report.append(f'skip {f}: fetched with a different query than queries.json now has (query changed since the plan)'); continue
        obj, l = parse_raw(os.path.join(run_dir, f)); left = min(left, l) if (l is not None and left is not None) else (l if l is not None else left); used[kind] += 1
        fetched = iso(int(os.path.getmtime(os.path.join(run_dir, f)) * 1000))
        if obj is None or ('data' not in obj and 'meta' not in obj):
            report.append(f'{f}: no JSON data ({(str(obj) or "")[:120]})'); continue
        seen_syms.add(sym)
        if kind == 'counts':
            rows = [[pms(x['start']), pms(x['end']), int(x['tweet_count'])] for x in obj.get('data') or []]
            if not rows: report.append(f'{f}: empty counts'); continue
            prev = C['tokens'].get(sym) or {}
            q = f"{tok['q']} {c['suffix_counts']}"
            old = (prev.get('hourly') or []) if prev.get('query') == q else []
            breaks = list(prev.get('regimeBreaks') or [])
            if prev.get('query') and prev.get('query') != q:   # query changed: older buckets are a different series -> dropped, break logged
                breaks.append({'at': iso(now_ms()), 'oldQuery': prev['query'][:300], 'droppedBuckets': len(prev.get('hourly') or []), 'reason': (tok.get('regime') or {}).get('reason') or 'query changed'})
            ws = rows[0][0]
            keep = [r for r in old if r[1] <= ws]                 # history strictly before the new 7d window
            ov = [r for r in old if r[0] < ws < r[1]]            # an older full bucket covering the new partial first bucket wins
            newr = rows[1:] if ov else rows
            hourly = sorted(keep + ov[:1] + newr)[-KEEP_HOURS:]
            fetched = iso(rows[-1][1])
            C['tokens'][sym] = {'sym': sym, 'tier': tok['tier'], 'key': tok.get('key'), 'query': q, 'granularity': 'hour', 'fetchedAt': fetched,
                                'windowStart': iso(rows[0][0]), 'windowEnd': iso(rows[-1][1]), 'total7d': int((obj.get('meta') or {}).get('total_tweet_count') or sum(r[2] for r in rows)),
                                'hourly': hourly, 'price': prev.get('price'), 'regimeBreaks': breaks[-5:],
                                'regimeSince': (tok.get('regime') or {}).get('since'), 'regimeReason': (tok.get('regime') or {}).get('reason'), 'provisionalDays': tok.get('provisionalDays'), 'quality': tok.get('quality', 'clean'), 'qualityNote': tok.get('qualityNote')}
            report.append(f'{sym}: counts {len(rows)} buckets, 7d total {C["tokens"][sym]["total7d"]}')
        elif kind == 'samples':
            window = rest[0] if rest else '24h'
            users = {u['id']: u for u in (obj.get('includes') or {}).get('users', [])}
            T = S['tokens'].setdefault(sym, {'sym': sym, 'runs': [], 'posts': []})
            qs = f"{tok['q']} {c['suffix_samples']}"
            if T.get('query') != qs:
                if T.get('query') or (tok.get('regime') and T['posts'] and not T.get('regimeSince')):   # posts sampled with the old query are off-topic -> reset
                    T['regimeBreaks'] = (T.get('regimeBreaks') or []) + [{'at': iso(now_ms()), 'droppedPosts': len(T['posts'])}]
                    T['posts'] = []; T['runs'] = []
                T['query'] = qs; T['regimeSince'] = (tok.get('regime') or {}).get('since')
            have = {p['id'] for p in T['posts']}; dups = Counter(norm_dup(p['text']) for p in T['posts'] if not p.get('bot'))
            per_author = Counter(p.get('author_id') for p in obj.get('data') or [])
            kept = dropped = 0; why = Counter(); fetched_ms = now_ms()
            for p in obj.get('data') or []:
                if p['id'] in have: continue
                u = users.get(p.get('author_id')); text = html.unescape(p.get('text', ''))
                ctags = len(set(m.lower() for m in re.findall(r'\$([A-Za-z][A-Za-z0-9_]{1,14})\b', text)))
                rs, fol, fng, tw, age_d = bot_check(p, u, text, ctags)
                nd = norm_dup(text)
                if nd and dups[nd] >= 1: rs.append('duplicate text')
                dups[nd] += 1
                comp, hits = score_text(text); m = p.get('public_metrics') or {}
                dil = 1.0 / max(1, ctags - 1) if ctags >= 3 else 1.0   # multi-ticker posts are only partly about this token
                w = 0.0 if rs else round(weight(fol, m) * dil / max(1, per_author[p.get('author_id')]), 3)
                T['posts'].append({'id': p['id'], 't': pms(p['created_at']) if p.get('created_at') else None, 'window': window, 'fetchedAt': iso(fetched_ms), 'author_id': p.get('author_id'),
                                   'username': (u or {}).get('username'), 'followers': fol, 'following': fng, 'acct_age_d': round(age_d, 1) if age_d else None, 'verified': (u or {}).get('verified'),
                                   'metrics': {k: m.get(k, 0) for k in ('like_count', 'retweet_count', 'reply_count', 'quote_count', 'impression_count')},
                                   'text': text[:300], 'compound': comp, 'lex_hits': hits, 'weight': w, 'bot': bool(rs), 'botReasons': rs, 'url': p.get('url')})
                if rs: dropped += 1; why.update(rs)
                else: kept += 1
            # author contagion: an author with >= 2 bot-flagged posts in this token's store is treated as a bot for all posts
            badA = Counter(p['author_id'] for p in T['posts'] if p.get('bot') and p.get('author_id'))
            for p in T['posts']:
                if not p.get('bot') and badA.get(p.get('author_id'), 0) >= 2:
                    p['bot'] = True; p['botReasons'] = ['author flagged on other posts']; p['weight'] = 0.0
                    if p.get('fetchedAt') == iso(fetched_ms): kept -= 1; dropped += 1; why['author flagged on other posts'] += 1
            meta = obj.get('meta') or {}
            T['runs'].append({'fetchedAt': iso(fetched_ms), 'window': window, 'returned': meta.get('result_count', len(obj.get('data') or [])), 'kept': kept, 'dropped': dropped, 'dropReasons': dict(why)})
            report.append(f'{sym}: samples[{window}] returned {meta.get("result_count", 0)}, kept {kept}, bot/spam {dropped}')
        elif kind == 'news':
            T = S['tokens'].setdefault(sym, {'sym': sym, 'runs': [], 'posts': []})
            terms = re.findall(r'"([^"]+)"|(\$?)([A-Za-z][A-Za-z0-9]+)', tok['q'])
            kw_ci = [a.lower() for a, d, w in terms if a] + [w.lower() for a, d, w in terms if w and not d and w.upper() != 'OR']
            kw_cs = [w.upper() for a, d, w in terms if w and d] + [sym]      # cashtag words must appear in capitals (NEAR, not 'near')
            def rel(n):
                txt = (n.get('name') or '') + ' ' + (n.get('summary') or '') + ' ' + (n.get('hook') or '')
                return any(re.search(r'(?<![a-z])' + re.escape(k) + r'(?![a-z])', txt.lower()) for k in kw_ci) or any(re.search(r'(?<![A-Za-z])' + re.escape(k) + r'(?![A-Za-z])', txt) for k in kw_cs)
            items = [n for n in (obj.get('data') or []) if rel(n)]
            T['news'] = {'fetchedAt': iso(now_ms()), 'returned': len(obj.get('data') or []), 'relevant': len(items), 'items': [{'id': n.get('id'), 'name': n.get('name'), 'hook': (n.get('hook') or '')[:300], 'summary': (n.get('summary') or '')[:400], 'updated': n.get('updated_at'), 'url': n.get('url'), 'compound': score_text((n.get('name') or '') + '. ' + (n.get('hook') or n.get('summary') or ''))[0]} for n in items][:10]}
            report.append(f'{sym}: news {len(T["news"]["items"])}')
    # prices for every token with fresh counts
    for sym in sorted(seen_syms):
        if sym in C['tokens']:
            pr = fetch_price(toks[sym]); C['tokens'][sym]['price'] = pr
            if not pr.get('hourly'): report.append(f'{sym}: price unavailable ({pr.get("error")})')
    # roll posts
    cut = now_ms() - KEEP_POST_DAYS * 864e5
    for T in S['tokens'].values():
        T['posts'] = [p for p in T['posts'] if (p.get('t') or 0) >= cut]; T['runs'] = T['runs'][-60:]
    stamp = iso(now_ms())
    C.update({'version': 1, 'updatedAt': stamp, 'source': "free X read tools (MCP namespace 'x', get_posts_counts_recent, granularity=hour) collected by the assistant; prices from Binance public klines / GeckoTerminal / CoinGecko", 'spec': 'research/sentiment/COLLECTOR.md'})
    S.update({'version': 1, 'updatedAt': stamp, 'source': "free X read tools (MCP namespace 'x', search_posts_all, 25 posts/call, relevancy order)", 'lexicon': 'VADER 3.3.2 + ' + sia()[1]['version'], 'spec': 'research/sentiment/COLLECTOR.md'})
    wj(F_COUNTS, C); wj(F_SAMPLES, S)
    if rerun: print('note: this run was already ingested; data merged again (idempotent) but calls are not counted twice')
    else: L['runs'].append({'run': os.path.basename(run_dir.rstrip('/')), 'ingestedAt': stamp, 'calls': dict(used), 'total': sum(used.values()), 'xReadsLeftToday': left})
    L['runs'] = L['runs'][-500:]
    day = stamp[:10]; L['today'] = {'date': day, 'calls': sum(r['total'] for r in L['runs'] if r['ingestedAt'][:10] == day)}
    wj(F_CALLS, L)
    print('\n'.join(report)); print(json.dumps({'ingested': len(files), 'calls': dict(used), 'xReadsLeftToday': left}))

def main():
    a = sys.argv[1:]
    if not a: print(__doc__); return
    cmd, rest = a[0], a[1:]
    kv = {}; pos = []
    for i, x in enumerate(rest):
        if x.startswith('--'):
            k = x[2:]; v = rest[i + 1] if i + 1 < len(rest) and not rest[i + 1].startswith('--') else True; kv[k] = v
        elif not (i and rest[i - 1].startswith('--') and kv.get(rest[i - 1][2:]) == x): pos.append(x)
    if cmd == 'plan': plan(kv)
    elif cmd == 'ingest': ingest(pos[0] if pos else None)
    elif cmd == 'score':  # rescore stored posts after a lexicon change
        S = rj(F_SAMPLES)
        for T in S['tokens'].values():
            for p in T['posts']: p['text'] = html.unescape(p['text']); p['compound'], p['lex_hits'] = score_text(p['text'])
        S['lexicon'] = 'VADER 3.3.2 + ' + sia()[1]['version']; wj(F_SAMPLES, S); print('rescored')
    elif cmd == 'history':
        sys.path.insert(0, HERE); import proxy_history; proxy_history.main(kv)
    else: print(__doc__)

if __name__ == '__main__': main()
