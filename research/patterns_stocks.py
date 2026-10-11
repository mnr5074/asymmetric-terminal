#!/usr/bin/env python3
"""Detector 4: stock-paired memecoins vs the underlying stock.
Universe: StonkFun tokens (crash_eco.json) whose quote asset is a tokenized stock (xStocks *X tickers or direct tickers), x7pad coins
(public API) paired with xStocks, Robinhood-Chain / Pons tokens whose ticker is a stock. Prices: GeckoTerminal daily + hourly OHLCV in USD
and (for quote-paired pools) in quote-token units (= idiosyncratic part, strips the mechanical quote-price pass-through). Stock: Yahoo
Finance chart API (1d, 1h). Metrics: daily/hourly return correlation, lead-lag cross-correlation (k>0 = stock leads token by k periods),
beta, 3-day residual z divergence. Backtest: did a negative divergence (token 3d residual z <= -2 while stock 3d return >= -2%) precede
the token's crash break (-50% from peak, daily)? FP = same flag on non-crash token-days. Output: data/patterns_stocks.json"""
import json, math, os, statistics, time, datetime as dt
from patterns_common import *
STOCKS = {'NVDAX': 'NVDA', 'TSLAX': 'TSLA', 'SPYX': 'SPY', 'GOOGLX': 'GOOGL', 'METAX': 'META', 'GMEX': 'GME', 'GLDX': 'GLD', 'MSFTX': 'MSFT', 'MCDX': 'MCD',
          'PLTRX': 'PLTR', 'APPLX': 'AAPL', 'AAPLX': 'AAPL', 'MSTRX': 'MSTR', 'QQQX': 'QQQ', 'COINX': 'COIN', 'AMZNX': 'AMZN', 'CRCLX': 'CRCL', 'HOODX': 'HOOD',
          'BRKX': 'BRK-B', 'INTCX': 'INTC', 'KOX': 'KO', 'DKNG': 'DKNG', 'TTWO': 'TTWO', 'DJT': 'DJT', 'SNDK': 'SNDK', 'GPRO': 'GPRO', 'QUBT': 'QUBT', 'MRNA': 'MRNA',
          'AMC': 'AMC', 'SQQQ': 'SQQQ', 'HIMS': 'HIMS', 'DELL': 'DELL', 'IBM': 'IBM', 'EWY': 'EWY', 'RDDT': 'RDDT', 'AMD': 'AMD', 'GRND': 'GRND', 'BLK': 'BLK',
          'NFLX': 'NFLX', 'MU': 'MU', 'BABA': 'BABA', 'USO': 'USO', 'IONQ': 'IONQ', 'SHOP': 'SHOP', 'RBLX': 'RBLX', 'LULU': 'LULU', 'LMT': 'LMT', 'RACE': 'RACE', 'DFDV': 'DFDV'}
NAME_STOCKS = {'NVDA', 'AAPL', 'SPY', 'GOOGL', 'TSLA', 'MSFT', 'AMZN', 'META', 'HOOD', 'COIN', 'QQQ', 'MSTR', 'PLTR', 'GME', 'AMD'}

