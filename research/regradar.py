#!/usr/bin/env python3
"""Regulatory Radar: free crypto-regulation news ingestion + classification + flow cross-reference + event study.

  python3 regradar.py            -> live:  data/regradar.json (+ regradar_alerts.json, regradar_seen.json)   ~2 min
  python3 regradar.py study      -> study: data/regradar_study.json (historical event study)                 ~5-10 min
  python3 regradar.py all        -> both

Free / keyless sources only (verified 2026-10-11):
  News: Google News RSS search (en/es/pt/fa/tr/zh/ko/ja editions; 'site:' queries for regulators without RSS),
        regulator RSS: SEC, CFTC (press + enforcement), Treasury OFAC, Federal Reserve, ESMA, EBA, UK FCA, HK SFC, Japan FSA, RBI.
  Counts: GDELT DOC 2.0 API (timelinevolraw + artlist; max 1 request / 5 s).
  Flows: dolarapi.com + argentinadatos.com (ARS oficial/blue/cripto), Bitso / CriptoYa / Binance P2P public search (ARS),
         Luno + Quidax public tickers and Quidax daily k-line (NGN), Nobitex public stats + UDF history (IRT),
         Binance public klines via data-api.binance.vision (USDT/ARS, USDT/TRY, USDT/BRL), open.er-api.com + fawazahmed0 currency-api
         + frankfurter (official/reference FX), DefiLlama stablecoins (Tron USDT), Google Trends via pytrends (unofficial, rate limited),
         data/stables.json (stables module).
  Prices: Coinbase Exchange public daily candles (BTC/ETH/SOL), data/cg_series/*.json (catalog tokens, CoinGecko free 365 d).
Classification is keyword/rule based (multilingual lexicon below), not an LLM: transparent but imperfect; every item links its source.
Historical events: curated candidates are only kept if a Google News date-restricted search returns matching coverage (citations stored);
GDELT spike days are added as a second, machine-detected event set with the headlines GDELT returns for that day.
Not financial advice. Small samples, overlapping events, daily UTC closes."""
import json, os, re, sys, time, math, random, html, hashlib, statistics as st, datetime as dt, urllib.request, urllib.parse, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA_DIR

CACHE = os.path.join(DATA_DIR, 'regradar_cache'); os.makedirs(CACHE, exist_ok=True)
OUT_LIVE = os.path.join(DATA_DIR, 'regradar.json')
OUT_STUDY = os.path.join(DATA_DIR, 'regradar_study.json')
SEEN_F = os.path.join(DATA_DIR, 'regradar_seen.json')
ALERTS_F = os.path.join(DATA_DIR, 'regradar_alerts.json')
BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
SEC_UA = 'asymmetric-terminal research (read-only; contact: admin@localhost)'
GAPS = {'news.google.com': 1.1, 'api.gdeltproject.org': 6.5, 'api.exchange.coinbase.com': 0.4, 'apiv2.nobitex.ir': 0.6, 'cdn.jsdelivr.net': 0.15, 'data-api.binance.vision': 0.3}
_last = {}
ERRORS = {}
TODAY = dt.datetime.now(dt.UTC).date()

def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

def http(url, ua=BROWSER, data=None, headers=None, timeout=25, retries=2):
    host = urllib.parse.urlparse(url).hostname
    if host == 'api.gdeltproject.org': retries = max(retries, 4)
    for i in range(retries + 1):
        wait = _last.get(host, 0) + GAPS.get(host, 0.25) - time.time()
        if wait > 0: time.sleep(wait)
        _last[host] = time.time()
        h = {'user-agent': ua, 'accept-language': 'en-US,en;q=0.8'}
        if headers: h.update(headers)
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and i < retries:
                time.sleep((15 if 'gdelt' in host else 4) * (i + 1)); continue
            raise
        except Exception:
            if i < retries: time.sleep(2 * (i + 1)); continue
            raise

def jget(url, **kw):
    t = http(url, **kw)
    if 'gdeltproject' in url and t.lstrip().startswith('Please limit'):
        time.sleep(8); t = http(url, **kw)
    return json.loads(t)

def cache_get(key, max_age, fn):
    """File cache under data/regradar_cache. max_age=None -> never expires (immutable past data)."""
    f = os.path.join(CACHE, re.sub(r'[^A-Za-z0-9_.-]+', '_', key)[:180] + '.json')
    try:
        if max_age is None or time.time() - os.path.getmtime(f) < max_age:
            with open(f) as fh: return json.load(fh)
    except Exception: pass
    v = fn()
    if v is not None:
        with open(f + '.tmp', 'w') as fh: json.dump(v, fh)
        os.replace(f + '.tmp', f)
    return v

def safe(name, fn, default=None):
    try: return fn()
    except Exception as e:
        ERRORS[name] = f'{type(e).__name__}: {str(e)[:160]}'; log('ERR', name, ERRORS[name]); return default

def add_days(d, n): return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()
def iso(ts): return dt.datetime.fromtimestamp(ts, dt.UTC).strftime('%Y-%m-%d')
def load_json(f, d):
    try:
        with open(f) as fh: return json.load(fh)
    except Exception: return d

# ======================================================================================================
# 1. SOURCES
# ======================================================================================================
REG_FEEDS = [  # (name, url, country, ua) - all filtered by the crypto lexicon
    ('SEC', 'https://www.sec.gov/news/pressreleases.rss', 'US', SEC_UA),
    ('CFTC', 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', 'US', BROWSER),
    ('CFTC enforcement', 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml', 'US', BROWSER),
    ('Treasury OFAC', 'https://ofac.treasury.gov/rss.xml', 'US', BROWSER),
    ('Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml', 'US', BROWSER),
    ('ESMA', 'https://www.esma.europa.eu/rss.xml', 'EU', BROWSER),
    ('EBA', 'https://www.eba.europa.eu/rss.xml', 'EU', BROWSER),
    ('UK FCA', 'https://www.fca.org.uk/news/rss.xml', 'UK', BROWSER),
    ('HK SFC', 'https://www.sfc.hk/en/RSS-Feeds/Press-releases', 'HK', BROWSER),
    ('Japan FSA', 'https://www.fsa.go.jp/fsaEnNewsList_rss2.xml', 'JP', BROWSER),
    ('RBI', 'https://www.rbi.org.in/pressreleases_rss.xml', 'IN', BROWSER),
]
ED = {'en': ('en-US', 'US', 'US:en'), 'es': ('es-419', 'AR', 'AR:es-419'), 'pt': ('pt-BR', 'BR', 'BR:pt-419'), 'fa': ('en-US', 'US', 'US:en'),  # no Persian Google News edition; the US edition returns Persian-language results
     
      'tr': ('tr', 'TR', 'TR:tr'), 'zh': ('zh-CN', 'CN', 'CN:zh-Hans'), 'zhhk': ('zh-HK', 'HK', 'HK:zh-Hant'), 'ko': ('ko', 'KR', 'KR:ko'), 'ja': ('ja', 'JP', 'JP:ja')}
# (query, lang, default country, official?)  official=True for site: queries restricted to a regulator's own domain
GN_QUERIES = [
    ('SEC crypto', 'en', 'US', False), ('CFTC crypto', 'en', 'US', False), ('CLARITY Act crypto market structure', 'en', 'US', False),
    ('GENIUS Act stablecoin rule', 'en', 'US', False), ('SEC crypto ETF approval', 'en', 'US', False), ('OFAC sanctions crypto', 'en', 'US', False),
    ('Treasury crypto stablecoin', 'en', 'US', False), ('Federal Reserve crypto banks', 'en', 'US', False),
    ('MiCA crypto ESMA', 'en', 'EU', False), ('EBA stablecoin MiCA', 'en', 'EU', False), ('FCA crypto', 'en', 'UK', False),
    ('Hong Kong SFC crypto', 'en', 'HK', False), ('Hong Kong stablecoin licence', 'en', 'HK', False), ('China crypto ban PBOC', 'en', 'CN', False),
    ('MAS Singapore crypto', 'en', 'SG', False), ('Japan FSA crypto', 'en', 'JP', False), ('South Korea FSC crypto', 'en', 'KR', False),
    ('India crypto tax RBI', 'en', 'IN', False), ('Turkey crypto regulation', 'en', 'TR', False), ('Brazil central bank crypto', 'en', 'BR', False),
    ('Nigeria SEC crypto', 'en', 'NG', False), ('Nigeria CBN crypto', 'en', 'NG', False), ('Argentina crypto capital controls', 'en', 'AR', False),
    ('Argentina CNV crypto', 'en', 'AR', False), ('Iran crypto ban', 'en', 'IR', False), ('Iran crypto exchange Nobitex', 'en', 'IR', False),
    ('Russia crypto law', 'en', 'RU', False), ('crypto ban', 'en', None, False), ('crypto exchange license revoked', 'en', None, False),
    ('capital controls crypto', 'en', None, False),
    ('cepo cripto Argentina', 'es', 'AR', False), ('CNV criptomonedas PSAV', 'es', 'AR', False), ('BCRA criptoactivos', 'es', 'AR', False),
    ('Banco Central criptoativos regulação', 'pt', 'BR', False), ('Receita Federal criptoativos', 'pt', 'BR', False),
    ('رمزارز بانک مرکزی', 'fa', 'IR', False), ('صرافی ارز دیجیتال', 'fa', 'IR', False), ('نوبیتکس', 'fa', 'IR', False),
    ('kripto düzenleme SPK', 'tr', 'TR', False), ('kripto vergi', 'tr', 'TR', False),
    ('虚拟货币 人民银行', 'zh', 'CN', False), ('香港 稳定币 牌照', 'zhhk', 'HK', False), ('가상자산 금융위', 'ko', 'KR', False), ('暗号資産 金融庁', 'ja', 'JP', False),
    ('site:home.treasury.gov digital assets OR crypto OR stablecoin', 'en', 'US', True), ('site:mas.gov.sg digital token OR crypto OR stablecoin', 'en', 'SG', True),
    ('site:fsc.go.kr virtual assets', 'en', 'KR', True), ('site:spk.gov.tr kripto', 'tr', 'TR', True), ('site:bcb.gov.br criptoativos OR "ativos virtuais"', 'pt', 'BR', True),
    ('site:cbn.gov.ng crypto OR "virtual assets" OR "digital assets"', 'en', 'NG', True), ('site:sec.gov.ng digital assets OR crypto', 'en', 'NG', True),
    ('site:cnv.gov.ar OR site:argentina.gob.ar/cnv activos virtuales OR PSAV', 'es', 'AR', True), ('site:bcra.gob.ar cripto OR "activos digitales"', 'es', 'AR', True),
    ('site:cbi.ir رمزارز', 'fa', 'IR', True), ('site:esma.europa.eu MiCA', 'en', 'EU', True), ('site:pbc.gov.cn 虚拟货币', 'zh', 'CN', True),
]

def parse_feed(xml, source, country, official):
    out = []
    blocks = re.findall(r'<item\b[\s\S]*?</item>', xml) or re.findall(r'<entry\b[\s\S]*?</entry>', xml)
    dec = lambda s: html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'<!\[CDATA\[([\s\S]*?)\]\]>', r'\1', s or ''))).strip()
    for it in blocks:
        def g(tag):
            m = re.search(rf'<{tag}\b[^>]*>([\s\S]*?)</{tag}>', it); return m.group(1) if m else None
        title = dec(g('title')); link = dec(g('link'))
        if not link:
            m = re.search(r'<link[^>]*href="([^"]+)"', it); link = m.group(1) if m else ''
        when = dec(g('pubDate')) or dec(g('dc:date')) or dec(g('updated')) or dec(g('published'))
        ts = None
        for fmt in ('%a, %d %b %Y %H:%M:%S %Z', '%a, %d %b %Y %H:%M:%S %z', '%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%d'):
            try:
                w = when.replace('GMT', 'UTC').replace(' UTC', '') if '%Z' in fmt else when
                d = dt.datetime.strptime(w, fmt.replace(' %Z', '')) if '%Z' in fmt else dt.datetime.strptime(w, fmt)
                ts = (d if d.tzinfo else d.replace(tzinfo=dt.UTC)).timestamp(); break
            except Exception: pass
        pub = dec(g('source')) or source
        desc = dec(g('description'))[:400] if 'news.google' not in link else ''
        if not title or not link: continue
        if 'news.google' in link and ' - ' in title: title = title.rsplit(' - ', 1)[0].strip()
        out.append({'title': title[:260], 'link': link, 'ts': ts, 'publisher': pub[:80], 'feed': source, 'country_hint': country, 'official': official, 'desc': desc})
    return out

