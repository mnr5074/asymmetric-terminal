#!/usr/bin/env python3
"""Developer-activity desk (stdlib only).  Output: data/devactivity.json (+ data/devactivity_backtest.json).

Pipeline (each stage caches under data/devactivity_cache/ so reruns are cheap):
  map      universe (crash catalog + sleepers/laggards + revival cases + perp universe/watchlist + majors) ->
           CoinGecko free /coins/{id} (links.repos_url.github, links.homepage, developer_data) ->
           GitHub org/user repo listing (public HTML page, not the 60/hr REST API) -> non-fork, non-archived,
           non-mirror "main repos" (explicitly linked repos + top-starred + most recently pushed, docs/website repos skipped).
           Ownership evidence: project homepage links to the GitHub owner (strong) or owner/repo/description matches the
           token name/symbol (medium).  An owner claimed by >1 unrelated tokens without homepage proof is marked ambiguous.
  git      every main repo: `git clone --bare --filter=tree:0 --single-branch --shallow-since=<START>` of the default
           branch (git-over-HTTPS is not subject to the REST API quota; commits only, no trees/blobs).  Bot commits
           ([bot], dependabot, renovate, github-actions) dropped.  Releases from the public releases.atom feed (last 10).
  analyze  weekly panel (Monday 00:00 UTC buckets) -> frequency score, silence (14/30/60d), burst (>=3x trailing 8-wk avg
           or z>2.5 vs trailing 12 wk, min 5 commits) -> event study vs BTC-excess forward returns (CoinGecko daily closes),
           live flags, case studies.
Usage: python3 research/devactivity.py [map|git|analyze|all] [--limit N]
Optional: if `gh auth token` works, the REST API is used for repo metadata (mirror flag); tokens are never printed.
"""
import json, os, re, sys, time, math, random, subprocess, datetime as dt, urllib.request, urllib.error, urllib.parse, html as htmlmod
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
CACHE = os.path.join(DATA, 'devactivity_cache')
for sub in ('cg', 'gh', 'web', 'git', 'px', 'rel'): os.makedirs(os.path.join(CACHE, sub), exist_ok=True)
START = '2025-05-01'          # commit history start (8+ weeks before the 365-day CoinGecko price window)
UA = 'Mozilla/5.0 (asymmetric-terminal devactivity research, read-only)'
GAP = {'api.coingecko.com': 2.6, 'github.com': 1.0}
_last = {}
def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

def fetch(url, accept='application/json', timeout=25, retries=3):
    host = urllib.parse.urlparse(url).hostname
    for i in range(retries + 1):
        w = _last.get(host, 0) + GAP.get(host, 0.5) - time.time()
        if w > 0: time.sleep(w)
        _last[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={'user-agent': UA, 'accept': accept})
            with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and i < retries: time.sleep(20 * (i + 1) if e.code == 429 else 5 * (i + 1)); continue
            return e.code, None
        except Exception:
            if i < retries: time.sleep(3 * (i + 1)); continue
            return 0, None
    return 0, None

def jload(p, d=None):
    try: return json.load(open(p))
    except Exception: return d
def jsave(p, v):
    tmp = p + '.tmp'; json.dump(v, open(tmp, 'w'), separators=(',', ':')); os.replace(tmp, p)
def safe(s): return re.sub(r'[^A-Za-z0-9_.-]', '_', s)

# ------------------------------------------------------------------ universe
MAJORS = ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'cardano', 'avalanche-2']
CASES = ['zcash', 'dash', 'derive', 'aerodrome-finance']
def universe():
    U = {}
    def add(cid, src, sym=None, name=None):
        if not cid: return
        u = U.setdefault(cid, {'id': cid, 'symbol': sym, 'name': name, 'src': []})
        if src not in u['src']: u['src'].append(src)
        u['symbol'] = u['symbol'] or sym; u['name'] = u['name'] or name
    cat = jload(os.path.join(DATA, 'crash_catalog.json'), {})
    for c in cat.get('catalog', []): add(c.get('id'), 'catalog', c.get('symbol'), c.get('name'))
    fin = jload(os.path.join(DATA, 'crash_catalog_final.json'), {})
    for c in fin.get('coingecko_coins', []): add(c.get('id'), 'catalog', c.get('symbol'), c.get('name'))
    sl = jload(os.path.join(DATA, 'sleepers.json'), {})
    for c in sl.get('items', []) + sl.get('laggards', []): add(c.get('id'), 'sleeper', c.get('symbol'), c.get('name'))
    for c in (sl.get('revival') or {}).get('cases', []): add(c.get('id'), 'revival')
    rl = jload(os.path.join(DATA, 'revival_lab.json'), {})
    for c in rl.get('cases', []) + rl.get('fingerprints', []): add(c.get('id'), 'revival')
    pj = jload(os.path.join(DATA, 'perps.json'), {})
    for t in pj.get('tokens', []):
        if t.get('cgId'): add(t['cgId'], 'watchlist' if 'watchlist' in (t.get('sources') or []) else 'perp', t.get('sym'), t.get('name'))
    for c in MAJORS: add(c, 'major')
    for c in CASES: add(c, 'case')
    return U

# ------------------------------------------------------------------ map stage
GH_RE = re.compile(r'https?://(?:www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:/([A-Za-z0-9._-]+))?', re.I)
RESERVED = {'orgs', 'features', 'topics', 'collections', 'sponsors', 'marketplace', 'about', 'pricing', 'login', 'join', 'settings', 'apps', 'search', 'explore', 'site', 'contact', 'enterprise', 'security'}
DOCSY = re.compile(r'(^|[-_.])(docs?|documentation|website|site|web|brand|branding|assets|media|press|logos?|awesome|\.github|github\.io|token-?list|tokenlists?|blog|faq|wiki|landing|kit)([-_.]|$)', re.I)