def universe():
    eco = json.load(open(os.path.join(DATA_DIR, 'crash_eco.json')))['tokens']; U = []
    sf = [t for t in eco if t['eco'] == 'stonkfun' and t.get('quote') in STOCKS and t.get('ds_pair')]
    sf.sort(key=lambda t: -((t.get('vol24') or 0) + (t.get('peak_mcap_src') or 0) / 50))
    per = {}
    for t in sf:
        q = t['quote']
        if per.get(q, 0) >= 4 and t['symbol'] != 'ALLINU': continue
        per[q] = per.get(q, 0) + 1
        U.append({'key': f"solana:{t['address']}", 'symbol': t['symbol'], 'pad': 'StonkFun', 'chain': 'solana', 'pool': t['ds_pair'], 'quote': q, 'stock': STOCKS[q], 'paired': 'quote', 'peak_mcap': t.get('peak_mcap_src'), 'mcap_now': t.get('mcap_now')})
        if len(U) >= 45: break
    for t in eco:
        if t['eco'] in ('robinhood', 'pons') and (t.get('symbol') or '').upper() in NAME_STOCKS and t.get('ds_pair') and (t.get('liq_now') or 0) > 5000:
            U.append({'key': f"{t['chain']}:{t['address']}", 'symbol': t['symbol'], 'pad': t['eco'], 'chain': t['chain'], 'pool': t['ds_pair'].lower(), 'quote': None, 'stock': t['symbol'].upper(), 'paired': 'name', 'mcap_now': t.get('mcap_now')})
    try:
        x7 = http('https://x7pad.com/api/public/coins?limit=200&page=1') or {}
        cs = sorted([c for c in x7.get('coins', []) if (c.get('pair') or '').upper() in STOCKS and c.get('pool')], key=lambda c: -(c.get('volume24hUsd') or 0))[:6]
        for c in cs: U.append({'key': f"solana:{c['mint']}", 'symbol': c['symbol'], 'pad': 'x7', 'chain': 'solana', 'pool': c['pool'], 'quote': c['pair'].upper(), 'stock': STOCKS[c['pair'].upper()], 'paired': 'quote', 'mcap_now': c.get('marketCapUsd')})
    except Exception as e: log('x7 err', e)
    seen, out = set(), []
    for u in U:
        if u['key'] in seen: continue
        seen.add(u['key']); out.append(u)
    return out