def gnews(q, lang='en', when=None):
    hl, gl, ceid = ED[lang]
    qq = q + (f' when:{when}' if when and 'after:' not in q else '')
    url = 'https://news.google.com/rss/search?' + urllib.parse.urlencode({'q': qq, 'hl': hl, 'gl': gl, 'ceid': ceid})
    return http(url, timeout=20)

# ======================================================================================================
# 2. CLASSIFICATION (multilingual keyword lexicon; transparent rules)
# ======================================================================================================
CRYPTO = re.compile(r"crypto|bitcoin|\bbtc\b|\bether(eum)?\b|stablecoin|stable coin|digital asset|virtual asset|virtual currenc|digital currenc|\btokens?\b|tokeni[sz]|blockchain|\bdefi\b|\bvasps?\b|\bcasps?\b|\bmica\b|binance|coinbase|tether|\busdt\b|\busdc\b|nobitex|kraken|\bokx\b|bybit|\bnfts?\b|\bcbdc|"
                    r"cripto|criptomoned|criptoactiv|criptoativ|activos? virtual|ativos? virtua|activos digitales|\bpsav\b|kripto|رمزارز|ارز دیجیتال|ارزهای دیجیتال|تتر|بیت.?کوین|نوبیتکس|استیبل|"
                    r"加密|虚拟货币|虛擬貨幣|虚拟资产|虛擬資產|稳定币|穩定幣|比特币|比特幣|가상자산|암호화폐|스테이블|暗号資産|仮想通貨|ステーブル|ビットコイン", re.I)
COUNTRIES = [  # (code, name, regex) - first match wins; US checked last (its regulators are named in many foreign stories)
    ('NG', 'Nigeria', r'nigeria|naira|(?-i:\bCBN\b)|lagos|abuja|tinubu|\bngn\b'), ('AR', 'Argentina', r'argentin|milei|\bbcra\b|(?-i:\bCNV\b)|caputo|\bcepo\b|buenos aires'),
    ('IR', 'Iran', r'\biran|tehran|nobitex|\brials?\b|ایران|ریال|نوبیتکس|بانک مرکزی|تهران|\birgc\b|wallex'), ('TR', 'Turkey', r'turkey|türkiye|turkiye|turkish|(?-i:\bSPK\b)|\blira\b|\btürk|kripto'),
    ('BR', 'Brazil', r'brazil|brasil|banco central do brasil|(?-i:\bBCB\b)|receita federal|(?-i:\bCVM\b)|\blula\b|\bdrex\b'),
    ('CN', 'China', r'\bchina|chinese|beijing|\bpboc\b|people.s bank|中国|人民银行|央行|内地|大陆|北京|shanghai'), ('HK', 'Hong Kong', r'hong kong|\bhkma\b|(?-i:\bSFC\b)|香港|證監會|金管局'),
    ('SG', 'Singapore', r'singapore|(?-i:\bMAS\b)'), ('JP', 'Japan', r'japan|(?-i:\bFSA\b)|金融庁|日本'), ('KR', 'South Korea', r'korea|(?-i:\bFSC\b)|seoul|금융위|한국|원화|가상자산'),
    ('IN', 'India', r'\bindia|(?-i:\bRBI\b)|\bsebi\b|rupee|new delhi'), ('RU', 'Russia', r'russia|kremlin|putin|\bduma\b|ruble|rouble'), ('AE', 'UAE', r'\buae\b|dubai|abu dhabi|emirates|(?-i:\bVARA\b)'),
    ('TH', 'Thailand', r'thailand|\bthai\b'), ('PK', 'Pakistan', r'pakistan'), ('VN', 'Vietnam', r'vietnam'), ('AU', 'Australia', r'australia|(?-i:\bASIC\b)'), ('CA', 'Canada', r'canada|canadian'),
    ('ZA', 'South Africa', r'south africa|(?-i:\bFSCA\b)'), ('KE', 'Kenya', r'kenya'),
    ('EU', 'European Union', r'(?-i:\bEU\b)|european|\bmica\b|(?-i:\bESMA\b)|(?-i:\bEBA\b)|brussels|euro area|(?-i:\bECB\b)|lagarde|france|french|germany|german|italy|spain|netherlands|dutch|(?-i:\bAMF\b)|bafin|consob|ireland|luxembourg|malta'),
    ('UK', 'United Kingdom', r'(?-i:\bUK\b)|britain|british|(?-i:\bFCA\b)|bank of england|london|hm treasury'),
    ('US', 'United States', r'(?-i:\bU\.?S\.?\b)|united states|(?<!latin )\bamerica|(?-i:\bSEC\b)|\bcftc\b|\bofac\b|treasury|congress|senate|(?-i:\bHouse\b)|federal reserve|(?-i:\bFed\b)|white house|trump|clarity act|genius act|fincen|(?-i:\bOCC\b)|(?-i:\bFDIC\b)|bessent|atkins|lummis|(?-i:\bDOJ\b)|justice department|new york|(?-i:\bNY\b)|attorney general|california|texas|florida|wyoming'),
]
TYPE_RULES = [
    ('etf', r'\betfs?\b|\betps?\b|exchange.traded|19b-4|\bs-1\b|spot (bitcoin|ether|sol\w*|xrp) fund|listing standard'),
    ('capital_control', r'capital control|currency control|exchange control|\bcepo\b|fx (control|restriction)|foreign.exchange (rule|restriction|curb)|outflow|dollar purchase|repatriat|controle cambial|restricci[oó]n cambiaria|کنترل ارز|curbs? on (dollar|forex)|rial hits'),
    ('sanctions', r'sanction|\bofac\b|\bsdn\b|blacklist|designat|تحریم|asset freeze|freezes? \$'),
    ('ban', r'\bbans?\b|banned|banning|tighten|toughen|stricter|endurece|prohibit|outlaw|crackdown|crack down|block(s|ed)? (access|crypto|website)|shut(s|ting)? down|\bhalts?\b|suspend|restrict|\bcurbs?\b|prohib|bloque|proíb|proibi|yasak|禁止|取缔|整治|打击|금지|ممنوع|مسدود|توقف|محدودیت|فیلتر'),
    ('enforcement', r'\bcharg|\bsues?\b|\bsued\b|lawsuit|\bfined?\b|penalt|settle|arrest|detain|indict|convict|seiz|raid|\bprobe\b|investigat|wells notice|enforcement|prosecut|guilty|\bmulta|sanci[oó]n|denuncia|prisão|investiga|دستگیر|بازداشت|gözaltı|soruşturma|起诉|逮捕|処分|검찰|\bhack|exploit|stolen'),
    ('stablecoin', r'stablecoin|stable coin|genius act|\busdt\b|\busdc\b|tether|e-money token|\bemt\b|稳定币|穩定幣|스테이블코인|ステーブルコイン|استیبل|تتر'),
    ('tax', r'\btax|\blevy|\bvat\b|impuesto|tribut|imposto|receita federal|vergi|税|세금|과세|مالیات'),
    ('licensing', r'licen[cs]|registration|register|authori[sz]|\bvasp|\bcasp|sandbox|incubation|regulatory (framework|regime)|\brules\b|regulat|framework|guideline|regras|normas|reglament|regula|licencia|licença|registro|lisans|牌照|许可|執照|인가|등록|登録|مجوز|\bpsav'),
    ('easing', r'lift(s|ed|ing)? (the |its )?(ban|restriction|control)|\b(eases?|easing|relax\w*)\s+(\w+\s+){0,3}(rules?|restrictions?|bans?|controls?|requirements?|regulations?|curbs?|limits?)|legali[sz]|approv|greenlight|green light|drop(s|ped)? (case|lawsuit|probe|investigation|charges)|dismiss|ends? (probe|investigation|case)|repeal|rescind|strategic bitcoin reserve|opens? up|embrace|levanta|flexibiliz|aprueba|aprova|legaliza|批准|승인|承認'),
    ('legislation', r'\bbill\b|\bact\b|\blaw\b|legislat|parliament|congress|senate|house (vote|pass)|decree|executive order|\bley\b|proyecto de ley|\blei\b|projeto de lei|kanun|法案|法例|법안|法律|قانون|مجلس'),
    ('cbdc', r'\bcbdc|digital (yuan|euro|rupee|naira|pound)|e-cny|\bdrex\b|数字人民币'),
]
TYPE_LABEL = {'ban': 'ban/restriction', 'capital_control': 'capital control', 'licensing': 'licensing', 'tax': 'tax', 'etf': 'ETF/product approval', 'enforcement': 'enforcement',
              'stablecoin': 'stablecoin rules', 'easing': 'easing', 'sanctions': 'sanctions', 'legislation': 'legislation', 'cbdc': 'CBDC', 'other': 'other'}
PRIO = ['etf', 'capital_control', 'sanctions', 'ban', 'enforcement', 'stablecoin', 'tax', 'easing', 'licensing', 'legislation', 'cbdc']
HAWK = re.compile(r'\bbans?\b|banned|prohibit|outlaw|crackdown|crack down|restrict|\bcurbs?\b|\bblock|shut|\bhalt|suspend|freez|seiz|\bcharg|\bsues?\b|\bsued\b|lawsuit|\bfine[sd]?\b|penalt|arrest|detain|indict|sanction|tighten|stricter|tough|\bwarn|delist|\bfails?\b|failed|stall|reject|denie[sd]|\bdeny|delay|crime|illicit|launder|capital floor|tax (hike|notice|evasion)|\bprobe\b|investigat|\bhack|stolen|'
                  r'prohíb|prohibi|restricci|\bmulta|denuncia|proíb|proibi|endurece|yasak|ceza|禁止|打击|取缔|整治|금지|규제 강화|ممنوع|مسدود|توقف|محدودیت|تحریم|دستگیر', re.I)
DOVE = re.compile(r'approv|legali[sz]|licen[cs]e[sd]? (granted|approved)|\bgrants?\b|granted|\blift|\b(eases?|easing|relax\w*)\s+(\w+\s+){0,3}(rules?|restrictions?|bans?|controls?|requirements?|regulations?|curbs?)|dismiss|drop(s|ped)? (case|lawsuit|probe|charges)|\bpasse[sd]\b|\bsigns?\b|\bsigned|strategic (bitcoin )?reserve|embrace|opens? up|first licen|green ?light|\bclarity\b|welcome|launch(es|ed)? (spot|etf)|exempt|safe harbou?r|rescind|repeal|'
                  r'aprueba|aprova|legaliza|levanta|flexibiliz|批准|승인|허용|承認', re.I)
STRONG = re.compile(r'approves|approved|signed into law|signs .*(law|order|bill|act)|nationwide|total ban|outright ban|full ban|arrest|criminal|emergency|delist|seiz|shut(s)? down|\bpasses\b|\bpassed\b|\bfails\b|\bfailed\b|first licen|takes effect|comes into force|freezes|sanctions .*exchange', re.I)
BIG = {'US', 'CN', 'EU'}

