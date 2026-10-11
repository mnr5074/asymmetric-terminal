import json, math
D='data/'
nan=float('nan')
def m(x, d=1): return '–' if x is None or (isinstance(x,float) and not math.isfinite(x)) else f'{x/1e6:,.{d}f}'
def pc(x, d=1): return '–' if x is None or (isinstance(x,float) and not math.isfinite(x)) else f'{x:+.{d}f}%'
out=[]
r=json.load(open(D+'buyburn_revenue.json'))['rows']
out.append('| # | Protocol | Token | Category | Fees 30d $M | Revenue 30d $M | Rev annualized $M | Rev vs prior 30d | Rev 90d vs prior 90d | Holders rev (buyback/burn) 30d $M |')
out.append('|---|---|---|---|---|---|---|---|---|---|')
for i,x in enumerate(r):
    out.append(f"| {i+1} | {x.get('name') or x['key']} | {x.get('symbol') or '–'} | {x.get('category') or '–'} | {m(x.get('fees_30d'))} | {m(x.get('rev_30d'),2)} | {m(x.get('rev_annualized'),0)} | {pc(x.get('rev_chg30_pct'))} | {pc(x.get('rev_chg90_pct'))} | {m(x.get('hrev_30d'),2)} |")
out.append('')
t=json.load(open(D+'buyburn_tokens.json'))['tokens']
out.append('| Token | Mechanism | Program start (DefiLlama series) | Cum. bought USD $M | Cum. tokens (M) | Cum. as % circ now | Avg/day last 90d (tokens) | Avg/day last 90d $k | Median % of daily vol (90d) |')
out.append('|---|---|---|---|---|---|---|---|---|')
for x in t:
    out.append(f"| {x['sym']} | {x['type']} | {x.get('program_start') or '–'} | {m(x.get('cum_usd'))} | {m(x.get('cum_tokens'),2)} | {pc(x.get('cum_pct_of_circ_now'),2).replace('+','')} | {('%s' % f'{x['tokens_per_day_90d']:,.0f}') if x.get('tokens_per_day_90d') else '–'} | {('%.0f' % (x['usd_per_day_90d']/1e3)) if x.get('usd_per_day_90d') else '–'} | {('%.3f%%' % x['pct_vol_median_90d']) if x.get('pct_vol_median_90d') is not None and math.isfinite(x['pct_vol_median_90d']) else '–'} |")
out.append('')
p=json.load(open(D+'buyburn_projections.json'))['tokens']
out.append('| Token | Circ now (M) | Burn/day (tokens) | Burn %circ/yr | 1m | 3m | 6m | 9m | 1y | 2y | 3y | 1y burned (M) | 1y unlocked (M) | Unlock basis |')
out.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for s,x in p.items():
    w=x['windows']
    out.append(f"| {s} | {x['circ_now']/1e6:,.1f} | {x['burn_per_day']:,.0f} | {x['burn_pct_circ_per_year']:.2f}% | " + ' | '.join(pc(w[k]['net_change_pct']) for k in ['1m','3m','6m','9m','1y','2y','3y']) + f" | {w['1y']['burned_tokens']/1e6:,.2f} | {w['1y']['unlocked_tokens']/1e6:,.2f} | {x.get('unlock_basis','–')[:70]} |")
out.append('')
e=json.load(open(D+'buyburn_events.json'))['events']
out.append('| Token | Date | Amount | USD $M | % circ | % 30d-avg daily vol | Ret 24h | XS 24h | XS 7d | XS 30d | Date quality |')
out.append('|---|---|---|---|---|---|---|---|---|---|---|')
for x in e:
    if x['sym'] in ('BNB','OKB') and x['date'] < '2024-01-01': continue
    out.append(f"| {x['sym']} | {x['date']} | {x['amount']:,.0f} | {m(x.get('usd'))} | {x['pct_circ']:.2f}% | {('%.0f%%' % x['pct_dailyvol']) if x.get('pct_dailyvol') is not None and math.isfinite(x['pct_dailyvol']) else '–'} | {pc(x.get('ret_24h'))} | {pc(x.get('xs_24h'))} | {pc(x.get('xs_7d'))} | {pc(x.get('xs_30d'))} | {x['quality']} |")
open('tables.md','w').write('\n'.join(out))