def yahoo(sym, interval, rng):
    def f():
        j = http(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={interval}&range={rng}')
        r = (j or {}).get('chart', {}).get('result') or []
        if not r: return None
        r = r[0]; q = r['indicators']['quote'][0]
        return [[t, c] for t, c in zip(r.get('timestamp') or [], q.get('close') or []) if c]
    return cached('yahoo', f'{sym}_{interval}_{rng}', f, max_age=6 * 3600)

def gt(chain, pool, tf, currency='usd', limit=1000):
    net = {'solana': 'solana', 'robinhood': 'robinhood', 'bsc': 'bsc', 'base': 'base'}[chain]
    def f():
        j = http(f'https://api.geckoterminal.com/api/v2/networks/{net}/pools/{pool}/ohlcv/{tf}?aggregate=1&limit={limit}&currency={currency}')
        if not j: return {'rows': []}
        return {'rows': sorted(j['data']['attributes']['ohlcv_list'])}
    return cached('gt_' + tf, f'{net}_{pool}_{currency}', f, max_age=6 * 3600)

def rets(px): return [px[i] / px[i - 1] - 1 for i in range(1, len(px)) if px[i - 1] > 0]

def align_daily(tok_rows, stk):
    td = {dt.datetime.fromtimestamp(r[0], UTC).strftime('%Y-%m-%d'): r[4] for r in tok_rows if r[4]}
    sd = [(dt.datetime.fromtimestamp(t, UTC).strftime('%Y-%m-%d'), c) for t, c in stk]
    pairs = [(d, td[d], c) for d, c in sd if d in td]
    return pairs

def align_hourly(tok_rows, stk):
    th = {r[0]: r[4] for r in tok_rows if r[4]}
    pairs = []
    for t, c in stk:
        k = (int(t) + 3600) // 3600 * 3600 - 3600  # token candle containing the stock bar end
        if k in th: pairs.append((t, th[k], c))
    return pairs

def xcorr(pairs, kmax=3):
    a = [p[1] for p in pairs]; b = [p[2] for p in pairs]
    ra, rb = rets(a), rets(b)
    n = min(len(ra), len(rb)); ra, rb = ra[:n], rb[:n]
    out = {}
    for k in range(-kmax, kmax + 1):
        if k >= 0: x, y = rb[:n - k] if k else rb, ra[k:]
        else: x, y = rb[-k:], ra[:n + k]
        r = pearson(list(x), list(y)); out[str(k)] = round(r, 3) if r is not None else None
    r0 = pearson(ra, rb)
    va = statistics.pvariance(rb) if len(rb) > 2 else 0
    beta = (sum((x - sum(rb) / n) * (y - sum(ra) / n) for x, y in zip(rb, ra)) / n / va) if va else None
    best = max((k for k in out if out[k] is not None and k != '0'), key=lambda k: abs(out[k]), default=None)
    return {'n': n, 'r': round(r0, 3) if r0 is not None else None, 'p': corr_p(r0, n), 'beta': round(beta, 3) if beta is not None else None, 'lags': out, 'best_nonzero_lag': best, 'best_nonzero_r': out.get(best) if best else None}, ra, rb

def divergence(pairs, beta):
    """3-trading-day residual z series. returns list of (date, z, tok3, stk3)."""
    a = [p[1] for p in pairs]; b = [p[2] for p in pairs]; out = []
    res = []
    for i in range(3, len(a)):
        t3 = a[i] / a[i - 3] - 1; s3 = b[i] / b[i - 3] - 1
        res.append((pairs[i][0], t3 - (beta or 0) * s3, t3, s3))
    for j in range(len(res)):
        hist = [r[1] for r in res[max(0, j - 30):j]]
        if len(hist) < 8: continue
        sd = statistics.pstdev(hist) or 1e-9; mu = statistics.mean(hist)
        out.append((res[j][0], (res[j][1] - mu) / sd, res[j][2], res[j][3]))
    return out

def main():
    U = universe(); log('universe', len(U)); out = []
    for i, u in enumerate(U):
        try:
            sd = yahoo(u['stock'], '1d', '1y'); sh = yahoo(u['stock'], '1h', '3mo')
            if not sd: u['err'] = 'no yahoo'; out.append(u); continue
            dd = gt(u['chain'], u['pool'], 'day', limit=365); hh = gt(u['chain'], u['pool'], 'hour')
            dq = gt(u['chain'], u['pool'], 'day', currency='token', limit=365) if u['paired'] == 'quote' else None
        except Exception as e: u['err'] = str(e)[:100]; out.append(u); continue
        drows = [r for r in dd['rows'] if r[4] > 0]
        pd_ = align_daily(drows, sd); ph = align_hourly([r for r in hh['rows'] if r[4] > 0], sh or [])
        u['days'] = len(pd_); u['hours'] = len(ph)
        if len(pd_) >= 15:
            u['daily_usd'], ra, rb = xcorr(pd_)
            # crash detection on token daily closes (UTC days)
            closes = [r[4] for r in drows]; ts = [r[0] for r in drows]
            pi = max(range(len(closes)), key=lambda k: closes[k]); brk = next((k for k in range(pi + 1, len(closes)) if closes[k] <= 0.5 * closes[pi]), None)
            u['peak_date'] = dt.datetime.fromtimestamp(ts[pi], UTC).strftime('%Y-%m-%d'); u['depth_now_pct'] = round((closes[-1] / closes[pi] - 1) * 100, 1)
            u['crash_break_date'] = dt.datetime.fromtimestamp(ts[brk], UTC).strftime('%Y-%m-%d') if brk else None
            dv = divergence(pd_, u['daily_usd']['beta'])
            flags = [(d, round(z, 2), round(t3 * 100, 1), round(s3 * 100, 1)) for d, z, t3, s3 in dv if z <= -2 and s3 >= -0.02]
            u['neg_div_flags'] = flags; u['div_days'] = len(dv)
            if dv: u['div_now'] = {'date': dv[-1][0], 'z': round(dv[-1][1], 2), 'tok3_pct': round(dv[-1][2] * 100, 1), 'stk3_pct': round(dv[-1][3] * 100, 1)}
            if u['crash_break_date']:
                pre = [f for f in flags if u['peak_date'] <= f[0] < u['crash_break_date'] or (f[0] < u['crash_break_date'] and f[0] >= (dt.datetime.strptime(u['crash_break_date'], '%Y-%m-%d') - dt.timedelta(days=10)).strftime('%Y-%m-%d'))]
                u['flag_before_break'] = bool(pre)
                u['lead_days'] = (dt.datetime.strptime(u['crash_break_date'], '%Y-%m-%d') - dt.datetime.strptime(pre[0][0], '%Y-%m-%d')).days if pre else None
        if dq and len(dq['rows']) > 15:
            pq = align_daily([r for r in dq['rows'] if r[4] > 0], sd)
            if len(pq) >= 15: u['daily_in_quote'], _, _ = xcorr(pq)
        if len(ph) >= 40: u['hourly_usd'], _, _ = xcorr(ph, kmax=6)
        out.append(u); log(i, u['symbol'], u['stock'], u.get('days'), (u.get('daily_usd') or {}).get('r'), (u.get('daily_in_quote') or {}).get('r'), (u.get('hourly_usd') or {}).get('r'))
    ok = [u for u in out if u.get('daily_usd')]
    crashed = [u for u in ok if u.get('crash_break_date')]; non = [u for u in ok if not u.get('crash_break_date')]
    # FP: flags on non-crash tokens per token-day; and flags on crashed tokens outside the 10d pre-break window
    fp_days = sum(len(u['neg_div_flags']) for u in non); tot_days = sum(u['div_days'] for u in non)
    def med(xs): xs = [x for x in xs if x is not None]; return round(statistics.median(xs), 3) if xs else None
    summ = {'n_universe': len(U), 'n_with_daily': len(ok), 'n_with_hourly': sum(1 for u in ok if u.get('hourly_usd')),
            'median_r_daily_usd': med([u['daily_usd']['r'] for u in ok]), 'median_r_daily_in_quote': med([u['daily_in_quote']['r'] for u in ok if u.get('daily_in_quote')]),
            'median_r_hourly_usd': med([u['hourly_usd']['r'] for u in ok if u.get('hourly_usd')]),
            'share_sig_pos_daily_usd': round(sum(1 for u in ok if u['daily_usd']['r'] and u['daily_usd']['r'] > 0 and (u['daily_usd']['p'] or 1) < 0.05) / len(ok), 3) if ok else None,
            'lead_lag_best_lag_counts_daily': {k: sum(1 for u in ok if u['daily_usd']['best_nonzero_lag'] == k) for k in ('-3', '-2', '-1', '1', '2', '3')},
            'median_lag_r_daily': {k: med([u['daily_usd']['lags'][k] for u in ok]) for k in ('-3', '-2', '-1', '0', '1', '2', '3')},
            'median_lag_r_hourly': {k: med([u['hourly_usd']['lags'][k] for u in ok if u.get('hourly_usd')]) for k in [str(x) for x in range(-6, 7)]},
            'crashed_tokens': len(crashed), 'crashed_with_neg_div_flag_within_10d_before_break': sum(1 for u in crashed if u.get('flag_before_break')),
            'lead_days': sorted(u['lead_days'] for u in crashed if u.get('lead_days') is not None),
            'non_crash_tokens': len(non), 'non_crash_tokens_with_any_flag': sum(1 for u in non if u['neg_div_flags']), 'fp_flag_days_per_token_day_non_crash': round(fp_days / tot_days, 4) if tot_days else None,
            'live_flags': [{'symbol': u['symbol'], 'stock': u['stock'], 'pad': u['pad'], **u['div_now']} for u in ok if u.get('div_now') and abs(u['div_now']['z']) >= 2]}
    save('patterns_stocks.json', {'summary': summ, 'tokens': out, 'rule': 'negative divergence = 3-trading-day residual (token - beta*stock) z <= -2 vs prior 30 obs while stock 3d >= -2%; live flag |z|>=2 on the latest day'})

if __name__ == '__main__': main()