REG = re.compile(r'regulat|\brules?\b|\blaws?\b|\bact\b|\bbill\b|(?-i:\bSEC\b)|cftc|ofac|treasury|central bank|government|ministry|minister|parliament|congress|senate|court|judge|licen[cs]|\btax|sanction|authorit|commission|(?-i:\bFSA\b|\bFCA\b|\bESMA\b|\bEBA\b|\bMAS\b|\bRBI\b|\bCBN\b|\bBCRA\b|\bCNV\b|\bBCB\b|\bSPK\b|\bSFC\b|\bFSC\b|\bOCC\b|\bFDIC\b|\bDOJ\b)|\bmica\b|pboc|hkma|policy|legal|compliance|enforce|police|prosecut|seiz|approv|\betfs?\b|\betps?\b|cbdc|capital control|currency control|exchange control|controls|\bcepo\b|decree|executive order|crackdown|prohibit|restrict|lawsuit|\bsues?\b|charged|arrest|federal reserve|fincen|irgc|white house|lawmaker|legislat|regime|framework|guidance|supervis|'
                 r'regulaci|\bley\b|gobierno|banco central|regulaç|\blei\b|governo|receita|düzenleme|yasa|hükümet|vergi|مقررات|قانون|دولت|بانک مرکزی|ممنوع|监管|政府|央行|禁止|규제|정부|금융위|規制|金融庁|政府', re.I)
LOCAL = re.compile(r'city council|county|\btown\b|kiosk|\batms?\b|school board|village', re.I)
NOT_ACTION = re.compile(r'\b(despite|amid|even as|although|regardless of|but)\b[^,.;:|!?]*|\b(ban|crackdown|restrictions?) (remains?|intact|still)\b|\b\w+ banned crypto\b', re.I)
PERSONAL = re.compile(r'lifetime (crypto |industry )?ban|banned for life|bans? \w+( \w+){0,3} (founder|ceo|executive|from (the )?crypto)|ban(ned)? from (the )?(crypto|securities)|(crypto|industry) ban (from|for) ', re.I)
SPEC = re.compile(r'\bseeks?\b|\bawait|pending|\bcould\b|\bmay\b|\bplans? to\b|propos|consider|\bdraft|\bweigh|odds|expects?|likely|\bsays\b.*\bwill\b|what .* means', re.I)

def classify(text, country_hint=None, official=False):
    t0 = text or ''
    country = None
    for code, name, rx in COUNTRIES[:-1]:
        if re.search(rx, t0, re.I): country = code; break
    if not country and re.search(COUNTRIES[-1][2], t0, re.I): country = 'US'
    if not country: country = country_hint or 'GLOBAL'
    text_country = country if country != (country_hint or 'GLOBAL') or any(re.search(rx, t0, re.I) for c2, _, rx in COUNTRIES if c2 == country) else None
    policy = (bool(REG.search(t0)) or official or bool(text_country)) and not re.search(r'punters|betting odds|\bodds of\b|prediction market traders', t0, re.I)
    t = NOT_ACTION.sub(' ', t0)   # 'despite the ban' / 'amid crackdown' describe context, not a new action
    types = [k for k, rx in TYPE_RULES if re.search(rx, t, re.I)]
    if PERSONAL.search(t0):   # an individual barred from the industry is enforcement, not a jurisdiction-wide ban
        types = ['enforcement'] + [x for x in types if x not in ('ban', 'enforcement')]
    primary = next((p for p in PRIO if p in types), 'other')
    h = len(HAWK.findall(t)); d = len(DOVE.findall(t))
    if primary in ('ban', 'capital_control', 'sanctions', 'enforcement'): h += 1
    if primary == 'easing': d += 1
    if re.search(r'\b(lift|ease|eases|eased|relax|remov|scrap|end|levanta|flexibiliz)\w*\s+(\w+\s+){0,3}(ban|control|restriction|cepo|curb)', t, re.I): d += 2
    score = d - h
    direction = 'dovish' if score > 0 else 'hawkish' if score < 0 else 'neutral'
    base = {'ban': 3, 'capital_control': 3, 'sanctions': 2, 'enforcement': 2, 'etf': 2, 'stablecoin': 2, 'legislation': 2, 'easing': 2, 'licensing': 1, 'tax': 1, 'cbdc': 1, 'other': 0}[primary]
    spec = bool(SPEC.search(t0))
    sev = base + (1 if country in BIG else 0) + (1 if STRONG.search(t) and not spec else 0) + (1 if official else 0) - (1 if LOCAL.search(t0) else 0)
    if not policy: sev = min(sev, 1)
    return {'country': country, 'types': types, 'type': primary, 'type_label': TYPE_LABEL[primary], 'direction': direction, 'dir_score': score, 'sev_raw': sev, 'policy': policy}

STOP = set('the a an of to in on for and or with by at from as is are be its it this that new says said after over into amid could would will may crypto cryptocurrency de la el en y los las do da para com'.split())
def norm_tokens(title):
    t = re.sub(r'[^\w\s]', ' ', title.lower())
    return set(w for w in t.split() if w not in STOP and len(w) > 1)

def cluster_items(items, hours=72, jac=0.5):
    items = sorted([x for x in items if x.get('ts')], key=lambda x: x['ts'])
    clusters = []
    for it in items:
        tok = norm_tokens(it['title']); best = None
        for c in clusters[-500:]:
            if abs(it['ts'] - c['ts_last']) > hours * 3600: continue
            inter = len(tok & c['tok0']); uni = len(tok | c['tok0']) or 1; mn = min(len(tok), len(c['tok0'])) or 1
            if inter / uni >= jac or (inter >= 3 and inter / mn >= 0.5) or it['title'].lower() == c['title'].lower(): best = c; break
        if best:
            best['items'].append(it); best['ts_last'] = max(best['ts_last'], it['ts'])
        else:
            clusters.append({'title': it['title'], 'tok0': tok, 'ts': it['ts'], 'ts_last': it['ts'], 'items': [it]})
    out = []
    for c in clusters:
        its = c['items']; pubs = sorted(set(i['publisher'] for i in its))
        official = any(i['official'] for i in its)
        lead = next((i for i in its if i['official']), its[0])
        hint = next((i['country_hint'] for i in its if i['country_hint']), None)
        cl = classify(lead['title'] + ' ' + lead.get('desc', ''), hint, official)
        sev = max(1, min(5, cl['sev_raw'] + (1 if len(pubs) >= 3 else 0)))
        cid = hashlib.sha1(re.sub(r'\W+', '', lead['title'].lower()).encode()).hexdigest()[:12]
        out.append({'id': cid, 'title': lead['title'], 'link': lead['link'], 'ts': int(c['ts']), 'date': iso(c['ts']), 'publisher': lead['publisher'], 'official': official,
                    'n_sources': len(pubs), 'sources': pubs[:8], 'links': [{'publisher': i['publisher'], 'link': i['link']} for i in its[:5]], 'feeds': sorted(set(i['feed'] for i in its))[:6],
                    'country': cl['country'], 'type': cl['type'], 'type_label': cl['type_label'], 'types': cl['types'], 'direction': cl['direction'], 'severity': sev, 'policy': cl['policy'], '_tok': sorted(c['tok0'])})
    return out

# ======================================================================================================
# 3. LIVE INGESTION, DOSSIERS, ALERTS
# ======================================================================================================
DOSSIERS = [
    {'key': 'us_market_structure', 'name': 'US market-structure bill (CLARITY Act)', 'country': 'US', 'rx': r'clarity act|market.structure|digital asset market', 'query': ('CLARITY Act crypto market structure Senate', 'en')},
    {'key': 'us_stablecoin', 'name': 'US stablecoin rules (GENIUS Act implementation)', 'country': 'US', 'rx': r'genius act|genius|stablecoin (rule|issuer|regulation)|payment stablecoin', 'query': ('GENIUS Act stablecoin rule Treasury OCC FDIC', 'en')},
    {'key': 'us_etf', 'name': 'US crypto ETF/ETP approvals (SEC)', 'country': 'US', 'rx': r'\betfs?\b|\betps?\b|19b-4|listing standard', 'query': ('SEC crypto ETF approval', 'en')},
    {'key': 'eu_mica', 'name': 'EU MiCA (CASP licensing after the transitional period; stablecoins)', 'country': 'EU', 'rx': r'\bmica\b|\bcasps?\b|\besma\b|\beba\b', 'query': ('MiCA CASP licence ESMA', 'en')},
    {'key': 'cn_hk', 'name': 'China ban / Hong Kong licensing & stablecoins', 'country': 'CN/HK', 'rx': r'china|pboc|hong kong|hkma|\bsfc\b|中国|香港|人民银行|稳定币|穩定幣', 'query': ('Hong Kong China crypto stablecoin regulation', 'en')},
    {'key': 'iran', 'name': 'Iran: exchange restrictions, CBI, US sanctions on Iranian crypto', 'country': 'IR', 'rx': r'iran|nobitex|ایران|نوبیتکس|رمزارز', 'query': ('Iran crypto exchange sanctions', 'en')},
    {'key': 'nigeria', 'name': 'Nigeria: SEC VASP regime, ISA 2025, CBN', 'country': 'NG', 'rx': r'nigeria|naira|\bcbn\b', 'query': ('Nigeria SEC crypto VASP', 'en')},
    {'key': 'argentina', 'name': 'Argentina: FX regime / cepo, CNV PSAV rules', 'country': 'AR', 'rx': r'argentin|\bcepo\b|\bcnv\b|bcra|milei', 'query': ('Argentina crypto CNV cepo', 'en')},
]

def ingest(when='7d'):
    raw, status = [], {}
    for name, url, ctry, ua in REG_FEEDS:
        def f(name=name, url=url, ctry=ctry, ua=ua):
            items = parse_feed(http(url, ua=ua, timeout=25), name, ctry, True)
            keep = [x for x in items if CRYPTO.search(x['title'] + ' ' + x['desc'])]
            status[name] = f'ok ({len(items)} items, {len(keep)} crypto-related)'
            return keep
        raw += safe('feed:' + name, f, []) or []
        if 'feed:' + name in ERRORS: status[name] = 'failed: ' + ERRORS['feed:' + name]
    qs = list(GN_QUERIES) + [(d['query'][0], d['query'][1], d['country'] if len(d['country']) == 2 else None, False) for d in DOSSIERS]
    for q, lang, ctry, official in qs:
        def f(q=q, lang=lang, ctry=ctry, official=official):
            items = parse_feed(gnews(q, lang, when='30d' if official else when), f'GN:{lang}', ctry, official)
            keep = [x for x in items if official or CRYPTO.search(x['title'])]
            status[f'GN[{lang}] {q}'] = f'ok ({len(items)} items, {len(keep)} kept)'
            for x in keep: x['query'] = q
            return keep
        raw += safe(f'gn:{q}', f, []) or []
        if f'gn:{q}' in ERRORS: status[f'GN[{lang}] {q}'] = 'failed: ' + ERRORS[f'gn:{q}']
    now = time.time()
    raw = [x for x in raw if x['ts'] and x['ts'] <= now + 3600 and (x['ts'] > now - 8 * 86400 or (x['official'] and x['ts'] > now - 31 * 86400))]
    return raw, status

def alerts_update(clusters):
    seen = load_json(SEEN_F, {'ids': {}, 'toks': []})
    first_run = not seen['ids']
    alerts = load_json(ALERTS_F, [])
    seen_toks = [set(t) for t in seen.get('toks', [])[-3000:]]
    new_alerts = []
    for c in sorted(clusters, key=lambda x: x['ts']):
        tok = set(c['_tok'])
        is_new = c['id'] not in seen['ids'] and not any(len(tok & s) / (len(tok | s) or 1) >= 0.6 for s in seen_toks)
        c['new'] = bool(is_new and not first_run)
        if c['id'] not in seen['ids']:
            seen['ids'][c['id']] = int(time.time()); seen_toks.append(tok); seen.setdefault('toks', []).append(sorted(tok))
        if is_new and c['severity'] >= 4:
            new_alerts.append({'t': int(time.time()), 'id': c['id'], 'date': c['date'], 'title': c['title'], 'country': c['country'], 'type': c['type_label'], 'direction': c['direction'],
                               'severity': c['severity'], 'n_sources': c['n_sources'], 'link': c['link'], 'initial_baseline': first_run})
    alerts = (alerts + new_alerts)[-300:]
    seen['toks'] = seen['toks'][-3000:]
    if len(seen['ids']) > 20000: seen['ids'] = dict(sorted(seen['ids'].items(), key=lambda kv: kv[1])[-15000:])
    with open(SEEN_F, 'w') as fh: json.dump(seen, fh)
    with open(ALERTS_F, 'w') as fh: json.dump(alerts, fh)
    return new_alerts, alerts, first_run