def cg_detail(cid):
    p = os.path.join(CACHE, 'cg', safe(cid) + '.json')
    d = jload(p)
    if d is not None: return d
    st, body = fetch(f'https://api.coingecko.com/api/v3/coins/{urllib.parse.quote(cid)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=true&sparkline=false')
    if st == 404: d = {'missing': True}
    elif not body: return None
    else:
        x = json.loads(body); L = x.get('links') or {}
        d = {'id': cid, 'symbol': x.get('symbol'), 'name': x.get('name'), 'github': (L.get('repos_url') or {}).get('github') or [],
             'homepage': [h for h in L.get('homepage') or [] if h], 'whitepaper': L.get('whitepaper'), 'developer_data': x.get('developer_data'),
             'categories': x.get('categories'), 'fetchedAt': int(time.time())}
    jsave(p, d); return d

def gh_owner_repos(owner):
    """Public org (or user) repository listing from the GitHub web page. Returns {'kind', 'repos':[...]} or None."""
    p = os.path.join(CACHE, 'gh', safe(owner.lower()) + '.json')
    d = jload(p)
    if d is not None and time.time() - d.get('t', 0) < 3 * 86400: return d
    out = {'owner': owner, 't': int(time.time()), 'repos': {}, 'kind': None}
    for sort in ('stargazers', ''):
        st, h = fetch(f'https://github.com/orgs/{owner}/repositories?type=all' + (f'&sort={sort}' if sort else ''), accept='text/html')
        if st == 404: break
        m = re.search(r'data-target="react-app.embeddedData">(.*?)</script>', h or '', re.S)
        if not m: break
        try: R = json.loads(m.group(1))['payload']['orgReposPageRoute']
        except Exception: break
        out['kind'] = 'org'; out['repoCount'] = R.get('repositoryCount')
        for r in R.get('repositories', []):
            out['repos'][r['name']] = {'name': r['name'], 'fork': r.get('isFork'), 'archived': 'archive' in (r.get('type') or '').lower(), 'stars': r.get('starsCount') or 0,
                                       'pushed': (r.get('lastUpdated') or {}).get('timestamp'), 'desc': r.get('description') or '', 'mirror': bool(re.search(r'\bmirror\b', r.get('description') or '', re.I))}
    if out['kind'] is None:   # user account
        for sort in ('stargazers', ''):
            st, h = fetch(f'https://github.com/{owner}?tab=repositories' + (f'&sort={sort}' if sort else ''), accept='text/html')
            if st != 200 or not h: break
            out['kind'] = 'user'
            for li in re.findall(r'<li[^>]*itemprop="owns"[^>]*>(.*?)</li>', h, re.S):
                n = re.search(r'href="/[^/]+/([^"/]+)" itemprop="name codeRepository"', li)
                if not n: continue
                fork = 'Forked from' in li; t = re.search(r'datetime="([^"]+)"', li)
                stars = re.search(r'/stargazers"[^>]*>\s*(?:<svg.*?</svg>)?\s*([\d,.k]+)', li, re.S)
                sv = 0
                if stars:
                    s = stars.group(1).replace(',', ''); sv = int(float(s[:-1]) * 1000) if s.endswith('k') else int(float(s or 0))
                desc = re.search(r'itemprop="description"[^>]*>(.*?)</p>', li, re.S)
                out['repos'][n.group(1)] = {'name': n.group(1), 'fork': fork, 'archived': 'Public archive' in li, 'stars': sv, 'pushed': t.group(1) if t else None,
                                            'desc': htmlmod.unescape(re.sub('<[^>]+>', '', desc.group(1))).strip() if desc else '', 'mirror': 'Mirror of' in li}
    out['repos'] = list(out['repos'].values())
    jsave(p, out); return out

def gh_repo_page(owner, repo):
    """Single repo check (for linked repos not in the listing): exists, fork, archived, mirror."""
    p = os.path.join(CACHE, 'gh', safe(owner.lower() + '__' + repo.lower()) + '.json')
    d = jload(p)
    if d is not None: return d
    st, h = fetch(f'https://github.com/{owner}/{repo}', accept='text/html')
    if st != 200 or not h: d = {'exists': False, 'status': st}
    else:
        canon = re.search(r'<meta property="og:url" content="https://github.com/([^/"]+)/([^/"]+)"', h)
        d = {'exists': True, 'fork': bool(re.search(r'forked from <a', h)), 'archived': 'This repository has been archived' in h, 'mirror': bool(re.search(r'mirrored from', h, re.I)),
             'owner': canon.group(1) if canon else owner, 'name': canon.group(2) if canon else repo}
    jsave(p, d); return d

def homepage_links(url):
    p = os.path.join(CACHE, 'web', safe(urllib.parse.urlparse(url).netloc + urllib.parse.urlparse(url).path)[:150] + '.json')
    d = jload(p)
    if d is not None: return d
    st, h = fetch(url, accept='text/html', timeout=15, retries=1)
    owners = sorted({m.group(1).lower() for m in GH_RE.finditer(h or '') if m.group(1).lower() not in RESERVED})
    d = {'status': st, 'owners': owners}; jsave(p, d); return d

def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())

