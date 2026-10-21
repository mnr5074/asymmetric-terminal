#!/usr/bin/env python3
"""Log one of Martin's gut calls into data/martin_calls.json (then re-score -> data/martin_calls_scored.json, /api/mycalls).

  python3 scripts/log_call.py add --symbol CYPHERCAT --chain solana --contract 6AUU... --call "looking like it's waking up" \\
      --time "2026-10-21 01:46" [--note "..."] [--price 0.00085 --quote Jupiter=0.000837 --quote CoinGecko=0.000851] \\
      [--gibi "stay out" --gibi-why "..." --gibi-trigger 0.001 --gibi-trigger-tf 4h --gibi-walkaway 0.0016 --gibi-walkaway-tf 1d] [--pool <pool>]
  python3 scripts/log_call.py list
  python3 scripts/log_call.py remove --id <id>
  python3 scripts/log_call.py score

--time: 'now' (default), 'YYYY-MM-DD HH:MM' or 'H:MM AM' (Pacific), or ISO with offset.
Price at call (never invented):
  --price given           -> 'reported' (the price quoted at the time; --quote SRC=PRICE lists the sources)
  call within 15 minutes  -> 'live': fetched now from DexScreener (deepest pair, lib/liveprice.js order)
  older call (backfill)   -> 'backfill': hourly candle close nearest the call time (GeckoTerminal; USD rebuilt via the quote token for
                             non-SOL/USDC pools), labelled as a backfill. No candle -> the call is refused rather than guessed."""
import argparse, json, os, re, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'research', 'mycalls'))
import mc

def price_at_call(a, t):
    if a.price is not None:
        q = []
        for s in a.quote or []:
            k, _, v = s.partition('='); q.append({'src': k.strip(), 'usd': float(v)})
        return {'usd': a.price, 'how': 'reported', 'label': a.price_label or ('price quoted at call time' + (' (' + ', '.join(f'{x["src"]} ${x["usd"]:g}' for x in q) + ')' if q else '')), 'quotes': q, 'at': t * 1000}
    if abs(time.time() - t) <= 15 * 60:
        live = mc.dexscreener(a.chain, [a.contract]).get(a.contract)
        if live: return {'usd': live['usd'], 'how': 'live', 'label': f'fetched at logging time ({time.strftime("%-I:%M %p", time.localtime())} PT) from DexScreener, deepest pair', 'src': 'DexScreener', 'at': int(time.time() * 1000)}
    ser = mc.usd_series(a.chain, a.contract, a.pool)
    bars = (ser or {}).get('bars') or []
    if not bars: sys.exit('no price source: DexScreener had no pair and no hourly candles exist; pass --price with the quoted price')
    b = min(bars, key=lambda b: abs(b[0] + mc.HOUR - t))
    if abs(b[0] + mc.HOUR - t) > 6 * mc.HOUR: sys.exit(f'nearest hourly candle is {abs(b[0] + mc.HOUR - t) / 3600:.1f}h from the call time; pass --price instead of guessing')
    return {'usd': b[4], 'how': 'backfill', 'label': f'BACKFILLED: hourly candle close at {mc.pt_str(b[0] + mc.HOUR)} (nearest the call time; {ser["how"]}), not a quote taken at the time', 'at': (b[0] + mc.HOUR) * 1000}

def gibi(a):
    if not a.gibi: return {'verdict': 'not asked', 'why': 'no Gibi verdict was recorded at the time'}
    g = {'verdict': a.gibi, 'why': a.gibi_why or ''}
    if a.gibi_trigger: g['entryTrigger'] = {'tf': a.gibi_trigger_tf, 'closeAbove': a.gibi_trigger}
    if a.gibi_walkaway: g['walkAway'] = {'tf': a.gibi_walkaway_tf, 'closeBelow': a.gibi_walkaway}
    return g

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest='cmd', required=True)
    ad = sp.add_parser('add')
    ad.add_argument('--symbol', required=True); ad.add_argument('--chain', required=True, choices=sorted(mc.NET)); ad.add_argument('--contract', required=True)
    ad.add_argument('--call', required=True, help="Martin's words, verbatim"); ad.add_argument('--thesis', help='longer thesis in his words (defaults to --call)')
    ad.add_argument('--time', default='now'); ad.add_argument('--note', action='append'); ad.add_argument('--pool')
    ad.add_argument('--price', type=float); ad.add_argument('--price-label'); ad.add_argument('--quote', action='append', help='SRC=PRICE quoted at call time')
    ad.add_argument('--gibi', help="Gibi's verdict at the time, e.g. 'stay out' or 'buy starter'"); ad.add_argument('--gibi-why')
    ad.add_argument('--gibi-trigger', type=float, help='entry trigger: close above'); ad.add_argument('--gibi-trigger-tf', default='4h', choices=['1h', '4h', '1d'])
    ad.add_argument('--gibi-walkaway', type=float, help='walk-away: close below'); ad.add_argument('--gibi-walkaway-tf', default='1d', choices=['1h', '4h', '1d'])
    ad.add_argument('--id'); ad.add_argument('--no-score', action='store_true')
    rm = sp.add_parser('remove'); rm.add_argument('--id', required=True)
    sp.add_parser('list'); sp.add_parser('score')
    a = ap.parse_args(); C = mc.load_calls()
    if a.cmd == 'list':
        for c in C['calls']: print(f'{c["id"]:32} {c["symbol"]:10} {c["chain"]:9} {mc.pt_str(c["calledAt"] // 1000):26} ${c["priceAtCall"]["usd"]:.6g} ({c["priceAtCall"]["how"]})  gibi: {c["gibi"]["verdict"]}')
        return
    if a.cmd == 'remove':
        n = len(C['calls']); C['calls'] = [c for c in C['calls'] if c['id'] != a.id]
        if len(C['calls']) == n: sys.exit('no call with id ' + a.id)
        mc.save_json(mc.CALLS_F, C); print('removed', a.id); return
    if a.cmd == 'add':
        if a.chain == 'solana' and not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', a.contract): sys.exit('bad Solana address')
        if a.chain != 'solana' and not re.fullmatch(r'0x[0-9a-fA-F]{40}', a.contract): sys.exit('bad EVM address')
        if a.chain != 'solana': a.contract = a.contract.lower()
        t = mc.parse_time(a.time)
        if t > time.time() + 120: sys.exit('call time is in the future')
        cid = a.id or time.strftime('%Y-%m-%d', time.localtime(t)) + '-' + re.sub(r'[^a-z0-9]+', '', a.symbol.lower())
        if any(c['id'] == cid for c in C['calls']): sys.exit(f'id {cid} exists (pass --id, or remove it first)')
        c = {'id': cid, 'symbol': a.symbol.upper(), 'chain': a.chain, 'contract': a.contract, 'pool': a.pool, 'calledAt': t * 1000, 'calledAtPT': mc.pt_str(t),
             'call': a.call, 'thesis': a.thesis or a.call, 'priceAtCall': price_at_call(a, t), 'gibi': gibi(a), 'notes': a.note or [],
             'addedAt': int(time.time() * 1000), 'addedVia': 'scripts/log_call.py'}
        C.setdefault('version', 1); C['calls'].append(c); C['calls'].sort(key=lambda x: x['calledAt'])
        mc.save_json(mc.CALLS_F, C); print(json.dumps(c, indent=1))
        if a.no_score: return
    subprocess.run([sys.executable, os.path.join(ROOT, 'research', 'mycalls', 'score.py')], check=False)

if __name__ == '__main__': main()
