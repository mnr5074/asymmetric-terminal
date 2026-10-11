'use strict';
// Insider-privilege pattern desk + Velvet post-crash exposé (read-only).
// Data: data/insider_pattern.json (research/insider_pattern/*.py; INSIDER_PATTERN_REPORT.md) and data/velvet_postcrash.json +
// research/velvet_postcrash.md. Patterns scored 0-3: P1 hidden vesting / OTC / intermediary hops (early sellers), P2 undisclosed promoters
// paid from team/marketing wallets, P3 lopsided airdrop / liquidity asymmetry, P4 cosmetic LP locks. "-" (null) = not assessed.
// Live wiring: compositeFactor() = small negative adjustment + warning when a ranked token appears in the composite universe
// (address match for live/screener rows; symbol match for perp rows only when the symbol is >= 3 chars), and a signal-bus plugin
// ('insider_pattern', claim crash, low severity) so the false-positive log auto-labels those tokens like every other detector.
const fs = require('fs');
const path = require('path');
const P = { P1: 'Hidden vesting / OTC transfers / intermediary hops', P2: 'Undisclosed promoters funded by team or marketing wallets', P3: 'Lopsided airdrop vs liquidity (asymmetry)', P4: 'Cosmetic LP locks / liquidity' };
function createInsider({ DATA_DIR, root }) {
  const mem = {};
  const readJ = (f) => { const p = path.join(DATA_DIR, f); try { const st = fs.statSync(p); if (mem[f]?.m === st.mtimeMs) return mem[f].d; const d = JSON.parse(fs.readFileSync(p, 'utf8')); mem[f] = { m: st.mtimeMs, d, ageSec: 0 }; return d; } catch { return null; } };
  const total = (c) => Object.values(c.scores || {}).reduce((a, b) => a + (b || 0), 0);
  function index() {
    const d = readJ('insider_pattern.json'); const byAddr = new Map(), bySym = new Map();
    for (const c of d?.candidates || []) { if (c.address) byAddr.set(String(c.address).toLowerCase(), c); const s = String(c.token || '').split(' ')[0].toUpperCase(); if (s.length >= 3 && !bySym.has(s)) bySym.set(s, c); }
    return { d, byAddr, bySym };
  }
  function find({ address, sym } = {}) { const I = index(); return (address && I.byAddr.get(String(address).toLowerCase())) || (sym && I.bySym.get(String(sym).toUpperCase())) || null; }
  function compositeFactor(q) {
    const c = find(q); if (!c) return null; const t = total(c);
    const hi = Object.entries(c.scores || {}).filter(([, v]) => v >= 2).map(([k]) => k);
    return { adj: -Math.min(8, Math.round(t * 0.75)), value: `#${c.rank} ${Object.entries(c.scores || {}).map(([k, v]) => `${k}=${v ?? '–'}`).join(' ')}`,
      text: `Insider-privilege scan rank #${c.rank} (${c.token}): ${hi.map((k) => P[k]).join('; ') || 'low-level flags'}. Confidence ${c.confidence}. Evidence with tx hashes in /api/insider (INSIDER_PATTERN_REPORT.md). Not an accusation of fraud.`,
      warn: t >= 6 ? `Insider-privilege pattern: ${c.token} ranked #${c.rank} (score ${t}/12)` : null };
  }
  function signalPlugin(getUniverse) {
    return { id: 'insider_pattern', name: 'Insider-privilege pattern scan', desk: 'rug', claim: 'crash', async live() {
      const I = index(); const out = []; const U = (await getUniverse?.()) || [];
      for (const x of U) { const c = (x.address && I.byAddr.get(String(x.address).toLowerCase())) || (x.sym && I.bySym.get(String(x.sym).toUpperCase())); if (!c) continue;
        out.push({ token: x.address ? { key: `${x.chain}:${x.address}`, chain: x.chain, address: x.address, symbol: x.sym } : { key: 'perp:' + x.sym, chain: 'perp', symbol: x.sym }, price: x.price ?? null,
          severity: 'low', strength: Math.min(1, total(c) / 12), values: c.scores, reason: `${c.token}: insider-privilege scan rank #${c.rank} (${Object.entries(c.scores).map(([k, v]) => `${k}=${v ?? '–'}`).join(' ')})`, source: 'data/insider_pattern.json' }); }
      return out; } };
  }
  function api(q) {
    const I = index(); if (!I.d) return { ok: false, error: 'data/insider_pattern.json missing: run research/insider_pattern/build_report.py' };
    const tok = q?.get?.('token');
    const rows = (I.d.candidates || []).map((c) => ({ ...c, total: total(c) }));
    if (tok) return { ok: true, item: rows.find((c) => c.token.toUpperCase().startsWith(tok.toUpperCase()) || String(c.address).toLowerCase() === tok.toLowerCase()) || null };
    let md = null; try { md = fs.readFileSync(path.join(root, 'INSIDER_PATTERN_REPORT.md'), 'utf8'); } catch {}
    return { ok: true, generatedAt: I.d.generatedAt, method: I.d.method, patterns: P, nansen_run: I.d.nansen_run, candidates: rows, report_md: md, nfa: 'Public on-chain data and attributed reports. A transfer to an exchange is not proof of a sale. Not an accusation of fraud, not financial advice.' };
  }
  function velvet(q) {
    const d = readJ('velvet_postcrash.json'); let md = null; try { md = fs.readFileSync(path.join(root, 'research', 'velvet_postcrash.md'), 'utf8'); } catch {}
    if (!d && !md) return { ok: false, error: 'velvet_postcrash not built' };
    if (q?.get?.('full') === '1') return { ok: true, data: d, report_md: md };
    const { price_timeline, holdings_now, ...rest } = d || {};
    return { ok: true, summary: { ...rest, price_timeline_points: Array.isArray(price_timeline) ? price_timeline.length : null, holdings_now: Array.isArray(holdings_now) ? holdings_now.slice(0, 25) : holdings_now }, insider_row: find({ sym: 'VELVET' }), report_md: md, pdf_path: 'research/velvet_postcrash.pdf' };
  }
  return { api, velvet, find, compositeFactor, signalPlugin,
    routes() { return { async '/api/insider'(q) { return api(q); }, async '/api/insider/velvet'(q) { return velvet(q); } }; } };
}
module.exports = { createInsider, PATTERNS: P };