def map_stage(limit=None):
    U = universe(); ids = list(U)
    pri = lambda c: (0 if set(U[c]['src']) & {'case', 'major', 'revival', 'sleeper', 'perp', 'watchlist'} else 1)
    ids.sort(key=pri)
    if limit: ids = ids[:limit]
    log('universe', len(U), 'mapping', len(ids))
    out = {}
    owner_claims = {}
    for i, cid in enumerate(ids):
        d = cg_detail(cid)
        if i % 50 == 0: log('cg', i, cid)
        if not d: out[cid] = {**U[cid], 'status': 'cg_fetch_failed'}; continue
        if d.get('missing'): out[cid] = {**U[cid], 'status': 'cg_missing'}; continue
        links = []
        for g in d.get('github') or []:
            m = GH_RE.match(g.strip())
            if m and m.group(1).lower() not in RESERVED:
                repo = m.group(2)
                if repo and repo.endswith('.git'): repo = repo[:-4]
                links.append((m.group(1), repo))
        out[cid] = {**U[cid], 'symbol': d.get('symbol') or U[cid]['symbol'], 'name': d.get('name') or U[cid]['name'], 'cg_github': d.get('github') or [],
                    'homepage': (d.get('homepage') or [None])[0], 'developer_data': d.get('developer_data'), 'links': links}
        for o, _ in links: owner_claims.setdefault(o.lower(), set()).add(cid)
    # manual overrides: only where CoinGecko lacks a link; evidence noted (verified by homepage/README below like any other)
    OVR = {'derive': [('derivexyz', None)]}
    for cid, L in OVR.items():
        if cid in out and not out[cid].get('links'): out[cid]['links'] = L; out[cid]['override'] = True; [owner_claims.setdefault(o.lower(), set()).add(cid) for o, _ in L]
    for cid, x in out.items():
        if not x.get('links'): x.setdefault('status', 'no_repo_listed'); continue
        name_keys = {norm(x.get('name')), norm(x.get('symbol')), norm(cid)} - {''}
        name_keys |= {k for k in [norm((x.get('name') or '').split(' ')[0])] if len(k) >= 4}
        hp = homepage_links(x['homepage']) if x.get('homepage') else {'owners': []}
        repos, evid, owners_seen = [], [], set()
        for owner, repo in x['links']:
            ol = owner.lower()
            if ol in owners_seen and not repo: continue
            first_owner = ol not in owners_seen
            owners_seen.add(ol)
            listing = gh_owner_repos(owner)
            ev = []
            if ol in hp.get('owners', []): ev.append('homepage links github.com/' + owner)
            okey = norm(owner)
            if any(k and len(k) >= 3 and (k in okey or (len(okey) >= 4 and okey in k)) for k in name_keys): ev.append('owner name matches token')
            cand = []
            if repo:
                info = next((r for r in listing.get('repos', []) if r['name'].lower() == repo.lower()), None) if listing else None
                if not info:
                    pg = gh_repo_page(owner, repo)
                    if not pg.get('exists'): evid.append(f'{owner}/{repo}: not found'); continue
                    info = {'name': pg['name'], 'fork': pg['fork'], 'archived': pg['archived'], 'mirror': pg['mirror'], 'stars': None, 'pushed': None, 'desc': ''}
                    owner = pg.get('owner') or owner
                if any(k and len(k) >= 3 and k in norm(info['name'] + info.get('desc', '')) for k in name_keys): ev.append('repo name/description matches token')
                if info.get('mirror') or info.get('archived'): evid.append(f'{owner}/{info["name"]}: skipped ({"mirror" if info.get("mirror") else "archived"})')
                elif info['fork'] and not ev: evid.append(f'{owner}/{info["name"]}: skipped (fork, no ownership evidence)')
                elif info['fork']: cand.append(dict(info, owner=owner, why='linked on CoinGecko; GitHub-fork network of an upstream codebase but the project\'s own primary repo (ownership evidence present)')); evid.append(f'{owner}/{info["name"]}: kept although GitHub marks it a fork (CoinGecko-linked primary repo)')
                else: cand.append(dict(info, owner=owner, why='linked on CoinGecko'))
            if listing and listing.get('repos'):
                ok = [r for r in listing['repos'] if not r['fork'] and not r['archived'] and not r['mirror'] and not DOCSY.search(r['name'])]
                if any(any(k and len(k) >= 4 and k in norm(r['name'] + r['desc']) for k in name_keys) for r in ok[:30]): ev.append('org repos mention token name')
                if first_owner:   # always add the owner's main repos (CoinGecko repo links are often stale): org link -> 4 top + 2 recent; repo link -> 2 top + 1 recent
                    nt, nr = (4, 2) if (not repo or not cand) else (2, 1)
                    top = sorted(ok, key=lambda r: -(r['stars'] or 0))[:nt]
                    rec = sorted([r for r in ok if r['pushed'] and r not in top and (r['stars'] or 0) >= 1], key=lambda r: r['pushed'], reverse=True)[:nr]
                    for r in top: cand.append(dict(r, owner=owner, why='top-starred non-fork'))
                    for r in rec: cand.append(dict(r, owner=owner, why='most recently pushed non-fork'))
                forks = sum(1 for r in listing['repos'] if r['fork']); arch = sum(1 for r in listing['repos'] if r['archived'])
                if forks or arch: evid.append(f'{owner}: {forks} forks / {arch} archived skipped of {len(listing["repos"])} listed')
            elif not repo and listing is not None and listing.get('kind') is None:
                evid.append(f'{owner}: account not found'); continue
            shared = sorted(owner_claims.get(ol, set()) - {cid})
            for c in cand:
                if not any(r['owner'].lower() == c['owner'].lower() and r['name'].lower() == c['name'].lower() for r in repos):
                    repos.append({'owner': c['owner'], 'name': c['name'], 'stars': c.get('stars'), 'pushed': c.get('pushed'), 'why': c['why'], 'evidence': sorted(set(ev)), 'shared_with': shared})
        strong = any('homepage' in e for r in repos for e in r['evidence'])
        medium = any(r['evidence'] for r in repos)
        shared = any(r['shared_with'] for r in repos)
        x['repos'] = repos[:8]; x['notes'] = evid
        x['verification'] = 'homepage' if strong else ('name-match' if medium and not shared else ('ambiguous (owner shared by several tokens)' if shared else 'unverified (CoinGecko link only)'))
        x['status'] = 'mapped' if repos else 'repo_unusable'
        x['verified'] = bool(repos) and (strong or (medium and not shared))
    jsave(os.path.join(DATA, 'devactivity_map.json'), {'generatedAt': int(time.time() * 1000), 'universe': len(U), 'mapped_ids': len(out), 'items': out})
    log('map done', sum(1 for x in out.values() if x.get('status') == 'mapped'), 'mapped of', len(out))
    return out

