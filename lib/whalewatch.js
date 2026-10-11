// Free-data whale-exit tracking: snapshots the top-holder list each time the live feed scans a token (RugCheck / GoPlus / RPC data
// already fetched by the scanner, so no extra API calls) and detects big holders cutting or exiting positions between snapshots.
'use strict';
const norm = (h) => ({ a: String(h.owner || h.a || h.address || '').toLowerCase(), p: +(h.p ?? h.pct ?? h.percent ?? 0), skip: !!(h.contract || h.locked || h.lp || /pool|lp|burn|lock/i.test(h.tag || h.label || '')) });
function snapshot(r, tops) {
  const hs = (tops || []).map(norm).filter((h) => h.a && h.p > 0 && !h.skip).slice(0, 15);
  if (!hs.length) return;
  r.whaleHist = r.whaleHist || []; r.whaleHist.push({ t: Date.now(), top: Object.fromEntries(hs.map((h) => [h.a, +h.p.toFixed(4)])) });
  if (r.whaleHist.length > 40) r.whaleHist.shift();
}
/** Compare the latest snapshot with the oldest one inside the window (default 72h). */
function exits(r, windowH = 72) {
  const H = r.whaleHist || []; if (H.length < 2) return null;
  const now = H[H.length - 1]; const base = H.find((x) => now.t - x.t <= windowH * 3600e3 && now.t - x.t >= 3600e3) ; if (!base) return null;
  const minNow = Math.min(...Object.values(now.top));
  const out = [];
  for (const [a, p0] of Object.entries(base.top)) {
    if (p0 < 0.5) continue;
    const p1 = now.top[a]; const p1e = p1 ?? null;                 // null = dropped out of the tracked top list (balance <= smallest tracked share)
    const cut = p1e == null ? Math.max(0, p0 - minNow) : p0 - p1e;
    if (cut >= 0.5 && (p1e == null || p1e <= p0 * 0.5)) out.push({ wallet: a, beforePct: p0, nowPct: p1e, cutPct: +cut.toFixed(3), left: p1e == null });
  }
  if (!out.length) return { hours: Math.round((now.t - base.t) / 3600e3), exits: [], cutPct: 0 };
  const cutPct = +out.reduce((s, x) => s + x.cutPct, 0).toFixed(2);
  return { hours: Math.round((now.t - base.t) / 3600e3), exits: out.sort((x, y) => y.cutPct - x.cutPct).slice(0, 6), cutPct,
    text: `${out.length} top holder${out.length > 1 ? 's' : ''} cut ${cutPct}% of supply in ${Math.round((now.t - base.t) / 3600e3)}h` };
}
module.exports = { snapshot, exits };
