'use strict';
// On-chain context per token for the report, read from the terminal's own research outputs if present:
// live feed (grade + rug forecast), crash catalog (historical collapses), rug case studies. Read-only, best effort.
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
function tokenContext(symbols) {
  const live = rd('live_feed.json'), cat = rd('crash_catalog.json'), rug = rd('rug_cases.json');
  const out = {};
  for (const s0 of symbols) {
    const s = String(s0).toUpperCase(); const lines = [];
    const li = (live?.items || []).filter((x) => String(x.symbol || '').toUpperCase() === s).sort((a, b) => (b.liq || 0) - (a.liq || 0))[0];
    if (li) lines.push(`Live feed (${li.chain}): grade ${li.grade}${li.veto ? ' (vetoed)' : ''}, rug forecast ${li.rug?.score ?? '-'} (${li.rug?.level || '-'})${li.rug?.top?.length ? ': ' + li.rug.top.slice(0, 2).join('; ') : ''}${li.liq ? `, liquidity $${Math.round(li.liq).toLocaleString()}` : ''}`);
    for (const c of (cat?.catalog || []).filter((c) => String(c.symbol || '').toUpperCase() === s).slice(0, 1))
      lines.push(`Crash catalog: ${c.name} - ATH ${c.ath} on ${c.ath_date}, now ${c.price_now} (${Math.round(c.crash_depth_pct)}% from ATH)${c.launchpad ? `, ${c.launchpad}` : ''}`);
    for (const c of (rug?.case_studies || []).filter((c) => String(c.symbol || '').toUpperCase() === s).slice(0, 1))
      lines.push(`Rug case study: ${c.label}${c.ath_date ? `, ATH ${c.ath_date}` : ''}`);
    if (lines.length) out[s] = lines;
  }
  return out;
}
module.exports = { tokenContext };
