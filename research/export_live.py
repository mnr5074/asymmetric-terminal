#!/usr/bin/env python3
"""Exports what the Live Alpha Feed (lib/livefeed.js) needs from the research DB into data/live_model.json,
so the Node server (box or Render) can use it without SQLite:
  - moonshot-similarity model (binned naive-Bayes likelihood ratios, same as screener.py)
  - theme regexes
  - "smart wallets": owners that were top holders of >=2 'mooned' tokens and rarely of 'died' ones.
    NOTE: these are top holders at snapshot time, not proven early buyers (free data has no full early-buyer history).
Run after analyze.py. Heuristic; not advice."""
import json, os, time
from common import db, DATA_DIR, THEMES
import screener

def main():
    c = db()
    rows = [dict(r) for r in c.execute("SELECT * FROM tokens WHERE cohort IN ('mooned','died') AND COALESCE(chain,'solana')='solana'")]
    mdl = screener.model(rows)
    q = """SELECT h.owner, SUM(t.cohort='mooned') m, SUM(t.cohort='died') d, COUNT(DISTINCT h.mint) n,
                  GROUP_CONCAT(CASE WHEN t.cohort='mooned' THEN t.symbol END) syms
           FROM top_holders h JOIN tokens t ON t.mint = h.mint GROUP BY h.owner"""
    sw = []
    for owner, m, d, n, syms in c.execute(q):
        # exclude infrastructure (AMM/vault/exchange accounts show up everywhere) and losers
        if m >= 2 and d <= m // 2 and n <= 6:
            sw.append({'wallet': owner, 'mooned': m, 'died': d, 'tokens': (syms or '').split(',')[:6]})
    sw.sort(key=lambda x: (-x['mooned'], x['died']))
    out = {'generatedAt': int(time.time() * 1000), 'model': mdl, 'themes': THEMES, 'smartWallets': sw,
           'notes': 'Model: binned likelihood ratios mooned (>=100x) vs died, Solana only; artifact-flagged features excluded. Smart wallets = top holders of >=2 mooned tokens, at most half as many died ones, appearing in <=6 tokens (filters out AMM/exchange accounts).'}
    json.dump(out, open(os.path.join(DATA_DIR, 'live_model.json'), 'w'))
    print('model num feats', list(mdl['num']), 'cat feats', list(mdl['cat']), 'smart wallets', len(sw), sw[:3])

if __name__ == '__main__': main()
