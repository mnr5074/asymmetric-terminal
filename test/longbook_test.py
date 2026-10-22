"""Long Book: rule/backtest mechanics on synthetic series + data/longbook.json integrity. Run: python3 test/longbook_test.py"""
import json, math, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'research', 'longbook'))
import longbook as lb

ALLOWED = {'shipped', 'testnet', 'roadmap', 'marketing', 'verified', 'partly', 'not-verified'}


def synth(n=1500):
    # up 3x, crash 85%, flat, recover: deterministic
    s, p = [], 1.0
    for d in range(n):
        if d < 400: p *= 1.003
        elif d < 700: p *= 0.9937
        elif d < 1000: p *= 1.0
        else: p *= 1.002
        s.append((18000 + d, p))
    return s


def test_features_and_rule():
    f = lb.features(synth())
    assert f[198]['sma200'] is None and f[199]['sma200'] is not None
    assert f[363]['hi365'] is None and f[364]['hi365'] is not None
    o = f[750]
    assert o['dd'] > 0.7, o['dd']
    r = lb.rule_fn('dd', 0.7, False)
    assert r(o) and not r(f[380])
    assert r.key == 'dd70' and 'drawdown' in r.label


def test_forward_and_sim():
    f = lb.features(synth())
    assert abs(lb.fwd(f, 0, 365) - (1.003 ** 365 - 1)) < 1e-9
    assert lb.fwd(f, len(f) - 10, 365) is None
    sim = lb.simulate(f, lb.rule_fn('dd', 0.7, False), f[0]['day'])
    for k in ('lumpSum', 'dca', 'ruleOnly', 'half'):
        assert sim[k]['multiple'] > 0 and -1 <= sim[k]['maxDD'] <= 0
    # through the bottom, rule-only (buys only the crash) beats DCA with a smaller drawdown...
    mid = lb.simulate(f, lb.rule_fn('dd', 0.7, False), f[0]['day'], f[1100]['day'])
    assert mid['ruleOnly']['multiple'] > mid['dca']['multiple'] and mid['ruleOnly']['maxDD'] > mid['dca']['maxDD']
    # ...but over the full path its idle cash during the recovery costs it (the cash-drag caveat)
    assert sim['ruleOnly']['investedPct'] < 1 and sim['ruleOnly']['multiple'] < sim['dca']['multiple']


def test_episodes():
    assert lb.episodes([1, 8, 15, 200, 207, 500]) == 3
    assert lb.episodes([]) == 0


def test_output_integrity():
    p = os.path.join(ROOT, 'data', 'longbook.json')
    d = json.load(open(p))
    syms = [c['sym'] for c in d['candidates']]
    assert 'BTC' not in syms and 8 <= len(syms) <= 12
    for c in d['candidates']:
        assert c['claims'], c['sym']
        for cl in c['claims']:
            assert cl['status'] in ALLOWED, (c['sym'], cl['status'])
            assert cl['sources'] and all(u.startswith('https://') for u in cl['sources']), c['sym']
        assert c['thesisBreak'] and c['risks']
        cap = c['capPct']
        assert (5 <= cap <= 15) if c['bucket'] == 'core' else (cap <= 5), (c['sym'], cap)
    meme = sum(c['capPct'] for c in d['candidates'] if c['bucket'] == 'meme')
    assert meme <= d['portfolio']['memeSliceMaxPct'] <= 10
    b = d['backtest']
    assert b['strength'] and b['chosen']['test']['signal']['fwd1y']['n'] > 0
    assert b['trainEnd'] == '2023-01-01'
    txt = open(p).read().lower()
    for bad in ('api_key', 'apikey', 'secret', 'password', 'ntfy.sh/'):
        assert bad not in txt, bad



def test_watchlist():
    # watchlist entries are tracked, never bought: no capPct / plan, dated, verified contract, sourced claims
    d = json.load(open(os.path.join(ROOT, 'data', 'longbook.json')))
    cfg = json.load(open(os.path.join(ROOT, 'research', 'longbook', 'candidates.json')))
    assert d.get('watchlist') == cfg.get('watchlist')
    syms = {c['sym'] for c in d['candidates']}
    for w in d['watchlist']:
        assert w['status'] == 'watchlist' and 'capPct' not in w and 'plan' not in w, w['sym']
        assert w['sym'] not in syms, w['sym']
        assert w['dataDate'] and w['contractVerified']
        for cl in w['claims']:
            assert cl['status'] in ALLOWED and cl['sources'] and all(u.startswith('https://') for u in cl['sources']), w['sym']
    vvv = next(w for w in d['watchlist'] if w['sym'] == 'VVV')
    assert vvv['contract'].lower() == '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf' and vvv['chain'] == 'base'


if __name__ == '__main__':
    n = 0
    for k, v in list(globals().items()):
        if k.startswith('test_'):
            v(); n += 1; print('ok', k)
    print(f'{n} tests passed')