# ======================================================================================================
# 4. FLOW PROXIES (live snapshot + daily history)
# ======================================================================================================
def binance_p2p(fiat, side='BUY'):
    body = json.dumps({'asset': 'USDT', 'fiat': fiat, 'tradeType': side, 'page': 1, 'rows': 10, 'payTypes': [], 'publisherType': None}).encode()
    d = json.loads(http('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', data=body, headers={'content-type': 'application/json'}, timeout=20))
    px = [float(x['adv']['price']) for x in (d.get('data') or [])]
    return {'n_ads': len(px), 'median': st.median(px) if px else None, 'best': (min(px) if side == 'BUY' else max(px)) if px else None}

def flows_live():
    out = {}
    er = safe('er-api', lambda: jget('https://open.er-api.com/v6/latest/USD')['rates'], {}) or {}
    def ar():
        r = {}
        casas = {x['casa']: x for x in jget('https://dolarapi.com/v1/dolares')}
        of = casas.get('oficial', {}).get('venta'); r['oficial'] = of; r['blue'] = casas.get('blue', {}).get('venta'); r['cripto'] = casas.get('cripto', {}).get('venta'); r['mep'] = casas.get('bolsa', {}).get('venta')
        r['dolarapi_updated'] = casas.get('oficial', {}).get('fechaActualizacion')
        b = safe('bitso', lambda: jget('https://api.bitso.com/v3/ticker/?book=usdt_ars')['payload'])
        if b: r['bitso_usdt'] = {'last': float(b['last']), 'vol24_usdt': float(b['volume'])}
        cy = safe('criptoya', lambda: jget('https://criptoya.com/api/usdt/ars/1'))
        if cy: r['criptoya_usdt_ask'] = {k: v.get('totalAsk') for k, v in cy.items() if isinstance(v, dict) and v.get('totalAsk') and time.time() - (v.get('time') or 0) < 3 * 86400}
        p = safe('p2p:ARS', lambda: binance_p2p('ARS'))
        if p: r['binance_p2p_buy'] = p
        bk = safe('binance:USDTARS', lambda: jget('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=USDTARS'))
        if bk: r['binance_spot'] = {'last': float(bk['lastPrice']), 'vol24_usdt': float(bk['volume'])}
        ref = (r.get('binance_spot') or {}).get('last') or (r.get('bitso_usdt') or {}).get('last') or r.get('cripto')
        if of and ref: r['premium_usdt_vs_oficial'] = ref / of - 1
        if of and r.get('blue'): r['premium_blue_vs_oficial'] = r['blue'] / of - 1
        if (r.get('binance_p2p_buy') or {}).get('median') and of: r['premium_p2p_vs_oficial'] = r['binance_p2p_buy']['median'] / of - 1
        r['sources'] = 'dolarapi.com (oficial/blue/cripto/MEP), Bitso, CriptoYa (Lemon, Ripio, Buenbit...), Binance P2P public search, Binance spot USDT/ARS'
        return r
    out['AR'] = safe('flows:AR', ar, {})
    def ng():
        r = {}
        l = safe('luno', lambda: jget('https://api.luno.com/api/1/ticker?pair=USDTNGN'))
        if l: r['luno_usdt'] = {'last': float(l['last_trade']), 'vol24_usdt': float(l['rolling_24_hour_volume'])}
        q = safe('quidax', lambda: jget('https://app.quidax.io/api/v1/markets/tickers/usdtngn')['data']['ticker'])
        if q: r['quidax_usdt'] = {'last': float(q['last']), 'vol24_usdt': float(q['vol'])}
        p = safe('p2p:NGN', lambda: binance_p2p('NGN'))
        if p is not None: r['binance_p2p_buy'] = p if p['n_ads'] else {'n_ads': 0, 'note': 'no NGN ads returned by the public search endpoint'}
        r['official_ref'] = er.get('NGN')
        ref = (r.get('quidax_usdt') or r.get('luno_usdt') or {}).get('last')
        if ref and r['official_ref']: r['premium_usdt_vs_ref'] = ref / r['official_ref'] - 1
        r['sources'] = 'Luno + Quidax public tickers, Binance P2P public search, open.er-api.com reference rate'
        return r
    out['NG'] = safe('flows:NG', ng, {})
    def ir():
        r = {}
        s = jget('https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt,btc&dstCurrency=rls')['stats']
        u = s.get('usdt-rls') or {}
        if u: r['nobitex_usdt'] = {'last_toman': float(u['latest']) / 10, 'day_change_pct': float(u.get('dayChange') or 0), 'vol24_usdt': float(u['volumeSrc']), 'vol24_toman': float(u['volumeDst']) / 10}
        b = s.get('btc-rls') or {}
        if b: r['nobitex_btc'] = {'last_toman': float(b['latest']) / 10, 'vol24_btc': float(b['volumeSrc'])}
        r['official_ref_rial'] = er.get('IRR')
        r['note'] = 'The official IRR reference is not a market rate; Nobitex USDT/toman is the free-market proxy, so a premium vs official is not meaningful.'
        r['sources'] = 'Nobitex public market stats (apiv2.nobitex.ir)'
        return r
    out['IR'] = safe('flows:IR', ir, {})
    for code, sym, cur in (('TR', 'USDTTRY', 'TRY'), ('BR', 'USDTBRL', 'BRL')):
        def f(sym=sym, cur=cur):
            bk = jget(f'https://data-api.binance.vision/api/v3/ticker/24hr?symbol={sym}')
            r = {'binance_spot': {'last': float(bk['lastPrice']), 'vol24_usdt': float(bk['volume'])}, 'official_ref': er.get(cur)}
            if r['official_ref']: r['premium_usdt_vs_ref'] = r['binance_spot']['last'] / r['official_ref'] - 1
            r['sources'] = f'Binance spot {sym} (public), open.er-api.com reference'
            return r
        out[code] = safe('flows:' + code, f, {})
    s = load_json(os.path.join(DATA_DIR, 'stables.json'), None)
    if s and 'tron:USDT' in s.get('pairs', {}):
        p = s['pairs']['tron:USDT']
        out['TRON_USDT'] = {k: p.get(k) for k in ('supply', 'asof', 'net_1d', 'net_7d', 'net_30d', 'spike_today', 'spikes_90d')}
        out['TRON_USDT']['source'] = 'data/stables.json (stables module; DefiLlama)'
    out['ref_source'] = 'open.er-api.com (exchangerate-api free tier, daily)'
    return out

# ---- daily history series (date -> value) ----
def h_argentina():
    def f():
        g = lambda c: {x['fecha']: x['venta'] for x in jget(f'https://api.argentinadatos.com/v1/cotizaciones/dolares/{c}')}
        return {'cripto': g('cripto'), 'oficial': g('oficial'), 'blue': g('blue')}
    d = cache_get('ar_hist', 12 * 3600, f)
    prem = {k: d['cripto'][k] / v - 1 for k, v in d['oficial'].items() if k in d['cripto'] and v}
    blue = {k: d['blue'][k] / v - 1 for k, v in d['oficial'].items() if k in d['blue'] and v}
    return {'ar_premium_cripto': prem, 'ar_premium_blue': blue}

def binance_daily(sym, start='2023-06-01'):
    def f():
        out, t = {}, int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.UTC).timestamp() * 1000)
        while True:
            k = jget(f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1d&startTime={t}&limit=1000')
            if not k: break
            for r in k: out[iso(r[0] / 1000)] = [float(r[4]), float(r[5]), float(r[7])]
            if len(k) < 1000: break
            t = k[-1][0] + 86400000
        return out
    return cache_get('bn_' + sym, 6 * 3600, f)

def quidax_daily():
    def f():
        k = jget('https://app.quidax.io/api/v1/markets/usdtngn/k?period=1440&limit=1200&time_from=1693526400')['data']
        return {iso(r[0]): [r[4], r[5]] for r in k}
    return cache_get('quidax_usdtngn', 6 * 3600, f)

def coinbase_daily(product, start='2023-06-01'):
    def f():
        out, t = {}, dt.datetime.fromisoformat(start)
        end = dt.datetime.now(dt.UTC).replace(tzinfo=None)
        while t < end:
            t2 = min(t + dt.timedelta(days=290), end)
            for ts, lo, hi, op, cl, vol in jget(f'https://api.exchange.coinbase.com/products/{product}/candles?granularity=86400&start={t.isoformat()}Z&end={t2.isoformat()}Z', ua='asymmetric-terminal research'):
                out[iso(ts)] = cl
            t = t2
        return out
    return cache_get('cb_' + product, 6 * 3600, f)

def nobitex_daily(sym='BTCIRT', start='2023-06-01'):
    def f():
        out = {}
        t0 = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.UTC).timestamp()); now = int(time.time())
        while t0 < now:
            t1 = min(t0 + 300 * 86400, now)
            d = jget(f'https://apiv2.nobitex.ir/market/udf/history?symbol={sym}&resolution=D&from={t0}&to={t1}')
            if d.get('s') == 'ok':
                for i, ts in enumerate(d['t']): out[iso(ts + 4 * 3600)] = [d['c'][i], d['v'][i] if d.get('v') else None]   # Tehran-day bars start ~20:30 UTC
            t0 = t1
        return out
    return cache_get('nobitex_' + sym, 6 * 3600, f)

def frankfurter(cur, start='2023-06-01'):
    def f():
        d = jget(f'https://api.frankfurter.dev/v1/{start}..?base=USD&symbols={cur}')
        return {k: v[cur] for k, v in d['rates'].items()}
    return cache_get('fx_' + cur, 12 * 3600, f)

def fawaz_rate(date, cur):
    def f():
        for host in ('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{d}/v1/currencies/usd.min.json', 'https://{d}.currency-api.pages.dev/v1/currencies/usd.min.json'):
            try:
                j = jget(host.format(d=date)); return {k: j['usd'].get(k) for k in ('ngn', 'irr', 'ars', 'try', 'brl')}
            except Exception: continue
        return None
    r = cache_get('fawaz_' + date, None if date < TODAY.isoformat() else 3600, f)
    return (r or {}).get(cur)

def defillama_tron_usdt():
    def f():
        d = jget('https://stablecoins.llama.fi/stablecoincharts/Tron?stablecoin=1')
        return {iso(int(x['date'])): (x.get('totalCirculating') or {}).get('peggedUSD') for x in d}
    c = cache_get('llama_tron_usdt', 6 * 3600, f)
    ks = sorted(c); return {ks[i]: c[ks[i]] - c[ks[i - 1]] for i in range(1, len(ks)) if c[ks[i]] is not None and c[ks[i - 1]] is not None}

_trends_dead = [False]
TRENDS_CALLS = [0]
def gtrends(geo, kws, start, end):
    """Google Trends daily interest (0-100, relative within the request) via pytrends (unofficial). Cached; stops after a 429."""
    key = f'trends_{geo}_{"+".join(kws)}_{start}_{end}'
    immutable = end < (TODAY - dt.timedelta(days=4)).isoformat()
    f = os.path.join(CACHE, re.sub(r'[^\w.+-]+', '_', key) + '.json')
    if os.path.exists(f) and (immutable or time.time() - os.path.getmtime(f) < 12 * 3600):
        return load_json(f, None)
    if _trends_dead[0]: return None
    try:
        from pytrends.request import TrendReq
        time.sleep(5 + random.random() * 4); TRENDS_CALLS[0] += 1
        tr = TrendReq(hl='en-US', tz=0, timeout=(10, 25))
        tr.build_payload(kws, timeframe=f'{start} {end}', geo=geo)
        df = tr.interest_over_time()
        res = {'empty': True} if df is None or df.empty else {kw: {d.strftime('%Y-%m-%d'): int(v) for d, v in df[kw].items()} for kw in kws}
        with open(f, 'w') as fh: json.dump(res, fh)
        return res
    except Exception as e:
        if '429' in str(e): _trends_dead[0] = True
        ERRORS['trends'] = f'{type(e).__name__}: {str(e)[:120]}'
        return None