# ------------------------------------------------------------------ git stage
BOT = re.compile(r'\[bot\]|dependabot|renovate|github-actions|actions@github|noreply@github\.com>?$|snyk-bot|mergify|semantic-release', re.I)
def git(args, cwd=None, timeout=300):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/bin/true')
    return subprocess.run(['git'] + args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)

def repo_history(owner, name):
    key = safe(owner.lower() + '__' + name.lower())
    gdir = os.path.join(CACHE, 'git', key + '.git'); summ = os.path.join(CACHE, 'git', key + '.json')
    s = jload(summ)
    if s and time.time() - s.get('t', 0) < 12 * 3600: return s
    url = f'https://github.com/{owner}/{name}.git'
    try:
        if os.path.isdir(gdir):
            r = git(['fetch', '--filter=tree:0', f'--shallow-since={START}', 'origin', '+HEAD:refs/heads/_head'], cwd=gdir)
            if r.returncode != 0: r = git(['fetch', '--depth=1', 'origin', '+HEAD:refs/heads/_head'], cwd=gdir)
        else:
            r = git(['clone', '--bare', '--filter=tree:0', '--single-branch', f'--shallow-since={START}', url, gdir])
            if r.returncode != 0:
                if os.path.isdir(gdir): subprocess.run(['rm', '-rf', gdir])
                r = git(['clone', '--bare', '--filter=tree:0', '--single-branch', '--depth=1', url, gdir])   # nothing since START: still learn the last commit date
        if r.returncode != 0: s = {'t': int(time.time()), 'ok': False, 'err': (r.stderr or '')[-200:]}; jsave(summ, s); return s
        head = git(['symbolic-ref', 'HEAD'], cwd=gdir).stdout.strip().replace('refs/heads/', '')
        ref = '_head' if git(['rev-parse', '--verify', '-q', 'refs/heads/_head'], cwd=gdir).returncode == 0 else 'HEAD'
        lg = git(['log', ref, '--format=%ct\x1f%at\x1f%ae\x1f%an\x1f%s'], cwd=gdir).stdout.splitlines()
    except subprocess.TimeoutExpired:
        s = {'t': int(time.time()), 'ok': False, 'err': 'timeout'}; jsave(summ, s); return s
    commits, bots, last_any = [], 0, None
    since = dt.datetime.fromisoformat(START).replace(tzinfo=dt.timezone.utc).timestamp()
    for ln in lg:
        p = ln.split('\x1f')
        if len(p) < 4: continue
        ct = int(p[0]); last_any = max(last_any or 0, ct)
        if BOT.search(p[2] + ' ' + p[3]): bots += 1; continue
        if ct >= since: commits.append([ct, (p[2] or p[3]).lower()])
    human_last = max((c[0] for c in commits), default=None)
    if human_last is None:   # outside window or only bots: take most recent human commit we have
        for ln in lg:
            p = ln.split('\x1f')
            if len(p) >= 4 and not BOT.search(p[2] + ' ' + p[3]): human_last = max(human_last or 0, int(p[0]))
    # releases (public atom feed, last 10)
    rel = []
    st, body = fetch(f'https://github.com/{owner}/{name}/releases.atom', accept='application/atom+xml')
    if body: rel = re.findall(r'<entry>.*?<updated>([^<]+)</updated>', body, re.S)
    authors = sorted({c[1] for c in commits})
    aid = {a: i for i, a in enumerate(authors)}
    s = {'t': int(time.time()), 'ok': True, 'default_branch': head, 'commits': [[c[0], aid[c[1]]] for c in commits], 'n_authors': len(authors),
         'bot_commits_dropped': bots, 'last_commit': human_last, 'last_commit_any': last_any, 'releases': rel}
    jsave(summ, s); return s

def git_stage(only=None):
    M = jload(os.path.join(DATA, 'devactivity_map.json'))['items']
    jobs = []
    for cid, x in M.items():
        if only and cid not in only: continue
        for r in x.get('repos', []): jobs.append((r['owner'], r['name']))
    jobs = sorted(set(jobs)); log('repos to sync', len(jobs))
    for i, (o, n) in enumerate(jobs):
        t0 = time.time(); s = repo_history(o, n)
        if i % 20 == 0 or time.time() - t0 > 30: log('git', i, f'{o}/{n}', 'ok' if s.get('ok') else s.get('err'), len(s.get('commits', [])), f'{time.time()-t0:.0f}s')

