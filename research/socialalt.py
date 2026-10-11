#!/usr/bin/env python3
"""Non-X sentiment / rumor channel (free, no login, no paid X API, no Nansen).
Sources
  Reddit      - reddit.com JSON is 403-blocked from this host, so posts/comments come from the free Arctic Shift Reddit archive
                (arctic-shift.photon-reddit.com; same post objects, ingested within minutes; scores are frozen at ingestion, so
                "score velocity" = comments + score at ingest per hour, mention velocity = posts/comments per hour).
  Telegram    - public channel web previews t.me/s/<channel> (curated news / alpha / exchange-announcement channels).
  Discord     - ONLY public invite metadata (discord.com/api/v9/invites/<code>?with_counts=true: members, online) tracked over runs.
                Message content needs a bot inside the server (not done without approval).
  Governance  - Discourse JSON (/latest.json) for NEAR, Zcash, Uniswap, Aave, Arbitrum, Optimism, Jupiter, Lido, ENS, Compound;
                Snapshot GraphQL (hub.snapshot.org) proposals; Tally needs an API key (skipped).
  GitHub      - issue search (unauthenticated, 10 req/min) for exploit/hack/airdrop/TGE/delist words in major crypto orgs.
Extraction: cashtags + known token names/symbols (CoinGecko catalog + live feed on disk), event keywords, Narratives themes.
Velocity: mentions in the last 24h vs the prior 72h (per-day rate). Rumor = entity + event keyword in >= 2 independent
sources/channels inside 24h, or a mention spike with an event keyword.
Output: data/socialalt.json (+ data/socialalt_history.json for Discord counts and per-run totals)."""
import html, json, math, os, re, sys, time, urllib.request, urllib.parse
from collections import Counter, defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import patterns_common as pc
from patterns_common import http, log, DATA_DIR
from narratives_taxonomy import THEMES

pc.GAPS.update({'arctic-shift.photon-reddit.com': 1.1, 't.me': 1.6, 'discord.com': 1.5, 'hub.snapshot.org': 0.5, 'api.github.com': 6.5})
NOW = time.time(); H24, H96 = NOW - 86400, NOW - 4 * 86400
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
STATUS = {}

def raw(url, timeout=25):
    host = pc._host(url); pc._throttle(host); pc.COUNTS[host] = pc.COUNTS.get(host, 0) + 1
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/json'})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r: return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and i < 2: time.sleep(4 * (i + 1)); continue
            raise
        except Exception:
            if i < 2: time.sleep(3); continue
            raise

# ---------------- collectors -> docs: {src, ch, t, text, w (engagement), url} ----------------
REDDIT_CORE = ['CryptoCurrency', 'solana', 'CryptoMoonShots', 'ethfinance']
REDDIT_COIN = ['ethtrader', 'CryptoMarkets', 'zec', 'Monero', 'Bitcoin', 'ethereum', 'XRP', 'dogecoin', 'SUI', 'cardano', 'Chainlink', 'NEARProtocol', 'memecoins', 'defi', 'altcoin']
def reddit():
    docs = []; per = {}
    for sub in REDDIT_CORE + REDDIT_COIN:
        n = 0; before = None
        for page in range(6 if sub in REDDIT_CORE else 3):
            u = f'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit={sub}&limit=100&sort=desc' + (f'&before={int(before)}' if before else '')
            j = None
            for attempt in range(3):   # Arctic Shift returns transient 422/5xx under load
                try: j = http(u); break
                except Exception as e: err = e; time.sleep(3 + 4 * attempt)
            if j is None: per[sub] = f'error after {n} docs: ' + str(err)[:50]; break
            d = (j or {}).get('data') or []
            for x in d:
                if x.get('created_utc', 0) < H96: continue
                docs.append({'src': 'reddit', 'ch': 'r/' + sub, 't': x['created_utc'], 'text': (x.get('title') or '') + ' \n' + (x.get('selftext') or '')[:1500],
                             'w': 1 + (x.get('num_comments') or 0) + max(0, x.get('score') or 0), 'url': 'https://reddit.com' + (x.get('permalink') or ''), 'title': x.get('title'), 'author': x.get('author')})
                n += 1
            if len(d) < 100 or d[-1]['created_utc'] < H96: break
            before = d[-1]['created_utc']
        if sub in REDDIT_CORE:   # comments, last 24h (mention depth)
            before = None
            for page in range(4):
                u = f'https://arctic-shift.photon-reddit.com/api/comments/search?subreddit={sub}&limit=100&sort=desc' + (f'&before={int(before)}' if before else '')
                try: j = http(u)
                except Exception: break
                d = (j or {}).get('data') or []
                for x in d:
                    if x.get('created_utc', 0) < H24: continue
                    docs.append({'src': 'reddit_c', 'ch': 'r/' + sub, 't': x['created_utc'], 'text': (x.get('body') or '')[:800], 'w': 1, 'url': 'https://reddit.com' + (x.get('permalink') or ''), 'author': x.get('author')})
                    n += 1
                if len(d) < 100 or d[-1]['created_utc'] < H24: break
                before = d[-1]['created_utc']
        per.setdefault(sub, n)
    STATUS['reddit'] = {'via': 'arctic-shift.photon-reddit.com (reddit.com JSON returns 403 from this host)', 'docs': len(docs), 'perSub': per}
    return docs