def history_series():
    S, src = {}, {}
    S.update(safe('hist:AR', h_argentina, {}) or {})
    src['ar_premium_cripto'] = 'argentinadatos.com dólar cripto (venta) / oficial (venta) - 1'; src['ar_premium_blue'] = 'argentinadatos.com blue / oficial - 1'
    bn = {sym: safe('hist:' + sym, lambda sym=sym: binance_daily(sym), {}) or {} for sym in ('USDTARS', 'USDTTRY', 'USDTBRL')}
    S['ar_usdt_vol'] = {k: v[1] for k, v in bn['USDTARS'].items()}; src['ar_usdt_vol'] = 'Binance USDT/ARS daily volume (USDT)'
    for sym, cur, cc in (('USDTTRY', 'TRY', 'tr'), ('USDTBRL', 'BRL', 'br')):
        fx = safe('hist:fx' + cur, lambda cur=cur: frankfurter(cur), {}) or {}
        days = sorted(fx); prem = {}
        for d, v in bn[sym].items():
            ref = fx.get(d)
            if ref is None and days:
                prev = [x for x in days if x < d][-1:]
                ref = fx[prev[0]] if prev and (dt.date.fromisoformat(d) - dt.date.fromisoformat(prev[0])).days <= 4 else None
            if ref: prem[d] = v[0] / ref - 1
        S[f'{cc}_premium'] = prem; src[f'{cc}_premium'] = f'Binance {sym} close / ECB reference via frankfurter.dev (prior business day on weekends) - 1'
        S[f'{cc}_usdt_vol'] = {k: v[1] for k, v in bn[sym].items()}; src[f'{cc}_usdt_vol'] = f'Binance {sym} daily volume (USDT)'
    q = safe('hist:quidax', quidax_daily, {}) or {}
    S['ng_usdt_rate'] = {k: v[0] for k, v in q.items()}; S['ng_usdt_vol'] = {k: v[1] for k, v in q.items()}
    src['ng_usdt_rate'] = 'Quidax USDT/NGN daily close'; src['ng_usdt_vol'] = 'Quidax USDT/NGN daily volume (USDT)'
    src['ng_premium'] = 'Quidax USDT/NGN close / fawazahmed0 currency-api USD/NGN (official-reference aggregate, from Mar 2024) - 1'
    nb = safe('hist:nobitex', nobitex_daily, {}) or {}
    btc = safe('hist:cb_btc', lambda: coinbase_daily('BTC-USD'), {}) or {}
    S['ir_implied_usd_toman'] = {k: v[0] / 10 / btc[k] for k, v in nb.items() if btc.get(k) and v[0]}
    S['ir_btc_vol'] = {k: v[1] for k, v in nb.items() if v[1] is not None}
    src['ir_implied_usd_toman'] = 'Nobitex BTC/IRT daily close / Coinbase BTC-USD close (implied free-market toman per USD)'; src['ir_btc_vol'] = 'Nobitex BTC/IRT daily volume (BTC)'
    S['tron_usdt_net'] = safe('hist:tron', defillama_tron_usdt, {}) or {}; src['tron_usdt_net'] = 'DefiLlama stablecoins: Tron USDT circulating, daily change (USD)'
    return S, src

KIND = {'ar_premium_cripto': 'level_pp', 'ar_premium_blue': 'level_pp', 'tr_premium': 'level_pp', 'br_premium': 'level_pp', 'ng_premium': 'level_pp',
        'ng_usdt_rate': 'level_pct', 'ir_implied_usd_toman': 'level_pct', 'ar_usdt_vol': 'ratio', 'tr_usdt_vol': 'ratio', 'br_usdt_vol': 'ratio', 'ng_usdt_vol': 'ratio', 'ir_btc_vol': 'ratio', 'tron_usdt_net': 'sum'}
UNIT = {'level_pp': 'pp change in premium (mean d0..+7 minus mean d-7..-1)', 'level_pct': '% change (mean d0..+7 vs mean d-7..-1)', 'ratio': 'ratio mean d0..+7 / mean d-7..-1', 'sum': 'USD: 8-day net issuance minus prior-7-day net (scaled)'}
COUNTRY_SERIES = {'AR': ['ar_premium_cripto', 'ar_premium_blue', 'ar_usdt_vol'], 'NG': ['ng_premium', 'ng_usdt_rate', 'ng_usdt_vol'], 'IR': ['ir_implied_usd_toman', 'ir_btc_vol'],
                  'TR': ['tr_premium', 'tr_usdt_vol'], 'BR': ['br_premium', 'br_usdt_vol']}
TRENDS_GEO = {'AR': ('AR', ['bitcoin', 'USDT']), 'NG': ('NG', ['bitcoin', 'USDT']), 'IR': ('IR', ['bitcoin', 'تتر']), 'TR': ('TR', ['bitcoin', 'USDT']), 'BR': ('BR', ['bitcoin', 'USDT']),
              'US': ('US', ['bitcoin']), 'CN': ('HK', ['bitcoin']), 'HK': ('HK', ['bitcoin']), 'EU': ('DE', ['bitcoin']), 'KR': ('KR', ['bitcoin']), 'JP': ('JP', ['bitcoin']), 'IN': ('IN', ['bitcoin']), 'RU': ('RU', ['bitcoin'])}

def window_stat(series, d, kind, pre=7, post=7):
    pv = [series[add_days(d, -i)] for i in range(1, pre + 1) if series.get(add_days(d, -i)) is not None]
    qv = [series[add_days(d, i)] for i in range(0, post + 1) if series.get(add_days(d, i)) is not None]
    if len(pv) < 3 or len(qv) < 2: return None
    a, b = st.mean(pv), st.mean(qv)
    if kind == 'level_pp': return (b - a) * 100
    if kind == 'level_pct': return (b / a - 1) * 100 if a else None
    if kind == 'ratio': return b / a if a > 0 else None
    if kind == 'sum': return b * (post + 1) - a * pre
    return None

_base_cache = {}
def spike_test(series, d, kind, exclude=(), pre=7, post=7, name=None):
    """Event-window statistic vs the empirical distribution of the same statistic on every other date (excl. +/-10 d of curated events)."""
    v = window_stat(series, d, kind, pre, post)
    if v is None: return None
    ck = (name or id(series), kind, post)
    if ck not in _base_cache:
        dates = sorted(series)
        _base_cache[ck] = {x: window_stat(series, x, kind, pre, post) for x in dates[pre:-post or None]}
    ex = set(add_days(e, i) for e in list(exclude) + [d] for i in range(-10, 11))
    base = [y for x, y in _base_cache[ck].items() if x not in ex and y is not None and (y > 0 if kind == 'ratio' else True)]
    res = {'value': v, 'unit': UNIT[kind], 'post_days': sum(1 for i in range(post + 1) if series.get(add_days(d, i)) is not None)}
    if len(base) < 30 or (kind == 'ratio' and v <= 0): return {**res, 'n_base': len(base)}
    tr = math.log if kind == 'ratio' else (lambda x: x)
    bt = [tr(x) for x in base]; med = st.median(bt); dv = abs(tr(v) - med)
    res.update({'baseline_median': math.exp(med) if kind == 'ratio' else med, 'percentile': sum(1 for x in bt if x <= tr(v)) / len(bt) * 100,
                'p_emp': sum(1 for x in bt if abs(x - med) >= dv) / len(bt), 'n_base': len(bt)})
    return res

def ng_premium_series(dates):
    q = quidax_daily(); out = {}
    for d in dates:
        if d < '2024-03-05' or d not in q or d > TODAY.isoformat(): continue
        r = safe('fawaz:' + d, lambda d=d: fawaz_rate(d, 'ngn'))
        if r: out[d] = q[d][0] / r - 1
    return out

def trends_window(country, d, pre=30, post=30):
    if country not in TRENDS_GEO: return None
    geo, kws = TRENDS_GEO[country]
    s, e = add_days(d, -pre), min(add_days(d, post), (TODAY - dt.timedelta(days=1)).isoformat())
    r = gtrends(geo, kws, s, e)
    if not r or r.get('empty'): return None
    res = {}
    for kw in kws:
        ser = r.get(kw) or {}
        if ser and max(ser.values()) > 0:
            res[kw] = {'ratio_post_pre_7d': window_stat(ser, d, 'ratio'), 'peak_day': max(ser, key=ser.get), 'peak': max(ser.values()),
                       'pre7_mean': st.mean([ser.get(add_days(d, -i), 0) for i in range(1, 8)]), 'post7_mean': st.mean([ser[add_days(d, i)] for i in range(0, 8) if add_days(d, i) in ser] or [0])}
    return {'geo': geo, 'window': [s, e], 'kw': res, 'source': 'Google Trends via pytrends (relative 0-100 within window)'} if res else None

def crossref(country, d, S, exclude=(), use_trends=True, post=7):
    out = {}
    for n in COUNTRY_SERIES.get(country, []):
        if n == 'ng_premium':
            ser = ng_premium_series([add_days(d, i) for i in range(-7, post + 1)])
            v = window_stat(ser, d, 'level_pp', post=post)
            if v is not None: out[n] = {'value': v, 'unit': UNIT['level_pp'], 'level_pre': st.mean([ser[x] for x in ser if x < d]) * 100, 'note': 'no empirical baseline (official reference only fetched around events)'}
            continue
        if S.get(n): out[n] = spike_test(S[n], d, KIND[n], exclude, post=post, name=n)
    out['tron_usdt_net'] = spike_test(S.get('tron_usdt_net') or {}, d, 'sum', exclude, post=post, name='tron_usdt_net')
    if use_trends:
        t = trends_window(country, d)
        if t: out['trends'] = t
    return {k: v for k, v in out.items() if v}

# ======================================================================================================
# 5. GDELT DOC 2.0 (free; 1 request / 5 s)
# ======================================================================================================
GN_SPIKE_Q = {'NG': 'crypto Nigeria', 'AR': 'cripto OR crypto Argentina', 'IR': 'crypto Iran', 'CN': 'crypto China', 'US': 'crypto SEC OR CFTC OR Congress', 'EU': 'MiCA OR ESMA crypto',
              'TR': 'crypto Turkey OR Türkiye', 'GLOBAL_BAN': 'crypto ban OR crackdown'}
def spike_headlines(key, day):
    """Headlines for a GDELT spike day. GDELT artlist is tried from cache only (its rate limit is ~1 req/min from shared IPs);
    otherwise a Google News date-restricted search for the same topic (day-1 .. day+1) supplies the citations."""
    al = os.path.join(CACHE, f'gdelt_al_{hashlib.md5(GDELT_Q[key].encode()).hexdigest()[:8]}_{day}.json')
    if os.path.exists(al):
        arts = load_json(al, [])
        if arts: return [{'title': a['title'], 'link': a['url'], 'publisher': a['domain'], 'date': day, 'via': 'GDELT artlist'} for a in arts]
    def f():
        items = parse_feed(gnews(f'{GN_SPIKE_Q[key]} after:{add_days(day, -1)} before:{add_days(day, 2)}', 'en'), 'GN:en', None, False)
        return [{'title': x['title'], 'link': x['link'], 'publisher': x['publisher'], 'date': iso(x['ts']), 'via': 'Google News'} for x in items if x['ts'] and CRYPTO.search(x['title'])][:10]
    return cache_get(f'spikegn_{key}_{day}', None, f) or []