# ------------------------------------------------------------------ prices
def closes(cid):
    for p in (os.path.join(DATA, 'cg_series', cid + '.json'), os.path.join(CACHE, 'px', safe(cid) + '.json')):
        d = jload(p)
        if d and d.get('prices'): break
    else:
        d = None
    if d is None or (d.get('t') and time.time() - d['t'] > 2 * 86400 and 'px' in p):
        st, body = fetch(f'https://api.coingecko.com/api/v3/coins/{urllib.parse.quote(cid)}/market_chart?vs_currency=usd&days=365&interval=daily')
        if not body: return {}
        d = json.loads(body); d = {'prices': d.get('prices') or [], 't': int(time.time())}; jsave(os.path.join(CACHE, 'px', safe(cid) + '.json'), d)
    out = {}
    for t, v in d.get('prices') or []:
        if v and v > 0: out[dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date()] = v
    return out

# ------------------------------------------------------------------ stats (stdlib)
def mean(a): return sum(a) / len(a) if a else None
def sd(a):
    if len(a) < 2: return None
    m = mean(a); return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))
def median(a):
    a = sorted(a); n = len(a)
    return None if not n else (a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2)
def ncdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def mannwhitney(x, y):
    """two-sided normal-approx Mann-Whitney U with tie correction; returns (p, cliffs_delta)"""
    nx, ny = len(x), len(y)
    if nx < 3 or ny < 3: return None, None
    allv = sorted([(v, 0) for v in x] + [(v, 1) for v in y]); ranks = [0] * len(allv); i = 0; ties = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1): ranks[k] = r
        t = j - i + 1; ties += t ** 3 - t; i = j + 1
    rx = sum(r for r, (v, g) in zip(ranks, allv) if g == 0)
    U = rx - nx * (nx + 1) / 2; N = nx + ny
    var = nx * ny / 12 * ((N + 1) - ties / (N * (N - 1)))
    if var <= 0: return None, None
    z = (U - nx * ny / 2) / math.sqrt(var)
    return 2 * (1 - ncdf(abs(z))), 2 * U / (nx * ny) - 1
def fisher(a, b, c, d):
    """two-sided Fisher exact on [[a,b],[c,d]]"""
    lf = lambda n: math.lgamma(n + 1)
    n1, n2, m1, N = a + b, c + d, a + c, a + b + c + d
    def p(x): return math.exp(lf(n1) + lf(n2) + lf(m1) + lf(N - m1) - lf(N) - lf(x) - lf(n1 - x) - lf(m1 - x) - lf(n2 - m1 + x))
    p0 = p(a); lo, hi = max(0, m1 - n2), min(n1, m1)
    return min(1.0, sum(p(x) for x in range(lo, hi + 1) if p(x) <= p0 * (1 + 1e-7)))
def cluster_perm(events, base_by_proj, stat='mean', iters=2000, seed=7):
    """Permutation p-value that respects project clustering: for every event keep its project, redraw a random week of the
    same project (from that project's eligible weeks) and recompute the mean outcome. Two-sided vs the observed mean."""
    rnd = random.Random(seed); obs = mean([e[1] for e in events])
    pools = {p: v for p, v in base_by_proj.items() if v}
    if obs is None or not all(e[0] in pools for e in events): return None
    exp = []
    for _ in range(iters): exp.append(mean([rnd.choice(pools[p]) for p, _ in events]))
    mu = mean(exp)
    return (sum(1 for v in exp if abs(v - mu) >= abs(obs - mu)) + 1) / (iters + 1)

