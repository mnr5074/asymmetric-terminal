"""Shared helpers for the Moonshot research module (stdlib only)."""
import json, time, threading, urllib.request, urllib.error, urllib.parse, sqlite3, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
DB = os.path.join(DATA_DIR, 'moonshot.db')
UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research, read-only)', 'accept': 'application/json'}
# min seconds between calls per host (free-tier politeness)
GAPS = {'api.gopluslabs.io': 1.2, 'api.coingecko.com': 3.0, 'api.geckoterminal.com': 2.2, 'api.rugcheck.xyz': 1.0, 'api.dexscreener.com': 0.35, 'frontend-api-v3.pump.fun': 1.6, 'www.stonkfun.xyz': 0.3}
_last, _lock = {}, threading.Lock()

def get(url, retries=3, timeout=25):
    host = urllib.parse.urlparse(url).hostname
    for i in range(retries + 1):
        with _lock:
            wait = _last.get(host, 0) + GAPS.get(host, 0.3) - time.time()
            _last[host] = max(time.time(), _last.get(host, 0) + GAPS.get(host, 0.3))
        if wait > 0: time.sleep(wait)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and i < retries:
                time.sleep(6 * (i + 1)); continue
            if e.code == 404: return None
            raise
        except Exception:
            if i < retries: time.sleep(3 * (i + 1)); continue
            raise

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens(
  mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, sources TEXT, launchpad TEXT,
  created_ts INTEGER, launch_hour_utc INTEGER, launch_dow INTEGER,
  curve_pool TEXT, main_pool TEXT, main_dex TEXT, curve_secs REAL,
  launch_price REAL, launch_mcap REAL, peak_price REAL, peak_mcap REAL, peak_ts INTEGER, time_to_peak_h REAL,
  cur_price REAL, cur_mcap REAL, cur_liq REAL, multiple REAL, cur_vs_peak REAL, cohort TEXT, supply REAL,
  hours_to_2x REAL, hours_to_10x REAL, hours_to_100x REAL, vol_to_10x REAL, vol_to_100x REAL, mcap_at_10x REAL, mcap_at_100x REAL,
  max_dd_before_10x REAL, vol_first1h REAL, vol_first24h REAL, vol24_over_launch_mcap REAL, mult_at_1h REAL, mult_at_24h REAL,
  green_ratio_24h REAL, n_candles INTEGER,
  has_twitter INTEGER, has_telegram INTEGER, has_website INTEGER, n_socials_dex INTEGER, reply_count INTEGER,
  profile_delay_h REAL, first_boost_delay_h REAL, boost_count INTEGER, boost_total REAL, cto INTEGER,
  theme TEXT, ticker_len INTEGER, name_len INTEGER, name_has_digit INTEGER, ticker_upper INTEGER,
  dev TEXT, dev_prior_tokens INTEGER, dev_prior_best_mcap REAL,
  holders_now INTEGER, top10_now REAL, insider_pct_now REAL, lp_locked_pct REAL, mint_auth INTEGER, freeze_auth INTEGER, rugcheck_rugged INTEGER,
  winner_overlap INTEGER, quote_liq_usd REAL, vol_total REAL, quality TEXT, updated_at INTEGER, err TEXT
);
CREATE TABLE IF NOT EXISTS top_holders(mint TEXT, owner TEXT, pct REAL, PRIMARY KEY(mint, owner));
CREATE TABLE IF NOT EXISTS candidates(mint TEXT PRIMARY KEY, sources TEXT, hint TEXT, added_at INTEGER);
"""
def db():
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    c.executescript(SCHEMA)
    # multi-chain migration: chain column (existing rows are Solana)
    for t in ('tokens', 'candidates'):
        cols = [r[1] for r in c.execute(f'PRAGMA table_info({t})')]
        if 'chain' not in cols: c.execute(f"ALTER TABLE {t} ADD COLUMN chain TEXT DEFAULT 'solana'")
    c.commit()
    return c

THEMES = [
    ('ai', r'\b(ai|gpt|agent|neural|bot|llm|agi|intelligence|grok|claude|openai)\b'),
    ('politics', r'(trump|maga|biden|elon|musk|kamala|melania|president|vance|doge\s?gov)'),
    ('dog', r'(dog|doge|inu|shib|puppy|wif|pup)'),
    ('cat', r'(cat|kitty|meow|popcat|mew|nyan)'),
    ('frog', r'(pepe|frog|toad|kek)'),
    ('animal_other', r'(monkey|ape|bear|bull|penguin|hippo|goat|fish|chill|duck|pig|hamster|moo|rat|panda)'),
    ('stock_rwa', r'(stock|stonk|spy|nvda|tsla|etf|xstock|s&p|nasdaq)'),
    ('celebrity_culture', r'(kanye|drake|taylor|swift|mrbeast|tiktok|meme|viral|troll|wojak|chad)'),
    ('crypto_meta', r'(sol|solana|pump|bonk|jup|coin|token|moon|degen|based|rich|money|cash)'),
]
def theme_of(name, sym):
    s = f'{name or ""} {sym or ""}'.lower()
    for t, rx in THEMES:
        if re.search(rx, s): return t
    return 'other'