GDELT_Q = {
    'NG': '(crypto OR bitcoin OR binance OR cryptocurrency) nigeria', 'AR': '(cripto OR bitcoin OR criptomonedas OR crypto) argentina',
    'IR': '(crypto OR bitcoin OR nobitex OR cryptocurrency) iran', 'CN': '(crypto OR bitcoin OR cryptocurrency) china (ban OR crackdown OR pboc OR stablecoin)',
    'US': '(crypto OR bitcoin OR stablecoin) (SEC OR CFTC OR "Clarity Act" OR "GENIUS Act")', 'EU': '(crypto OR stablecoin OR bitcoin) (MiCA OR ESMA)',
    'TR': '(crypto OR bitcoin OR kripto) (turkey OR türkiye)', 'GLOBAL_BAN': '(crypto OR bitcoin OR cryptocurrency) (ban OR crackdown OR prohibit)',
}
def gdelt_timeline(key, q, start='20240101000000'):
    def f():
        end = TODAY.strftime('%Y%m%d') + '000000'
        url = 'https://api.gdeltproject.org/api/v2/doc/doc?' + urllib.parse.urlencode({'query': q, 'mode': 'timelinevolraw', 'format': 'json', 'startdatetime': start, 'enddatetime': end})
        d = jget(url, timeout=90)
        ser = (d.get('timeline') or [{}])[0].get('data') or []
        return {x['date'][:4] + '-' + x['date'][4:6] + '-' + x['date'][6:8]: [x['value'], x.get('norm')] for x in ser}
    return cache_get('gdelt_tl_' + key, 20 * 3600, f)

def gdelt_artlist(q, day, n=8):
    def f():
        s = day.replace('-', '') + '000000'; e = add_days(day, 1).replace('-', '') + '000000'
        url = 'https://api.gdeltproject.org/api/v2/doc/doc?' + urllib.parse.urlencode({'query': q, 'mode': 'artlist', 'format': 'json', 'maxrecords': n, 'sort': 'hybridrel', 'startdatetime': s, 'enddatetime': e})
        t = http(url, timeout=60)
        d = json.loads(t) if t.strip().startswith('{') else {}
        return [{'title': a.get('title'), 'url': a.get('url'), 'domain': a.get('domain'), 'lang': a.get('language'), 'seendate': a.get('seendate')} for a in d.get('articles', [])]
    return cache_get(f'gdelt_al_{hashlib.md5(q.encode()).hexdigest()[:8]}_{day}', None if day < add_days(TODAY.isoformat(), -2) else 3600, f)

def gdelt_spikes(tl, z_min=4.0, min_count=15, gap=7, top=5):
    """Robust spike days on the topic SHARE of all GDELT-monitored articles (value/norm, removes crawler-volume artefacts):
    MAD-scaled z vs trailing-30d median >= z_min, share >= 3x median, raw count >= max(min_count, 2x raw median)."""
    days = sorted(tl); v = [tl[d][0] for d in days]; sh = [(tl[d][0] / tl[d][1] * 1e6) if tl[d][1] else 0 for d in days]; out = []
    for i in range(30, len(days)):
        base = sh[i - 30:i]; med = st.median(base); mad = st.median([abs(x - med) for x in base]) * 1.4826 or 1e-9
        rmed = st.median(v[i - 30:i]); z = (sh[i] - med) / mad
        nmed = st.median([tl[x][1] or 0 for x in days[i - 30:i]])
        if (tl[days[i]][1] or 0) < 0.5 * nmed: continue   # partial GDELT ingestion day (GDELT has gaps, e.g. Jun 2025, Sep-Oct 2026)
        if z >= z_min and sh[i] >= 3 * med and v[i] >= max(min_count, 2 * rmed):
            out.append({'date': days[i], 'count': v[i], 'baseline_median': rmed, 'share_ppm': round(sh[i], 2), 'z': round(z, 1)})
    out.sort(key=lambda x: -x['z']); keep = []
    for s in out:
        if all(abs((dt.date.fromisoformat(s['date']) - dt.date.fromisoformat(k['date'])).days) > gap for k in keep): keep.append(s)
        if len(keep) >= top: break
    return sorted(keep, key=lambda x: x['date'])

# ======================================================================================================
# 6. CURATED EVENT CANDIDATES - each is kept only if a date-restricted Google News search finds matching coverage
# ======================================================================================================
# (date, country, type, direction, label, verification query, regex the headline must match, dossier)
CANDIDATES = [
    ('2024-01-10', 'US', 'etf', 'dovish', 'SEC approves spot bitcoin ETFs', 'SEC approves spot bitcoin ETF', r'bitcoin.*etf|etf.*bitcoin', 'us_etf'),
    ('2024-02-21', 'NG', 'ban', 'hawkish', 'Nigeria blocks access to crypto exchange websites (Binance et al.)', 'Nigeria blocks crypto exchange websites Binance', r'nigeria', 'nigeria'),
    ('2024-02-28', 'NG', 'enforcement', 'hawkish', 'Nigeria detains Binance executives', 'Nigeria detains Binance executives', r'nigeria.*binance|binance.*nigeria', 'nigeria'),
    ('2024-03-05', 'NG', 'ban', 'hawkish', 'Binance discontinues naira (NGN) services', 'Binance naira services discontinue', r'naira', 'nigeria'),
    ('2024-03-25', 'NG', 'enforcement', 'hawkish', 'Nigeria charges Binance with tax evasion', 'Nigeria charges Binance tax evasion', r'binance.*tax|tax.*binance', 'nigeria'),
    ('2024-04-15', 'HK', 'etf', 'dovish', 'Hong Kong SFC approves spot bitcoin/ether ETFs', 'Hong Kong approves spot bitcoin ether ETFs', r'hong kong.*(etf|exchange-traded)', 'cn_hk'),
    ('2024-05-23', 'US', 'etf', 'dovish', 'SEC approves spot ether ETF 19b-4 filings', 'SEC approves ether ETF', r'ether.*etf|ethereum.*etf|etf.*ether', 'us_etf'),
    ('2024-06-26', 'TR', 'licensing', 'neutral', 'Turkey parliament passes crypto asset law', 'Turkey crypto law parliament approves', r'turk|türkiye', None),
    ('2024-06-30', 'EU', 'stablecoin', 'hawkish', 'MiCA stablecoin (EMT/ART) rules start to apply', 'MiCA stablecoin rules take effect', r'mica', 'eu_mica'),
    ('2024-07-23', 'US', 'etf', 'dovish', 'Spot ether ETFs begin trading', 'spot ether ETFs begin trading', r'ether.*etf|etf.*ether', 'us_etf'),
    ('2024-12-28', 'IR', 'capital_control', 'hawkish', 'Iran shuts crypto payment / rial gateways as rial hits record low', 'Iran crypto payment rial', r'iran', 'iran'),
    ('2024-12-30', 'EU', 'licensing', 'neutral', 'MiCA fully applicable (CASP regime starts)', 'MiCA fully applies crypto December 30', r'mica', 'eu_mica'),
    ('2025-01-23', 'US', 'easing', 'dovish', 'Trump digital-asset executive order; SEC rescinds SAB 121', 'Trump executive order crypto digital assets', r'executive order|sab 121', None),
    ('2025-02-21', 'US', 'easing', 'dovish', 'SEC agrees to drop Coinbase lawsuit', 'SEC drop Coinbase lawsuit', r'coinbase', None),
    ('2025-03-06', 'US', 'easing', 'dovish', 'Strategic Bitcoin Reserve executive order', 'Strategic Bitcoin Reserve executive order', r'reserve', None),
    ('2025-04-11', 'AR', 'capital_control', 'dovish', 'Argentina lifts most currency controls (cepo) for individuals', 'Argentina lifts currency controls', r'argentin', 'argentina'),
    ('2025-06-17', 'US', 'stablecoin', 'dovish', 'US Senate passes GENIUS stablecoin act', 'Senate passes GENIUS Act stablecoin', r'genius|stablecoin', 'us_stablecoin'),
    ('2025-06-18', 'IR', 'enforcement', 'hawkish', 'Nobitex (Iran largest exchange) hacked; funds burned', 'Nobitex hack', r'nobitex', 'iran'),
    ('2025-07-17', 'US', 'legislation', 'dovish', 'House passes CLARITY and GENIUS acts (GENIUS signed 18 Jul)', 'House passes CLARITY Act GENIUS', r'clarity|genius', 'us_market_structure'),
    ('2025-08-01', 'HK', 'stablecoin', 'neutral', 'Hong Kong Stablecoins Ordinance takes effect', 'Hong Kong stablecoin ordinance takes effect', r'hong kong', 'cn_hk'),
    ('2025-09-17', 'US', 'etf', 'dovish', 'SEC approves generic listing standards for crypto ETPs', 'SEC generic listing standards crypto ETF', r'listing standard', 'us_etf'),
    ('2025-11-10', 'BR', 'licensing', 'hawkish', 'Brazil central bank publishes crypto (VASP) rules', 'Brazil central bank crypto rules', r'brazil|brasil', None),
    ('2025-11-29', 'CN', 'ban', 'hawkish', 'PBoC vows crackdown on virtual currency, flags stablecoins', 'China central bank crackdown virtual currency stablecoin', r'china|pboc', 'cn_hk'),
    ('2026-02-06', 'CN', 'ban', 'hawkish', 'China extends crypto ban to stablecoins and RWA tokenization', 'China crypto crackdown stablecoins tokenization', r'china', 'cn_hk'),
    ('2026-03-02', 'TR', 'tax', 'hawkish', 'Turkey proposes crypto income tax and transaction levy', 'Turkey crypto tax proposal', r'turk|türkiye', None),
    ('2026-04-10', 'HK', 'licensing', 'dovish', 'HKMA grants first stablecoin issuer licences (HSBC, StanChart JV)', 'Hong Kong first stablecoin licences HSBC', r'hong kong|hkma', 'cn_hk'),
    ('2026-06-02', 'IR', 'sanctions', 'hawkish', 'US sanctions Nobitex (Iran largest crypto exchange)', 'US sanctions Iran largest crypto exchange', r'iran|nobitex', 'iran'),
    ('2026-07-01', 'EU', 'licensing', 'hawkish', 'MiCA CASP transitional period ends', 'MiCA transitional period ends', r'mica', 'eu_mica'),
    ('2026-07-20', 'NG', 'easing', 'dovish', 'Nigeria executive order opening up to cryptocurrency', 'Tinubu executive order cryptocurrency', r'nigeria|tinubu', 'nigeria'),
    ('2026-08-04', 'RU', 'legislation', 'dovish', 'Russia signs first crypto law (trading legal, payments banned)', 'Putin signs crypto law', r'russia|putin', None),
    ('2026-09-15', 'US', 'legislation', 'hawkish', 'Senate fails to advance CLARITY market-structure bill (49-50)', 'Senate fails crypto market structure bill', r'senate|clarity', 'us_market_structure'),
    ('2026-09-17', 'IR', 'sanctions', 'hawkish', 'US sanctions Iranian crypto exchange over IRGC transfers', 'US sanctions Iranian crypto exchange Revolutionary Guards', r'iran', 'iran'),
    ('2026-09-21', 'AR', 'licensing', 'neutral', 'Argentina new regulations for crypto service providers', 'Argentina regulations crypto service providers', r'argentin', 'argentina'),
    ('2026-10-02', 'US', 'etf', 'dovish', 'SEC approves first 3x bitcoin and ether ETFs', 'SEC approves 3x bitcoin ether ETF', r'3x|leveraged', 'us_etf'),
]