# ------------------------------------------------------------------ analyze
def monday(d): return d - dt.timedelta(days=d.weekday())
def analyze():
    M = jload(os.path.join(DATA, 'devactivity_map.json'))
    items = M['items']
    today = dt.datetime.now(dt.timezone.utc).date(); this_mon = monday(today)
    w0 = monday(dt.date.fromisoformat(START)) + dt.timedelta(days=7)
    weeks = []; d = w0
    while d <= this_mon: weeks.append(d); d += dt.timedelta(days=7)
    btc = closes('bitcoin')
    projects = {}
    cat = {c['id']: c for c in jload(os.path.join(DATA, 'crash_catalog.json'), {}).get('catalog', [])}
    for cid, x in items.items():
        if x.get('status') != 'mapped': continue
        hs = []
        for r in x['repos']:
            s = jload(os.path.join(CACHE, 'git', safe(r['owner'].lower() + '__' + r['name'].lower()) + '.json'))
            if s and s.get('ok'): hs.append((r, s))
        if not hs: x['status'] = 'git_failed'; continue
        ts = sorted(c[0] for _, s in hs for c in s['commits'])
        authors = {(r['owner'] + r['name'], c[1]) for r, s in hs for c in s['commits']}
        last = max((s['last_commit'] or 0) for _, s in hs) or None
        wk = {w: 0 for w in weeks}
        for t in ts:
            dd = monday(dt.datetime.fromtimestamp(t, dt.timezone.utc).date()) + dt.timedelta(days=7)   # bucket labelled by its END Monday
            if dd in wk: wk[dd] += 1
        projects[cid] = {'x': x, 'hs': hs, 'ts': ts, 'wk': [wk[w] for w in weeks], 'last': last, 'authors': authors}
    # ---- per project-week features
    def feats(P, i, wk_ts):
        c = P['wk']; T = dt.datetime.combine(weeks[i], dt.time(), dt.timezone.utc).timestamp()
        prev = [t for t in P['ts'] if t < T]
        lastc = prev[-1] if prev else None
        if lastc is None:
            pl = [s['last_commit'] for _, s in P['hs'] if s['last_commit'] and s['last_commit'] < T]
            lastc = max(pl) if pl else None
        days_silent = (T - lastc) / 86400 if lastc else None
        tr8 = c[max(0, i - 8):i]; tr12 = c[max(0, i - 12):i]
        cw = c[i]
        a8 = mean(tr8) if len(tr8) == 8 else None; s12 = sd(tr12) if len(tr12) == 12 else None; m12 = mean(tr12) if len(tr12) == 12 else None
        burst = bool(a8 is not None and cw >= 5 and ((a8 > 0 and cw >= 3 * a8) or (a8 == 0)) ) or bool(s12 and s12 > 0 and cw >= 5 and (cw - m12) / s12 > 2.5)
        z = (cw - m12) / s12 if s12 else None
        # prior activity: commits in the 90 days before the silence started
        prior = sum(1 for t in P['ts'] if lastc and lastc - 90 * 86400 <= t <= lastc)
        last12 = c[max(0, i - 11):i + 1]
        fs = None
        if len(last12) == 12:
            fs = round(100 * (0.5 * sum(1 for v in last12 if v) / 12 + 0.5 * min(1, math.log10(1 + sum(last12)) / math.log10(301))), 1)
        return {'T': weeks[i], 'commits': cw, 'avg8': a8, 'z12': z, 'burst': burst, 'days_silent': days_silent, 'prior90': prior, 'freq': fs}
    def ret(px, d0, h):
        a = px.get(d0); b = px.get(d0 + dt.timedelta(days=h))
        return math.log(b / a) if a and b else None
    panel = []; series = {}
    for cid, P in projects.items():
        px = closes(cid)
        P['px_days'] = len(px)
        rows = []
        for i in range(len(weeks)):
            f = feats(P, i, None)
            d0 = f['T']
            out = {}
            for h in (7, 30, 90):
                r, rb = ret(px, d0, h), ret(btc, d0, h)
                out[h] = (r - rb) if r is not None and rb is not None else None
            f.update({'id': cid, 'ex7': out[7], 'ex30': out[30], 'ex90': out[90], 'has_px': d0 in px})
            rows.append(f)
        # onset markers
        for k, r in enumerate(rows):
            ds = r['days_silent']; pds = rows[k - 1]['days_silent'] if k else None
            for L in (14, 30, 60):
                r[f'sil{L}'] = ds is not None and ds >= L
                r[f'on{L}'] = r[f'sil{L}'] and (pds is not None and pds < L) and r['prior90'] >= 10   # previously active (>=10 commits in the 90d before going quiet)
        lastb = -99
        for k, r in enumerate(rows):
            r['burst_ev'] = r['burst'] and k - lastb > 4
            if r['burst']: lastb = k
        series[cid] = rows
        if P['x'].get('verified'): panel += rows   # backtest uses verified-ownership repos only
    # ---- event study
    def study(flag, hz, thr, direction):
        elig = [r for r in panel if r[hz] is not None and r['avg8'] is not None]
        ev = [r for r in elig if r[flag]]
        base = [r for r in elig if not r[flag]]
        if not ev: return {'n_events': 0, 'n_projects': 0, 'n_base': len(base)}
        hit = (lambda v: v <= thr) if direction == 'down' else (lambda v: v >= thr)
        a = sum(1 for r in ev if hit(r[hz])); c_ = sum(1 for r in base if hit(r[hz]))
        p_mw, cd = mannwhitney([r[hz] for r in ev], [r[hz] for r in base])
        bypj = {}
        for r in elig: bypj.setdefault(r['id'], []).append(r[hz])
        pp = cluster_perm([(r['id'], r[hz]) for r in ev], bypj)
        pct = lambda v: None if v is None else round((math.exp(v) - 1) * 100, 2)
        return {'n_events': len(ev), 'n_projects': len({r['id'] for r in ev}), 'n_base': len(base),
                'event_median_excess_pct': pct(median([r[hz] for r in ev])), 'base_median_excess_pct': pct(median([r[hz] for r in base])),
                'event_mean_excess_logret': round(mean([r[hz] for r in ev]), 4), 'base_mean_excess_logret': round(mean([r[hz] for r in base]), 4),
                'hit_def': f'BTC-excess {hz[2:]}d return {"<=" if direction == "down" else ">="} {thr*100:.0f}% (log)',
                'hit_rate': round(a / len(ev), 3), 'base_rate': round(c_ / len(base), 3) if base else None, 'lift': round((a / len(ev)) / (c_ / len(base)), 2) if base and c_ else None,
                'fisher_p': round(fisher(a, len(ev) - a, c_, len(base) - c_), 4), 'mannwhitney_p': round(p_mw, 4) if p_mw is not None else None,
                'cliffs_delta': round(cd, 3) if cd is not None else None, 'cluster_perm_p_mean': round(pp, 4) if pp is not None else None,
                'events': [{'id': r['id'], 'week': r['T'].isoformat(), 'commits': r['commits'], 'avg8': None if r['avg8'] is None else round(r['avg8'], 1),
                            'days_silent': None if r['days_silent'] is None else round(r['days_silent']), hz: pct(r[hz])} for r in ev][:200]}
    tests = {}
    for L in (14, 30, 60):
        tests[f'silence_onset_{L}d -> 30d'] = study(f'on{L}', 'ex30', math.log(0.8), 'down')
        tests[f'silence_onset_{L}d -> 90d'] = study(f'on{L}', 'ex90', math.log(0.7), 'down')
    tests['silence_state_30d -> 90d (overlapping weeks)'] = study('sil30', 'ex90', math.log(0.7), 'down')
    tests['burst -> 7d'] = study('burst_ev', 'ex7', math.log(1.15), 'up')
    tests['burst -> 30d'] = study('burst_ev', 'ex30', math.log(1.3), 'up')
    # subgroup: catalog crash / runner tokens
    crashset = {k for k, v in cat.items() if (v.get('crash_depth_pct') or 0) <= -70}
    runset = {k for k, v in cat.items() if (v.get('run_multiple_ath_over_atl') or 0) >= 10}
    sub = {}
    for nm, S in (('catalog_crashed_70pct', crashset), ('catalog_runners_10x', runset)):
        keep = panel
        panel_bak = panel
        panel = [r for r in panel_bak if r['id'] in S]
        sub[nm] = {'projects_with_repo_and_prices': len({r['id'] for r in panel if r['has_px']}),
                   'silence_onset_30d -> 90d': study('on30', 'ex90', math.log(0.7), 'down'), 'burst -> 30d': study('burst_ev', 'ex30', math.log(1.3), 'up')}
        for v in sub[nm].values():
            if isinstance(v, dict): v.pop('events', None)
        panel = panel_bak
    # ---- live flags (rolling last 7 days, not the calendar week)
    nowts = time.time(); live = []
    for cid, P in projects.items():
        x = P['x']; ts = P['ts']
        c7 = sum(1 for t in ts if t >= nowts - 7 * 86400)
        prev8 = [sum(1 for t in ts if nowts - (k + 2) * 7 * 86400 <= t < nowts - (k + 1) * 7 * 86400) for k in range(8)]
        prev12 = [sum(1 for t in ts if nowts - (k + 2) * 7 * 86400 <= t < nowts - (k + 1) * 7 * 86400) for k in range(12)]
        a8 = mean(prev8); s12 = sd(prev12); m12 = mean(prev12)
        z = (c7 - m12) / s12 if s12 else None
        burst = c7 >= 5 and ((a8 > 0 and c7 >= 3 * a8) or a8 == 0 or (z is not None and z > 2.5))
        last = P['last']; ds = (nowts - last) / 86400 if last else None
        prior = sum(1 for t in ts if last and last - 90 * 86400 <= t <= last)
        c90 = sum(1 for t in ts if t >= nowts - 90 * 86400); w12 = sum(1 for k in range(12) if any(nowts - (k + 1) * 7 * 86400 <= t < nowts - k * 7 * 86400 for t in ts))
        c12 = sum(1 for t in ts if t >= nowts - 84 * 86400)
        freq = round(100 * (0.5 * w12 / 12 + 0.5 * min(1, math.log10(1 + c12) / math.log10(301))), 1)
        rels = sorted({r for _, s in P['hs'] for r in s['releases']}, reverse=True)
        contrib90 = len({(r['owner'] + r['name'], c[1]) for r, s in P['hs'] for c in s['commits'] if c[0] >= nowts - 90 * 86400})
        silence = None
        if ds is not None:
            silence = 'silent_60d' if ds >= 60 else 'silent_30d' if ds >= 30 else 'silent_14d' if ds >= 14 else None
        live.append({'id': cid, 'symbol': (x.get('symbol') or '').upper(), 'name': x.get('name'), 'src': x.get('src'), 'verified': x.get('verified'), 'verification': x.get('verification'),
                     'repos': [f"{r['owner']}/{r['name']}" for r, _ in P['hs']], 'days_since_last_commit': None if ds is None else round(ds, 1),
                     'last_commit': None if not last else dt.datetime.fromtimestamp(last, dt.timezone.utc).isoformat(timespec='minutes'),
                     'commits_7d': c7, 'avg_weekly_prev8': round(a8, 2), 'z12': None if z is None else round(z, 2), 'commits_90d': c90, 'contributors_90d': contrib90,
                     'releases_90d': sum(1 for r in rels if r >= (today - dt.timedelta(days=90)).isoformat()), 'last_release': rels[0] if rels else None,
                     'frequency_score': freq, 'silence': silence, 'previously_active': prior >= 10, 'prior90_commits_before_silence': prior, 'burst': burst,
                     'weekly_commits_26w': P['wk'][-26:], 'cg_developer_data': {k: v for k, v in (x.get('developer_data') or {}).items() if k in ('commit_count_4_weeks', 'pull_requests_merged', 'stars', 'forks')} or None})
    live.sort(key=lambda r: -(r['frequency_score'] or 0))
    # ---- case studies
    rl = jload(os.path.join(DATA, 'revival_lab.json'), {})
    cases = {}
    rc = {c['id']: c for c in rl.get('cases', [])}; fpb = {c['id']: c for c in rl.get('fingerprints', [])}
    for cid in CASES:
        info = rc.get(cid) or {}; bdate = info.get('breakout_date') or (fpb.get(cid) or {}).get('breakout_date')
        P = projects.get(cid)
        if not P: cases[cid] = {'status': (items.get(cid) or {}).get('status', 'not mapped'), 'notes': (items.get(cid) or {}).get('notes')}; continue
        rows = series[cid]
        cs = {'repos': [f"{r['owner']}/{r['name']}" for r, _ in P['hs']], 'verification': P['x'].get('verification'), 'breakout_date': bdate, 'low_date': info.get('low_date'), 'high_date': info.get('high_date')}
        if bdate:
            b = dt.date.fromisoformat(bdate); bts = dt.datetime.combine(b, dt.time(), dt.timezone.utc).timestamp()
            cnt = lambda a, z: sum(1 for t in P['ts'] if bts - a * 86400 <= t < bts - z * 86400)
            cs.update({'commits_30d_before_breakout': cnt(30, 0), 'commits_31_120d_before_breakout_per30d': round(cnt(120, 30) / 3, 1), 'commits_30d_after_breakout': sum(1 for t in P['ts'] if bts <= t < bts + 30 * 86400)})
            near = [r for r in rows if abs((r['T'] - b).days) <= 63]
            cs['flags_within_9w_of_breakout'] = [{'week': r['T'].isoformat(), 'commits': r['commits'], 'burst': r['burst'], 'days_silent': None if r['days_silent'] is None else round(r['days_silent'])} for r in near if r['burst'] or r['sil14']]
            prior_b = [r for r in rows if r['T'] <= b]
            cs['max_days_silent_in_180d_before_breakout'] = round(max([r['days_silent'] or 0 for r in prior_b if (b - r['T']).days <= 180] or [0]))
        cs['weekly'] = [[r['T'].isoformat(), r['commits']] for r in rows]
        cases[cid] = cs
    # ---- coverage
    st = {}
    for x in items.values(): st[x.get('status')] = st.get(x.get('status'), 0) + 1
    srcs = {}
    for x in items.values():
        for s in x.get('src', []):
            q = srcs.setdefault(s, {'tokens': 0, 'repo_listed': 0, 'mapped': 0, 'verified': 0, 'analyzed': 0})
            q['tokens'] += 1; q['repo_listed'] += bool(x.get('links')); q['mapped'] += x.get('status') == 'mapped' or x.get('id') in projects
            q['verified'] += bool(x.get('verified')); q['analyzed'] += x.get('id') in projects
    meme = [x for x in items.values() if any('meme' in (c or '').lower() for c in (jload(os.path.join(CACHE, 'cg', safe(x['id']) + '.json'), {}) or {}).get('categories') or [])]
    coverage = {'universe': len(items), 'backtest_projects_verified_with_prices': len({r['id'] for r in panel if r['has_px']}), 'status_counts': st, 'by_source': srcs, 'projects_analyzed': len(projects),
                'projects_with_price_series': sum(1 for P in projects.values() if P.get('px_days', 0) > 200),
                'memecoins': {'n': len(meme), 'with_repo_listed': sum(1 for x in meme if x.get('links')), 'analyzed': sum(1 for x in meme if x['id'] in projects)},
                'repos_synced': sum(len(P['hs']) for P in projects.values())}
    out = {'generatedAt': int(time.time() * 1000), 'start': START, 'weeks': [w.isoformat() for w in weeks[-26:]], 'coverage': coverage,
           'definitions': {
               'frequency_score': '0-100 = 50 x (share of the last 12 weeks with >=1 human commit) + 50 x min(1, log10(1+commits in 12w)/log10(301)) across the project\'s main repos (default branches, bots excluded).',
               'silence': 'days since the most recent human commit on any main repo default branch; flags at 14/30/60 days. "previously_active" = >=10 commits in the 90 days before the last commit. Backtest uses ONSET weeks (first week crossing the threshold) of previously active projects.',
               'burst': 'week commits >=5 and (>=3x the trailing 8-week average, or trailing avg 0, or z>2.5 vs trailing 12 weeks). Backtest de-duplicates bursts within 4 weeks per project. Live: rolling last 7 days vs the 8/12 prior 7-day blocks.',
               'returns': 'log(price[t+h]/price[t]) - log(BTC[t+h]/BTC[t]) using CoinGecko free daily closes (365-day window) from the Monday 00:00 UTC that ends the signal week; percent figures convert the log value back (exp-1).',
               'tests': 'Fisher exact (hit rate vs base rate), Mann-Whitney U (normal approx, two-sided) + Cliff\'s delta on the excess-return distributions, and a project-clustered permutation test (each event is replaced by a random week of the SAME project) for the mean. Overlapping weekly horizons make naive p-values optimistic; trust the clustered one most.',
               'caveats': ['Repo set is today\'s (main repos chosen now) - survivorship/look-ahead in repo choice.', 'Price history is only ~365 days (free CoinGecko), so the backtest spans ~Oct 2025-Oct 2026 minus the horizon.', 'Commit counts measure activity, not quality; monorepo vs many-repo projects differ in scale (z/burst are within-project).', 'Shallow-since clones count commits reachable from the default branch only; squash-merge projects show fewer commits.']},
           'tests': tests, 'subgroups': sub, 'live': live,
           'live_silent': [r for r in live if r['silence'] and r['previously_active']],
           'live_silent_any': [{'id': r['id'], 'symbol': r['symbol'], 'days': r['days_since_last_commit']} for r in live if r['silence']],
           'live_bursting': [r for r in live if r['burst']],
           'cases': cases}
    jsave(os.path.join(DATA, 'devactivity.json'), out)
    log('analyze done', coverage)
    return out

if __name__ == '__main__':
    a = sys.argv[1:] or ['all']; lim = int(a[a.index('--limit') + 1]) if '--limit' in a else None
    if a[0] in ('map', 'all'): map_stage(lim)
    if a[0] in ('git', 'all'): git_stage()
    if a[0] in ('analyze', 'all'): analyze()