TG = ['WatcherGuru', 'cointelegraph', 'whale_alert_io', 'wublockchainenglish', 'BWEnews', 'unfolded', 'spotonchain', 'investigations',
      'glassnode', 'cryptoquant_official', 'defillama_news', 'icodrops', 'airdropinspector', 'DeFiMillion',
      'binance_announcements', 'OKXAnnouncements', 'Bybit_Announcements', 'bitget_announcements', 'MEXCofficialNews', 'CoinMarketCapAnnouncements']
MSG_RE = re.compile(r'data-post="([^"]+)".*?(?:<div class="tgme_widget_message_text[^>]*>(.*?)</div>)?.*?<span class="tgme_widget_message_views">([^<]*)</span>.*?<time datetime="([^"]+)"', re.S)
def kn(s):
    s = (s or '').strip().upper(); m = 1e3 if s.endswith('K') else 1e6 if s.endswith('M') else 1
    try: return float(s.rstrip('KM')) * m
    except Exception: return 0
def telegram():
    docs = []; per = {}
    for c in TG:
        before = None; n = 0; subs = None
        for page in range(4):
            try: s = raw(f'https://t.me/s/{c}' + (f'?before={before}' if before else ''))
            except Exception as e: per[c] = 'error ' + str(e)[:50]; break
            if subs is None:
                m = re.search(r'counter_value">([^<]+)</span> <span class="counter_type">subscribers', s); subs = kn(m.group(1)) if m else None
            ms = []
            for blk in s.split('data-post="')[1:]:
                p = blk.split('"', 1)[0]
                mt = re.search(r'<div class="tgme_widget_message_text[^>]*>(.*?)</div>', blk, re.S)
                mv = re.search(r'tgme_widget_message_views">([^<]*)<', blk); md = re.search(r'<time datetime="([^"]+)"', blk)
                if md: ms.append((p, mt.group(1) if mt else '', mv.group(1) if mv else '', md.group(1)))
            if not ms: break
            oldest = None
            for p, t, v, d in ms:
                ts = time.mktime(time.strptime(d[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone
                oldest = ts if oldest is None else min(oldest, ts)
                if ts < H96 or not t: continue
                txt = re.sub(r'<br\s*/?>', '\n', t); txt = html.unescape(re.sub(r'<[^>]+>', ' ', txt))
                docs.append({'src': 'telegram', 'ch': 't.me/' + c, 't': ts, 'text': txt[:1500], 'w': 1 + kn(v) / 1e4, 'url': 'https://t.me/' + p, 'views': kn(v)}); n += 1
            ids = [int(p.split('/')[-1]) for p, *_ in ms if p.split('/')[-1].isdigit()]
            if not ids or (oldest and oldest < H96): break
            before = min(ids)
        per[c] = per.get(c, n) if isinstance(per.get(c), str) else {'msgs96h': n, 'subscribers': subs}
    STATUS['telegram'] = {'channels': len(TG), 'docs': len(docs), 'perChannel': per}
    return docs

DISCORD = {'jup': 'Jupiter', 'hyperliquid': 'Hyperliquid', 'solana': 'Solana', 'uniswap': 'Uniswap', 'aave': 'Aave', 'arbitrum': 'Arbitrum', 'optimism': 'Optimism',
           'zcash': 'Zcash', 'derive': 'Derive', 'eigenlayer': 'EigenLayer', 'monad': 'Monad', 'berachain': 'Berachain', 'meteora': 'Meteora'}
def discord(hist):
    out = []
    for code, name in DISCORD.items():
        try: j = http(f'https://discord.com/api/v9/invites/{code}?with_counts=true')
        except Exception as e: out.append({'code': code, 'name': name, 'error': str(e)[:60]}); continue
        if not j or not j.get('guild'): out.append({'code': code, 'name': name, 'error': 'invite not found/expired'}); continue
        g = j['guild']; m, p = j.get('approximate_member_count'), j.get('approximate_presence_count')
        hh = hist.setdefault('discord', {}).setdefault(code, [])
        prev = next((x for x in reversed(hh) if NOW - x['t'] >= 20 * 3600), None)
        hh.append({'t': NOW, 'm': m, 'p': p}); del hh[:-60]
        out.append({'code': code, 'name': g.get('name'), 'members': m, 'online': p, 'onlinePct': round(p / m * 100, 2) if m and p else None,
                    'membersD24': (m - prev['m']) if prev and m and prev.get('m') else None, 'onlineD24Pct': round((p / prev['p'] - 1) * 100, 1) if prev and p and prev.get('p') else None,
                    'description': (g.get('description') or '')[:160]})
    STATUS['discord'] = {'servers': len(out), 'note': 'invite metadata only (member + online counts); message content needs a bot in the server, not done without approval'}
    return out

FORUMS = {'NEAR': 'https://gov.near.org', 'Zcash': 'https://forum.zcashcommunity.com', 'Uniswap': 'https://gov.uniswap.org', 'Aave': 'https://governance.aave.com',
          'Arbitrum': 'https://forum.arbitrum.foundation', 'Optimism': 'https://gov.optimism.io', 'Jupiter': 'https://discuss.jup.ag', 'Lido': 'https://research.lido.fi',
          'ENS': 'https://discuss.ens.domains', 'Compound': 'https://www.comp.xyz', 'Polygon': 'https://forum.polygon.technology', 'Gnosis': 'https://forum.gnosis.io'}
def discourse():
    docs, topics = [], []
    per = {}
    for name, base in FORUMS.items():
        try: j = http(base + '/latest.json?order=activity')
        except Exception as e: per[name] = 'error ' + str(e)[:60]; continue
        ts = ((j or {}).get('topic_list') or {}).get('topics') or []
        n = 0
        for t in ts:
            c = t.get('created_at') or ''; la = t.get('last_posted_at') or c
            ct = time.mktime(time.strptime(c[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone if c else 0
            lt = time.mktime(time.strptime(la[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone if la else 0
            if lt < NOW - 7 * 86400: continue
            age_h = max(1, (NOW - ct) / 3600)
            rec = {'forum': name, 'title': t.get('title'), 'createdH': round((NOW - ct) / 3600, 1), 'lastPostH': round((NOW - lt) / 3600, 1), 'posts': t.get('posts_count'), 'views': t.get('views'),
                   'likes': t.get('like_count'), 'postsPerDay': round((t.get('posts_count') or 0) / age_h * 24, 2), 'url': f"{base}/t/{t.get('slug')}/{t.get('id')}"}
            topics.append(rec); n += 1
            docs.append({'src': 'forum', 'ch': 'forum/' + name, 't': max(ct, lt) if ct >= H96 or lt >= H24 else ct, 'text': (t.get('title') or '') + ' ' + name, 'w': 1 + (t.get('posts_count') or 0), 'url': rec['url'], 'title': t.get('title')})
        per[name] = n
    STATUS['discourse'] = {'forums': per, 'note': 'Hyperliquid and Derive have no public Discourse forum (Discord only)'}
    return docs, topics

SNAP_SPACES = ['uniswapgovernance.eth', 'aavedao.eth', 'arbitrumfoundation.eth', 'opcollective.eth', 'lido-snapshot.eth', 'ens.eth', 'jupiterdao.eth', 'gmx.eth', 'balancer.eth', 'curve.eth',
               'safe.eth', 'stgdao.eth', 'cow.eth', 'aurafinance.eth', 'shutterdao0x36.eth', 'gitcoindao.eth', 'apecoin.eth', 'sushigov.eth', 'frax.eth', 'pancake']
def snapshot():
    q = '{proposals(first:60, where:{created_gte:%d}, orderBy:"scores_total", orderDirection:desc){id title state created end scores_total votes space{id name}}}' % int(NOW - 7 * 86400)
    q2 = '{proposals(first:60, where:{space_in:%s, created_gte:%d}, orderBy:"created", orderDirection:desc){id title state created end scores_total votes space{id name}}}' % (json.dumps(SNAP_SPACES), int(NOW - 14 * 86400))
    out = {}
    for qq in (q, q2):
        try: j = http('https://hub.snapshot.org/graphql', {'query': qq})
        except Exception as e: STATUS['snapshot'] = 'error ' + str(e)[:80]; continue
        for p in ((j or {}).get('data') or {}).get('proposals') or []:
            out[p['id']] = {'space': p['space']['id'], 'spaceName': p['space'].get('name'), 'title': p['title'], 'state': p['state'], 'createdH': round((NOW - p['created']) / 3600, 1),
                            'votes': p['votes'], 'scoresTotal': round(p.get('scores_total') or 0), 'url': f"https://snapshot.box/#/s:{p['space']['id']}/proposal/{p['id']}"}
    items = sorted(out.values(), key=lambda x: -(x['votes'] or 0))
    STATUS.setdefault('snapshot', {'proposals': len(items)})
    docs = [{'src': 'snapshot', 'ch': 'snapshot/' + p['space'], 't': NOW - p['createdH'] * 3600, 'text': p['title'] + ' ' + (p['spaceName'] or ''), 'w': 1 + math.log1p(p['votes'] or 0), 'url': p['url'], 'title': p['title']} for p in items]
    return docs, items

GH_ORGS = ['solana-labs', 'anza-xyz', 'jup-ag', 'Uniswap', 'aave', 'OffchainLabs', 'ethereum-optimism', 'near', 'zcash', 'hyperliquid-dex', 'base', 'ethereum', 'raydium-io', 'pump-fun', 'coral-xyz', 'MetaMask', 'LedgerHQ', 'paradigmxyz']
GH_TERMS = ['exploit OR hack OR drained OR vulnerability OR compromised', 'airdrop OR TGE OR "token launch" OR snapshot', 'delist OR deprecate OR sunset OR migration', 'unlock OR vesting OR ETF OR partnership']
def github():
    docs, items = [], []
    since = time.strftime('%Y-%m-%d', time.gmtime(NOW - 4 * 86400))
    orgs = ' '.join('org:' + o for o in GH_ORGS)
    for terms in GH_TERMS:
        q = f'{terms} in:title {orgs} created:>={since}'
        try: j = http('https://api.github.com/search/issues?per_page=50&sort=created&q=' + urllib.parse.quote(q), headers={'Accept': 'application/vnd.github+json'})
        except Exception as e: STATUS.setdefault('githubErrors', []).append(str(e)[:80]); continue
        for it in (j or {}).get('items') or []:
            ct = time.mktime(time.strptime(it['created_at'][:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone
            repo = it['repository_url'].split('/repos/')[-1]
            rec = {'repo': repo, 'title': it['title'], 'createdH': round((NOW - ct) / 3600, 1), 'comments': it.get('comments'), 'url': it['html_url'], 'state': it['state'], 'pr': 'pull_request' in it}
            items.append(rec)
            docs.append({'src': 'github', 'ch': 'github/' + repo.split('/')[0], 't': ct, 'text': it['title'] + ' ' + (it.get('body') or '')[:600] + ' ' + repo, 'w': 1 + (it.get('comments') or 0), 'url': it['html_url'], 'title': it['title']})
    STATUS['github'] = {'issues': len(items), 'queries': len(GH_TERMS), 'note': 'unauthenticated search API (10 req/min); scoped to major crypto orgs to avoid noise'}
    return docs, items

# ---------------- extraction ----------------
EVENTS = {'airdrop': r'airdrops?|claim(?:ing)? (?:is )?live|points program|snapshot (?:taken|date)', 'tge': r'\btge\b|token generation|token launch|launch(?:es|ing)? (?:its|a) token',
          'hack': r'\bhack(?:ed|er|s)?\b|drained|stolen funds|funds (?:were )?stolen|compromised|attacker', 'exploit': r'exploit(?:ed|s)?|vulnerabilit(?:y|ies)|re-?entrancy|bug bounty|security incident',
          'delist': r'delist(?:ing|ed|s)?|will remove .{0,20}trading|suspend(?:s|ed)? (?:trading|deposits|withdrawals)', 'listing': r'will list|lists? .{0,25}(?:spot|perpetual|futures)|new listing|listing:',
          'partnership': r'partner(?:ship|s|ed)? with|teams? up with|collaborat(?:ion|es) with|integrat(?:ion|es) with', 'etf': r'\betfs?\b|spot (?:etf|fund)|s-1 filing|19b-4',
          'unlock': r'(?:token )?unlocks?\b|vesting|cliff', 'rug': r'\brug(?:ged|pull)?\b|exit scam', 'regulatory': r'\bsec\b|lawsuit|subpoena|indict|charged|cftc|doj'}
EV_RE = {k: re.compile(v, re.I) for k, v in EVENTS.items()}
STOP = set('''THE AND FOR YOU ARE NOT BUT ALL ANY CAN HAS HAD WAS ONE OUT NEW NOW GET GOT USE WHO WHY HOW ITS LOL IMO ATH CEO SEC ETF USA API APP DAO NFT CEX DEX TVL APY APR KYC FUD DCA OTC
TLDR EDIT USD EUR GBP JPY CNY UTC GMT PNL ROI ICO IDO IEO TGE AMA FAQ PSA IRS FBI DOJ CPI GDP FED FOMC GOOD WOULD TIME PLAY HOLD OPEN FORM ENJOY JUST MOVE SAFE HIGH MAGIC LOOKS BLUR PEOPLE EDGE SUN GAS
FREE LOVE BEST REAL TRUE MORE MOST WHAT WHEN THIS THAT WITH FROM HAVE WILL YOUR THEY BEEN WERE SOME LIKE THEN THAN INTO ONLY ALSO BACK OVER EVEN MUCH MANY SUCH VERY WELL LONG SHORT BUY SELL PUMP DUMP
MOON HODL WAGMI NGMI GM GN DYOR NFA LFG RIP OMG WTF BTW IIRC AFAIK YES NO OK TOP LOW BIG BAD HOT NEXT LAST FIRST SEND STOP WAIT HELP NEED WANT KNOW THINK MAKE TAKE GIVE KEEP FIND CALL WORK LIFE
HOME LIVE CASH COIN TOKEN CHAIN BASE CORE PEPE DOGE PUMP AUTO BOT DEV MEME AGI LLM GPU CPU RWA DEFI GAME META SOUL ROSE OPTIMISM HEX XYZ'''.split()) - {'PEPE', 'DOGE'}
COMMON_NAMES = set('''good time play hold open form enjoy just move safe high magic looks blur people edge sun gas free love best real true more most what when this that with from have will your they been
were some like then than into only also back over even much many such very well long short moon life home live cash coin token chain base core book world star space power energy origin story render
hyper jupiter celestia mantra sonic flow spark wave pixel echo nova alpha beta gamma delta omega apex zero prime frontier aurora phoenix titan atlas orbit pulse quant dash ethena maker sky'''.split()) - {'jupiter', 'ethena', 'render', 'celestia', 'dash'}
def load_dict():
    """Two dictionaries from files already on disk: MAJOR (mcap >= $300M or hard-coded) may match as bare UPPERCASE words or names;
    everything else (catalog, live feed) only matches as a $cashtag."""
    names, syms = {}, {}
    def addn(name, sym):
        n = (name or '').strip().lower()
        if len(n) >= 4 and not n.isdigit() and n not in COMMON_NAMES: names[n] = sym
    def adds(sym):
        if sym and 2 <= len(sym) <= 10 and sym.isalnum() and sym.upper() not in STOP: syms[sym.upper()] = sym.upper()
    d = os.path.join(DATA_DIR, 'narratives_cache')
    for f in (os.listdir(d) if os.path.isdir(d) else []):
        if not f.startswith('cg_cat_'): continue
        try:
            for c in json.load(open(os.path.join(d, f))):
                if isinstance(c, dict) and c.get('symbol') and (c.get('market_cap') or 0) >= 3e8: adds(c['symbol']); addn(c.get('name'), c['symbol'].upper())
        except Exception: pass
    for s, n in {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'ZEC': 'zcash', 'XMR': 'monero', 'HYPE': 'hyperliquid', 'JUP': 'jupiter', 'UNI': 'uniswap', 'AAVE': 'aave', 'ARB': 'arbitrum',
                 'OP': 'optimism', 'NEAR': 'near protocol', 'XRP': 'ripple', 'DOGE': 'dogecoin', 'BNB': 'binance coin', 'SUI': 'sui network', 'LINK': 'chainlink', 'ADA': 'cardano', 'TAO': 'bittensor', 'PUMP': 'pump.fun',
                 'ENA': 'ethena', 'TRUMP': 'official trump', 'WLD': 'worldcoin', 'ONDO': 'ondo finance', 'DRV': 'derive', 'BONK': 'bonk', 'WIF': 'dogwifhat', 'PENGU': 'pudgy penguins', 'VIRTUAL': 'virtuals protocol',
                 'LTC': 'litecoin', 'DOT': 'polkadot', 'AVAX': 'avalanche', 'TRX': 'tron', 'TON': 'toncoin', 'XLM': 'stellar', 'HBAR': 'hedera', 'PEPE': 'pepe', 'SHIB': 'shiba inu', 'ATOM': 'cosmos', 'APT': 'aptos',
                 'INJ': 'injective', 'TIA': 'celestia', 'SEI': 'sei network', 'KAS': 'kaspa', 'FET': 'fetch.ai', 'RNDR': 'render network', 'POL': 'polygon', 'MNT': 'mantle', 'STRK': 'starknet', 'ZK': 'zksync', 'LDO': 'lido',
                 'ENS': 'ens domains', 'CRV': 'curve finance', 'GMX': 'gmx', 'PYTH': 'pyth network', 'JTO': 'jito', 'RAY': 'raydium', 'W': 'wormhole', 'DASH': 'dash', 'MON': 'monad', 'BERA': 'berachain'}.items():
        names[n] = s
        if s not in STOP: syms[s] = s
    for w in list(names):
        if w in {'crypto', 'token', 'coin', 'chain', 'swap', 'finance', 'protocol', 'network', 'money', 'market', 'trade', 'world', 'staking', 'bridge', 'wallet', 'meme', 'base', 'gold', 'dollar', 'tether', 'usd coin'}: names.pop(w)
    return names, syms

PUMP_RE = re.compile(r'join (?:our |the )?vip|buy before the pump|pump (?:starts|happens|signal)|min(?:utes)? to .{0,20}pump|new launch .{0,40}t\.me/|pump group|guaranteed (?:profit|x)', re.I)
def extract(docs):
    names, syms = load_dict()
    name_re = re.compile(r'(?<![\w$])(' + '|'.join(sorted((re.escape(n) for n in names), key=len, reverse=True)) + r')(?![\w])', re.I) if names else None
    cash_re = re.compile(r'\$([A-Za-z][A-Za-z0-9]{1,9})\b'); up_re = re.compile(r'\b([A-Z][A-Z0-9]{2,9})\b')
    theme_re = {k: re.compile(v['kw'], re.I) for k, v in THEMES.items()}
    for d in docs:
        t = d['text']; pos = defaultdict(list)
        d['removed'] = '[removed]' in t and len(re.sub(r'\[removed\]', '', t).strip()) < 40
        d['promo'] = bool(PUMP_RE.search(t))
        for m in cash_re.finditer(t):
            s = m.group(1).upper()
            if s not in STOP and not s.isdigit() and not re.fullmatch(r'\d+[KMB]?', s): pos[s].append(m.start())
        for m in up_re.finditer(t):
            if m.group(1) in syms: pos[m.group(1)].append(m.start())
        if name_re:
            for m in name_re.finditer(t): pos[names[m.group(1).lower()]].append(m.start())
        d['ents'] = sorted(pos)
        d['ev'] = sorted(k for k, r in EV_RE.items() if r.search(t))
        # entity-event pairs only when the event word is within 120 chars of the entity mention
        d['pairs'] = sorted({(e, k) for e, ps in pos.items() for k, r in EV_RE.items() if any(r.search(t[max(0, p - 120): p + 120]) for p in ps)})
        d['themes'] = sorted(k for k, r in theme_re.items() if r.search(t))
    return docs

def sia():
    sys.path.insert(0, os.path.join(HERE, 'sentiment', 'vendor'))
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        a = SentimentIntensityAnalyzer()
        try: a.lexicon.update(json.load(open(os.path.join(HERE, 'sentiment', 'lexicon_crypto.json')))['words'])
        except Exception: pass
        return a
    except Exception: return None

def snippet(t, e):
    t = t.replace('\n', ' '); m = re.search(r'(?i)\$?' + re.escape(e), t)
    if not m or m.start() < 100: return t[:170]
    return '…' + t[max(0, m.start() - 70): m.start() + 100]

def aggregate(docs):
    A = sia()
    E = defaultdict(lambda: {'c24': 0, 'c24v': 0, 'cPrior': 0, 'w24': 0.0, 'src': Counter(), 'ch': set(), 'ev': Counter(), 'evch': defaultdict(set), 'pol': [], 'ex': []})
    T = defaultdict(lambda: {'c24': 0, 'cPrior': 0, 'ev': Counter(), 'src': Counter()})
    for d in docs:
        if d.get('removed') or d.get('promo'): continue
        recent = d['t'] >= H24
        pol = A.polarity_scores(d['text'][:600])['compound'] if A and recent else None
        for e in d['ents']:
            x = E[e]
            if recent:
                x['c24'] += 1; x['w24'] += d['w']; x['src'][d['src']] += 1; x['ch'].add(d['ch'])
                if d['src'] != 'reddit_c': x['c24v'] += 1
                for (pe, v) in d['pairs']:
                    if pe == e: x['ev'][v] += 1; x['evch'][v].add(d['ch'])
                if pol is not None: x['pol'].append(pol)
                evs = [v for (pe, v) in d['pairs'] if pe == e]
                if len(x['ex']) < 6 and (evs or len(x['ex']) < 3): x['ex'].append({'src': d['ch'], 'text': snippet(d['text'], e), 'url': d['url'], 'ev': evs})
            elif d['t'] >= H96: x['cPrior'] += 1
        for th in d['themes']:
            y = T[th]
            if recent:
                y['c24'] += 1; y['src'][d['src']] += 1
                for v in d['ev']: y['ev'][v] += 1
            elif d['t'] >= H96: y['cPrior'] += 1
    ents = []
    for e, x in E.items():
        if x['c24'] < 2: continue
        base = x['cPrior'] / 3
        vel = (x['c24v'] + 1) / (base + 1)
        ents.append({'entity': e, 'mentions24h': x['c24'], 'mentions24hExComments': x['c24v'], 'evChannels': {k: len(v) for k, v in x['evch'].items()}, 'perDayPrior72h': round(base, 1), 'velocity': round(vel, 2), 'engagement24h': round(x['w24'], 1), 'sources': dict(x['src']), 'channels': len(x['ch']),
                     'events': dict(x['ev']), 'sentiment': round(sum(x['pol']) / len(x['pol']), 3) if x['pol'] else None, 'spike': x['c24v'] >= 5 and vel >= 2.5, 'examples': x['ex'][:4], '_ch': sorted(x['ch'])})
    ents.sort(key=lambda z: -(z['mentions24h'] * min(z['velocity'], 6)))
    rumors = []
    for z in ents:
        evs = {k: v for k, v in z['events'].items()}
        for ev, n in evs.items():
            if n < 1: continue
            nch = z['evChannels'].get(ev, 0)
            if (n >= 2 and nch >= 2) or (z['spike'] and n >= 1):
                rumors.append({'entity': z['entity'], 'event': ev, 'mentions': n, 'channels': nch, 'velocity': z['velocity'], 'spike': z['spike'], 'sentiment': z['sentiment'],
                               'evidence': [ex for ex in z['examples'] if ev in ex['ev']][:3] or z['examples'][:2]})
    rumors.sort(key=lambda r: -(r['mentions'] * (2 if r['spike'] else 1) * (1.5 if r['event'] in ('hack', 'exploit', 'delist', 'rug') else 1)))
    for z in ents: z.pop('_ch', None)
    themes = []
    for k, y in T.items():
        base = y['cPrior'] / 3
        themes.append({'id': k, 'name': THEMES[k]['name'], 'mentions24h': y['c24'], 'perDayPrior72h': round(base, 1), 'velocity': round((y['c24'] + 1) / (base + 1), 2), 'events': dict(y['ev']), 'sources': dict(y['src'])})
    themes.sort(key=lambda t: -t['mentions24h'])
    return ents, rumors, themes

def main():
    hp = os.path.join(DATA_DIR, 'socialalt_history.json')
    try: hist = json.load(open(hp))
    except Exception: hist = {}
    docs = []
    for name, fn in (('reddit', reddit), ('telegram', telegram)):
        try: d = fn(); docs += d; log(name, len(d))
        except Exception as e: STATUS[name] = 'error ' + str(e)[:100]; log(name, 'ERR', e)
    fd, topics = [], []
    try: fd, topics = discourse(); docs += fd; log('forums', len(topics))
    except Exception as e: STATUS['discourse'] = 'error ' + str(e)[:100]
    sd, props = [], []
    try: sd, props = snapshot(); docs += sd; log('snapshot', len(props))
    except Exception as e: STATUS['snapshot'] = 'error ' + str(e)[:100]
    gd, issues = [], []
    try: gd, issues = github(); docs += gd; log('github', len(issues))
    except Exception as e: STATUS['github'] = 'error ' + str(e)[:100]
    try: dc = discord(hist); log('discord', len(dc))
    except Exception as e: dc = []; STATUS['discord'] = 'error ' + str(e)[:100]
    extract(docs)
    ents, rumors, themes = aggregate(docs)
    by_src = Counter(d['src'] for d in docs if d['t'] >= H24); by_src_prior = Counter(d['src'] for d in docs if H96 <= d['t'] < H24)
    hist.setdefault('runs', []).append({'t': NOW, 'docs24': dict(by_src), 'top': [[e['entity'], e['mentions24h']] for e in ents[:30]], 'themes': {t['id']: t['mentions24h'] for t in themes}}); del hist['runs'][:-200]
    json.dump(hist, open(hp, 'w'))
    promos = defaultdict(lambda: {'n': 0, 'channels': set(), 'last': 0, 'text': ''})
    for d in docs:
        if d.get('promo') and d['t'] >= H24:
            for e in d['ents'] or ['?']:
                if e in ('JUP', 'SOL'): continue
                p = promos[e]; p['n'] += 1; p['channels'].add(d['ch']); p['last'] = max(p['last'], d['t']); p['text'] = d['text'][:160].replace('\n', ' ')
    pump_promos = sorted([{'entity': k, 'posts24h': v['n'], 'channels': sorted(v['channels']), 'lastH': round((NOW - v['last']) / 3600, 1), 'sample': v['text'], 'note': 'paid pump-group promotion: treat as a rug/dump-risk flag, not a buy signal'} for k, v in promos.items()], key=lambda x: -x['posts24h'])
    removed24 = sum(1 for d in docs if d.get('removed') and d['t'] >= H24)
    hot_forum = sorted([t for t in topics if t['createdH'] <= 72 or t['lastPostH'] <= 24], key=lambda t: -(t['postsPerDay'] or 0))[:25]
    channel = {'name': 'non-X', 'generatedAt': int(NOW * 1000),
               'bySymbol': {e['entity']: {'mentions24h': e['mentions24h'], 'velocity': e['velocity'], 'sentiment': e['sentiment'], 'spike': e['spike'], 'events': e['events'], 'channels': e['channels']} for e in ents[:200]},
               'byTheme': {t['id']: {'mentions24h': t['mentions24h'], 'velocity': t['velocity'], 'events': t['events']} for t in themes}}
    res = {'docs': {'last24h': dict(by_src), 'prior72h': dict(by_src_prior), 'total': len(docs)}, 'status': STATUS, 'entities': ents[:120], 'rumors': rumors[:40], 'themes': themes,
           'pumpPromos': pump_promos[:20], 'removedByMods24h': removed24, 'governance': {'hotTopics': hot_forum, 'snapshot': props[:30]}, 'discord': dc, 'github': sorted(issues, key=lambda i: i['createdH'])[:40], 'channel': channel,
           'limits': ['reddit.com JSON/RSS return HTTP 403 from this host; Reddit data comes from the Arctic Shift archive (free, no login). Scores there are frozen at ingest, so score velocity is approximated by comment counts and mention counts per hour.',
                      'Telegram: only public channels with web preview enabled (t.me/s); about 20 messages per page, 4 pages max per channel; private groups not covered.',
                      'Discord: only invite metadata (members/online). No message content without adding a bot to each server (needs your approval and the server\'s).',
                      'Tally requires an API key (not used). Snapshot + Discourse cover most DAO governance; Hyperliquid and Derive have no public forum.',
                      'GitHub search is unauthenticated (10 req/min) and scoped to ~18 major crypto orgs.',
                      'Entity extraction is dictionary + cashtag based: ambiguous tickers (e.g. ONE, GAS) need a $ prefix; short names may be missed.'],
           'method': 'velocity = (mentions last 24h + 1) / (mentions per day over the prior 72h + 1); spike = >=5 mentions and velocity >=2.5; rumor = entity + event keyword in >=2 docs across >=2 channels, or a spike with an event keyword. Sentiment = VADER 3.3.2 + the terminal crypto lexicon (research/sentiment/lexicon_crypto.json), mean compound of last-24h docs.'}
    pc.save('socialalt.json', res)

if __name__ == '__main__':
    main()