def verify_event(c):
    d, ctry, typ, direction, label, q, must, dossier = c
    s, e = add_days(d, -4), add_days(d, 5)
    def f():
        items = parse_feed(gnews(f'{q} after:{s} before:{e}', 'en'), 'GN:en', ctry, False)
        return [{'title': x['title'], 'publisher': x['publisher'], 'link': x['link'], 'date': iso(x['ts'])} for x in items if x['ts']]
    items = safe('verify:' + d, lambda: cache_get(f'verify_{d}_{hashlib.md5(q.encode()).hexdigest()[:8]}', None, f), []) or []
    qtok = norm_tokens(q)
    ACT = re.compile(r'approv|\bpass(es|ed)\b|\bsigns?\b|signed|sanction|detain|charges?\b|\bsues?\b|\blifts?\b|\bblocks?\b|restrict|\bbans?\b|takes effect|comes into force|\bfails?\b|failed|grants?\b|hack|discontinu|expir|ends?\b|tighten|crackdown|executive order|drop', re.I)
    hits = []
    for x in items:
        if not (re.search(must, x['title'], re.I) and s <= x['date'] <= e): continue
        ov = len(qtok & norm_tokens(x['title']))
        if ov < 2: continue
        x = dict(x, overlap=ov, action=bool(ACT.search(x['title'])))
        hits.append(x)
    # citation ranking: action headline on/after the curated date first, then token overlap, then closeness to the date
    dd = lambda x: abs((dt.date.fromisoformat(x['date']) - dt.date.fromisoformat(d)).days)
    hits.sort(key=lambda x: (not (x['action'] and x['date'] >= d), -x['overlap'], dd(x)))
    strong_early = sorted(x['date'] for x in hits if x['action'] and x['date'] < d)
    # dates are NOT auto-shifted (anticipatory/'reportedly' headlines and pubDate noise made that unreliable); earlier action
    # headlines are only reported for review. Curated dates were corrected by hand where coverage showed the action earlier.
    date_used, adjusted = d, False
    return {'date': date_used, 'curated_date': d, 'date_adjusted': adjusted, 'country': ctry, 'type': typ, 'type_label': TYPE_LABEL.get(typ, typ), 'direction': direction, 'label': label, 'dossier': dossier, 'source_set': 'curated',
            'verified': bool(hits), 'citations': hits[:3], 'earlier_action_headline_dates': strong_early[:5], 'earliest_coverage': min((x['date'] for x in hits), default=None), 'n_matching_articles': len(hits),
            'verification_query': f'{q} after:{s} before:{e}'}

# ======================================================================================================
# 7. EVENT STUDY
# ======================================================================================================
def betacf(a, b, x):
    tiny = 1e-30; qab, qap, qam = a + b, a + 1, a - 1; c = 1.0; d = 1 - qab * x / qap
    d = 1 / (d if abs(d) > tiny else tiny); h = d
    for m in range(1, 400):
        m2 = 2 * m
        for aa in (m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))):
            d = 1 + aa * d; d = 1 / (d if abs(d) > tiny else tiny)
            c = 1 + aa / c; c = c if abs(c) > tiny else tiny
            de = d * c; h *= de
        if abs(de - 1) < 3e-12: break
    return h
def betai(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    return bt * betacf(a, b, x) / a if x < (a + 1) / (a + b + 2) else 1 - bt * betacf(b, a, 1 - x) / b
def t_p(t, df):
    """two-sided p-value of Student t"""
    if df <= 0 or t is None: return None
    return betai(df / 2, 0.5, df / (df + t * t))

def logret(px):
    ks = sorted(px)
    return {ks[i]: math.log(px[ks[i]] / px[ks[i - 1]]) for i in range(1, len(ks)) if px[ks[i]] and px[ks[i - 1]] and (dt.date.fromisoformat(ks[i]) - dt.date.fromisoformat(ks[i - 1])).days == 1}

WINDOWS = [(-7, -1), (-3, -1), (-1, 1), (0, 1), (0, 3), (0, 7), (-7, 7)]   # pre-windows test for run-up/leakage before the announcement
WK = [f'{a},{b}' for a, b in WINDOWS]

def car_for(r, d, a, b, mode, rb=None):
    vs = [r.get(add_days(d, i)) for i in range(a, b + 1)]
    if any(x is None for x in vs): return None
    if mode == 'mkt':
        bs = [rb.get(add_days(d, i)) for i in range(a, b + 1)]
        if any(x is None for x in bs): return None
        return (sum(vs) - sum(bs)) * 100
    est = [r.get(add_days(d, i)) for i in range(-120, -10)]; est = [x for x in est if x is not None]
    if len(est) < 60: return None
    return (sum(vs) - st.mean(est) * len(vs)) * 100

def stats(vals):
    v = [x for x in vals if x is not None]; n = len(v)
    if n < 2: return {'n': n, 'mean': v[0] if v else None}
    m = st.mean(v); sd = st.stdev(v); t = m / (sd / math.sqrt(n)) if sd > 0 else None
    return {'n': n, 'mean': m, 'median': st.median(v), 'sd': sd, 'pct_pos': sum(1 for x in v if x > 0) / n * 100, 't': t, 'p_t': t_p(t, n - 1) if t is not None else None}

def placebo_p(pool_cars, n, observed, reps=3000, seed=11):
    """two-sided p of the observed mean CAR vs means of n random non-event dates (same model and window)"""
    if observed is None or n < 2 or len(pool_cars) < 30: return None
    rnd = random.Random(seed + n)
    sims = [st.mean(rnd.choices(pool_cars, k=n)) for _ in range(reps)]
    c = st.mean(sims)
    return sum(1 for s in sims if abs(s - c) >= abs(observed - c)) / reps

def run_study():
    t0 = time.time()
    log('study: prices')
    px = {a: safe('px:' + a, lambda a=a: coinbase_daily(f'{a}-USD', '2023-06-01'), {}) for a in ('BTC', 'ETH', 'SOL')}
    R = {a: logret(p) for a, p in px.items()}
    cat = load_json(os.path.join(DATA_DIR, 'crash_catalog_final.json'), {})
    ids = sorted(set(c['id'] for c in cat.get('coingecko_coins', []) if c.get('id') and c['id'] != 'bitcoin'))
    toks = {}
    for i in ids:
        f = os.path.join(DATA_DIR, 'cg_series', i + '.json')
        if not os.path.exists(f): continue
        p = load_json(f, {}).get('prices') or []
        if len(p) > 60: toks[i] = logret({iso(ms / 1000): v for ms, v in p if v})
    btc_cg = logret({iso(ms / 1000): v for ms, v in (load_json(os.path.join(DATA_DIR, 'cg_series', 'bitcoin.json'), {}).get('prices') or []) if v})
    log(f'study: {len(toks)} catalog tokens with cg_series')
    log('study: verifying curated events via Google News date-restricted search')
    cur = [verify_event(c) for c in CANDIDATES]
    events = [e for e in cur if e['verified']]
    log('study: GDELT')
    gd = {}
    for k, q in GDELT_Q.items():
        tl = safe('gdelt:' + k, lambda k=k, q=q: gdelt_timeline(k, q))
        if not tl: continue
        sp = gdelt_spikes(tl)
        for s in sp:
            arts = safe(f'spike_headlines:{k}:{s["date"]}', lambda k=k, s=s: spike_headlines(k, s['date'])) or []
            s['headlines'] = arts[:5]
            cl = classify(' '.join(a['title'] or '' for a in arts[:8]), None if k == 'GLOBAL_BAN' else k)
            s['country'] = k if k != 'GLOBAL_BAN' else cl['country']; s['type'] = cl['type']; s['type_label'] = cl['type_label']; s['direction'] = cl['direction']
        monthly = {}
        for d0, (v, nrm) in tl.items(): monthly[d0[:7]] = monthly.get(d0[:7], 0) + v
        gd[k] = {'query': q, 'days': len(tl), 'total_articles': sum(v for v, _ in tl.values()), 'monthly': monthly, 'spikes': sp}
    # a 'spike' on the same day in >=3 unrelated topic queries is a GDELT ingestion artefact, not news -> dropped
    from collections import Counter
    cnt = Counter(sp['date'] for g in gd.values() for sp in g['spikes'])
    artefacts = sorted(d0 for d0, n in cnt.items() if n >= 3)
    for g in gd.values(): g['spikes'] = [sp for sp in g['spikes'] if sp['date'] not in artefacts]
    gevents = []
    for k, g in gd.items():
        for s in g['spikes']:
            if s['date'] > add_days(TODAY.isoformat(), -2): continue
            gevents.append({'date': s['date'], 'country': s['country'], 'type': s['type'], 'type_label': s['type_label'], 'direction': s['direction'],
                            'label': f'GDELT coverage spike [{k}]: {s["count"]} articles vs median {s["baseline_median"]:.0f} (z {s["z"]})', 'source_set': 'gdelt', 'gdelt_query': k,
                            'citations': s.get('headlines', [])[:3]})
    log('study: CARs')
    all_dates = sorted(set(R['BTC']) & set(R['ETH']) & set(R['SOL']))
    excl = set(add_days(e['date'], i) for e in events + gevents for i in range(-10, 11))
    pool = [d for d in all_dates if d not in excl and d >= add_days(all_dates[0], 125) and d <= add_days(all_dates[-1], -8)]
    SERIES = {'BTC': (R['BTC'], 'cm', None), 'ETH': (R['ETH'], 'cm', None), 'SOL': (R['SOL'], 'cm', None), 'ETH_vs_BTC': (R['ETH'], 'mkt', R['BTC']), 'SOL_vs_BTC': (R['SOL'], 'mkt', R['BTC'])}
    pool_cars = {(asset, wk): [x for x in (car_for(r, d, *map(int, wk.split(',')), mode, rb) for d in pool) if x is not None] for asset, (r, mode, rb) in SERIES.items() for wk in WK}
    cg_dates = sorted(btc_cg)
    def basket(d):
        if not cg_dates or d < add_days(cg_dates[0], 8) or d > add_days(cg_dates[-1], -1): return None
        out = {}
        for wk in WK:
            a, b = map(int, wk.split(','))
            cs = []
            for tid, r in toks.items():
                c = car_for(r, d, a, b, 'mkt', btc_cg)
                if c is not None and abs(c) < 300: cs.append(c)
            out[wk] = {'mean': st.mean(cs) if cs else None, 'median': st.median(cs) if cs else None, 'n_tokens': len(cs)}
        return out
    excl3 = set(add_days(e['date'], i) for e in events + gevents for i in range(-3, 4))   # short window only: few non-event days remain in the 365-d catalog window
    cat_pool = [d for d in cg_dates if d not in excl3 and d >= add_days(cg_dates[0], 8) and d <= add_days(cg_dates[-1], -8)] if cg_dates else []
    cat_pool_cars = {}
    for wk in WK:
        a, b = map(int, wk.split(',')); vals = []
        for d in cat_pool:
            cs = [c for c in (car_for(r, d, a, b, 'mkt', btc_cg) for r in toks.values()) if c is not None and abs(c) < 300]
            if cs: vals.append(st.mean(cs))
        cat_pool_cars[wk] = vals
    for e in events + gevents:
        e['car'] = {asset: {wk: car_for(r, e['date'], *map(int, wk.split(',')), mode, rb) for wk in WK} for asset, (r, mode, rb) in SERIES.items()}
        e['car']['CATALOG_vs_BTC'] = basket(e['date'])
    def group_stats(evs, signed=False):
        res = {}
        for asset in SERIES:
            res[asset] = {}
            for wk in WK:
                vals = [e['car'][asset].get(wk) for e in evs]
                if signed: vals = [None if v is None else v * (1 if e['direction'] == 'dovish' else -1) for v, e in zip(vals, evs)]
                s = stats(vals)
                if not signed: s['p_placebo'] = placebo_p(pool_cars[(asset, wk)], s['n'], s.get('mean'))
                res[asset][wk] = s
        res['CATALOG_vs_BTC'] = {}
        for wk in WK:
            vals = [((e['car'].get('CATALOG_vs_BTC') or {}).get(wk) or {}).get('mean') for e in evs]
            if signed: vals = [None if v is None else v * (1 if e['direction'] == 'dovish' else -1) for v, e in zip(vals, evs)]
            s = stats(vals)
            if not signed: s['p_placebo'] = placebo_p(cat_pool_cars.get(wk, []), s['n'], s.get('mean'))
            res['CATALOG_vs_BTC'][wk] = s
        return res
    groups = {
        'curated_all': events, 'curated_hawkish': [e for e in events if e['direction'] == 'hawkish'], 'curated_dovish': [e for e in events if e['direction'] == 'dovish'],
        'curated_US': [e for e in events if e['country'] == 'US'], 'curated_US_dovish': [e for e in events if e['country'] == 'US' and e['direction'] == 'dovish'],
        'curated_non_US': [e for e in events if e['country'] != 'US'], 'curated_ETF': [e for e in events if e['type'] == 'etf'],
        'curated_ban_enforcement_sanctions': [e for e in events if e['type'] in ('ban', 'enforcement', 'sanctions', 'capital_control') and e['direction'] == 'hawkish'],
        'curated_EM_country (NG/AR/IR/TR/BR)': [e for e in events if e['country'] in ('NG', 'AR', 'IR', 'TR', 'BR')], 'curated_CN_HK': [e for e in events if e['country'] in ('CN', 'HK')],
        'gdelt_spikes_all': gevents, 'gdelt_spikes_hawkish': [e for e in gevents if e['direction'] == 'hawkish'],
    }
    summary = {}
    for g, evs in groups.items():
        summary[g] = {'n_events': len(evs), 'dates': [e['date'] for e in evs], 'stats': group_stats(evs)}
        if g in ('curated_all', 'gdelt_spikes_all'): summary[g]['signed_stats'] = group_stats([e for e in evs if e['direction'] != 'neutral'], signed=True)
    log('study: local flow reactions')
    S, src = history_series()
    exclude_dates = [e['date'] for e in events]
    for e in events + [g for g in gevents if g['country'] in COUNTRY_SERIES]:
        e['flows'] = crossref(e['country'], e['date'], S, exclude=[x for x in exclude_dates if x != e['date']], use_trends=e['source_set'] == 'curated')
    flow_summary = {}
    for n in ['ar_premium_cripto', 'ar_premium_blue', 'ar_usdt_vol', 'ng_premium', 'ng_usdt_rate', 'ng_usdt_vol', 'ir_implied_usd_toman', 'ir_btc_vol', 'tr_premium', 'tr_usdt_vol', 'br_premium', 'br_usdt_vol', 'tron_usdt_net']:
        rows = [(e['date'], e['country'], e['label'], e['flows'][n]) for e in events if (e.get('flows') or {}).get(n)]
        if n == 'tron_usdt_net': rows = [r for r in rows if r[1] in COUNTRY_SERIES or True]
        if not rows: continue
        ps = [r[3].get('p_emp') for r in rows if r[3].get('p_emp') is not None]
        flow_summary[n] = {'n': len(rows), 'n_p_emp_below_0.10': sum(1 for p in ps if p < 0.10), 'expected_by_chance': round(0.10 * len(ps), 1), 'source': src.get(n, ''), 'unit': UNIT[KIND[n]],
                           'events': [{'date': d, 'country': c, 'label': l, **x} for d, c, l, x in rows]}
    trend_rows = [{'date': e['date'], 'country': e['country'], 'label': e['label'], **e['flows']['trends']} for e in events if (e.get('flows') or {}).get('trends')]
    out = {
        'generatedAt': dt.datetime.now(dt.UTC).isoformat(), 'elapsed_s': round(time.time() - t0),
        'method': ('Day 0 = announcement date (UTC calendar day); daily UTC closes; log returns. "BTC/ETH/SOL" = constant-mean abnormal return (return minus its mean over days -120..-11). '
                   '"_vs_BTC" = return minus BTC return (market-adjusted). CATALOG_vs_BTC = equal-weight mean across crash-catalog tokens that have CoinGecko free 365-day series (data/cg_series), excess vs BTC; |CAR| > 300% dropped as bad ticks. '
                   'CAR windows [a,b] in trading days (crypto trades daily). p_t = cross-sectional t-test across events (assumes independence). p_placebo = two-sided p of the mean CAR vs 3000 means of the same number of random non-event days '
                   '(days within +/-10 d of any event excluded). Signed stats multiply each CAR by +1 for dovish and -1 for hawkish events (tests "price moves in the policy direction"). '
                   'Flow reactions: mean over days 0..+7 vs days -7..-1 (premium in percentage points, FX in %, volumes as a post/pre ratio, Tron USDT as net issuance difference); '
                   'p_emp/percentile rank the event value against the same statistic computed on every other date of that series (excl. +/-10 d of curated events).'),
        'caveats': ['Small n; events cluster in time (US policy Jan-Mar 2025; Iran 2026) so windows overlap and are not independent.',
                    'Many US actions land after the US close, so part of the reaction falls on day +1.',
                    'Curated candidates were hand-picked (selection bias toward well-known events) and kept only when a date-restricted Google News search returned matching headlines (citations stored per event).',
                    'GDELT DOC coverage has gaps (only 14 days in Jun 2025, 23 in Sep 2026, Oct 2026 nearly empty at run time); partial days are skipped by the spike detector.',
                    'GDELT spike days are machine-detected coverage bursts; their type/direction come from the keyword classifier on GDELT headlines and are noisy.',
                    'Catalog-token series cover only the free 365-day CoinGecko window, so only events since ~Oct 2025 have catalog CARs.',
                    'Local premiums: ARS from argentinadatos daily casas; TRY/BRL vs ECB reference (business days); NGN official from fawazahmed0 currency-api (only from Mar 2024); Iran = Nobitex BTC/IRT / Coinbase BTC-USD (implied).',
                    'Google Trends values are relative within each request window; pytrends is unofficial and rate-limited, missing values mean the request failed.'],
        'candidates': [{k: e[k] for k in ('date', 'curated_date', 'date_adjusted', 'country', 'label', 'verified', 'n_matching_articles', 'earliest_coverage', 'verification_query')} for e in cur],
        'events': events, 'gdelt': gd, 'gdelt_artefact_days': artefacts, 'gdelt_events': gevents, 'summary': summary, 'flow_summary': flow_summary, 'trends': trend_rows,
        'catalog_tokens': len(toks), 'catalog_window': [cg_dates[0], cg_dates[-1]] if cg_dates else None, 'price_range': [all_dates[0], all_dates[-1]], 'placebo_pool_days': len(pool), 'catalog_placebo_pool_days': len(cat_pool), 'catalog_pool_mean_car': {wk: (st.mean(v) if v else None) for wk, v in cat_pool_cars.items()}, 'errors': dict(ERRORS),
    }
    with open(OUT_STUDY + '.tmp', 'w') as fh: json.dump(out, fh, default=lambda o: None)
    os.replace(OUT_STUDY + '.tmp', OUT_STUDY)
    log('study written', OUT_STUDY, f'{time.time() - t0:.0f}s', len(events), 'curated', len(gevents), 'gdelt')
    return out

# ======================================================================================================
# 8. LIVE RUN
# ======================================================================================================
def run_live():
    t0 = time.time()
    log('live: ingest')
    raw, status = ingest('7d')
    clusters_all = cluster_items(raw)
    clusters = [c for c in clusters_all if c['policy']]
    clusters.sort(key=lambda c: (-c['severity'], -c['ts']))
    new_alerts, alerts, first_run = alerts_update(clusters)
    log(f'live: {len(raw)} raw -> {len(clusters)} clusters; {len(new_alerts)} new alerts (first_run={first_run})')
    log('live: flows')
    flows = flows_live()
    log('live: crossref')
    S, src = history_series()
    study = load_json(OUT_STUDY, {})
    known = [e['date'] for e in study.get('events', [])]
    flagged = [c for c in clusters if c['severity'] >= 3 and c['ts'] > time.time() - 14 * 86400]
    cx, done, tcalls = [], set(), 0
    for c in flagged:
        key = (c['country'], c['date'])
        if key in done or (c['country'] not in COUNTRY_SERIES and c['country'] not in TRENDS_GEO): continue
        done.add(key)
        use_tr = tcalls < 6 and c['country'] in TRENDS_GEO
        if use_tr: tcalls += 1
        cx.append({'id': c['id'], 'date': c['date'], 'country': c['country'], 'title': c['title'], 'link': c['link'], 'severity': c['severity'], 'direction': c['direction'], 'type_label': c['type_label'],
                   'flows': crossref(c['country'], c['date'], S, exclude=known, use_trends=use_tr)})
        if len(cx) >= 25: break
    dossiers = []
    for d in DOSSIERS:
        its = sorted([c for c in clusters if re.search(d['rx'], c['title'], re.I)], key=lambda c: -c['ts'])
        ms = [{'date': e['date'], 'label': e['label'], 'direction': e['direction'], 'citation': (e['citations'] or [{}])[0]} for e in study.get('events', []) if e.get('dossier') == d['key']]
        dossiers.append({'key': d['key'], 'name': d['name'], 'country': d['country'], 'n_items_window': len(its),
                         'direction_mix': {k: sum(1 for c in its if c['direction'] == k) for k in ('hawkish', 'dovish', 'neutral')},
                         'latest': [{k: c[k] for k in ('date', 'title', 'link', 'publisher', 'severity', 'direction', 'type_label', 'n_sources')} for c in its[:6]], 'milestones': ms})
    for c in clusters: c.pop('_tok', None)
    by_country = {}
    for c in clusters:
        b = by_country.setdefault(c['country'], {'n': 0, 'hawkish': 0, 'dovish': 0, 'neutral': 0, 'max_sev': 0})
        b['n'] += 1; b[c['direction']] += 1; b['max_sev'] = max(b['max_sev'], c['severity'])
    out = {'generatedAt': dt.datetime.now(dt.UTC).isoformat(), 'elapsed_s': round(time.time() - t0), 'window': '7 days (regulator site: queries 30 days)',
           'counts': {'raw': len(raw), 'clusters_all': len(clusters_all), 'clusters': len(clusters), 'dropped_non_policy': len(clusters_all) - len(clusters), 'sev4plus': sum(1 for c in clusters if c['severity'] >= 4), 'new_alerts': len(new_alerts)},
           'first_run_baseline': first_run, 'items': clusters[:400], 'by_country': by_country, 'alerts_new': new_alerts, 'alerts_recent': alerts[-60:][::-1],
           'dossiers': dossiers, 'flows': flows, 'crossref': cx, 'flow_sources': src, 'feed_status': status,
           'study_summary': {k: {'n_events': v['n_events'], 'BTC': v['stats']['BTC'], 'CATALOG_vs_BTC': v['stats']['CATALOG_vs_BTC']} for k, v in (study.get('summary') or {}).items()},
           'study_generatedAt': study.get('generatedAt'),
           'method': {'classifier': 'multilingual keyword rules; primary type priority ETF > capital control > sanctions > ban/restriction > enforcement > stablecoin > tax > easing > licensing > legislation > CBDC',
                      'direction': 'dovish-term count minus hawkish-term count (+1 prior from type); bans/capital controls/enforcement/sanctions lean hawkish',
                      'severity': 'base by type (ban/capital control 3; sanctions/enforcement/ETF/stablecoin/legislation/easing 2; licensing/tax/CBDC 1) +1 US/CN/EU, +1 strong action words, +1 official regulator source, +1 if >= 3 distinct publishers; clamp 1-5',
                      'dedupe': 'title token Jaccard >= 0.5 within 72 h (Google News publisher suffix stripped); alerts also suppressed if Jaccard >= 0.6 vs any previously seen title',
                      'alerts': 'severity >= 4 and not seen before; the first run only records a baseline (initial_baseline=true). Stored in data/regradar_alerts.json; nothing is pushed externally.'},
           'errors': dict(ERRORS)}
    with open(OUT_LIVE + '.tmp', 'w') as fh: json.dump(out, fh, default=lambda o: None)
    os.replace(OUT_LIVE + '.tmp', OUT_LIVE)
    log('live written', OUT_LIVE, f'{time.time() - t0:.0f}s')
    return out

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'live'
    if mode in ('study', 'all'): run_study()
    if mode in ('live', 'all'): ERRORS.clear(); run_live()
