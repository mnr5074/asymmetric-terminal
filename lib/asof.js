'use strict';
// Data-as-of stamps (2026-10-18). Every /api/* JSON response gets an `x-data-asof` header (+ `_asof` in the body) naming WHEN the data
// it carries was produced, not when it was served: the first embedded timestamp found (dataAsOf, countsUpdatedAt, updatedAt, asOf,
// savedAt, snapshotAt, fetchedAt, generatedAt) — generatedAt only counts if it is older than the request (otherwise the payload was
// computed on request from in-memory/live inputs and is labelled 'computed live'). On the box, a file-backed route with no embedded
// time falls back to the data file mtime. On Render (RENDER_LITE) mtimes are deploy/copy times, so they are never used: those routes
// are labelled as the deploy-time snapshot. /api/asof returns server start, image build time and the snapshot time (newest embedded
// timestamp across data/*.json, i.e. when the box last wrote the data that was committed and deployed). public/asof.js renders it.
const fs = require('fs');
const path = require('path');

const KEYS = ['dataAsOf', 'countsUpdatedAt', 'updatedAt', 'asOf', 'savedAt', 'snapshotAt', 'fetchedAt', 'generatedAt'];
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v)) { const t = Date.parse(v); return isFinite(t) ? t : null; }
  return null;
}
function createAsOf({ DATA_DIR, root, lite }) {
  const startedAt = Date.now();
  let buildAt = null; try { buildAt = toMs(fs.readFileSync(path.join(root, 'BUILD_TIME'), 'utf8').trim()); } catch {}
  let snap = null;
  function snapshot() { // newest embedded timestamp across top-level data/*.json (head of each file only; cheap)
    if (snap && (lite || Date.now() - snap.at < 10 * 60e3)) return snap; // lite: computed once at boot, before this server writes anything
    let best = 0, src = null, n = 0;
    try {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.endsWith('.json') || /^(restart|supervisor|keyhealth|x_budget|grok_budget|nansen_budget|provenance|firstseen|fplog|papertrade|riskinfra_boots)/.test(f)) continue;
        let fd; try { fd = fs.openSync(path.join(DATA_DIR, f), 'r'); const b = Buffer.alloc(4096); const k = fs.readSync(fd, b, 0, 4096, 0); const s = b.toString('utf8', 0, k);
          for (const key of ['generatedAt', 'updatedAt', 'savedAt']) { const m = s.match(new RegExp('"' + key + '"\\s*:\\s*("([^"]+)"|(\\d{10,13}))')); const t = m ? toMs(m[2] || +m[3]) : null; if (t && t <= Date.now() + 60e3 && t > best) { best = t; src = f; } }
          n++; } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
      }
    } catch {}
    snap = { at: Date.now(), t: best || null, src, files: n }; return snap;
  }
  function compute(out, servedAt = Date.now()) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
    for (const k of KEYS) {
      const t = toMs(out[k]); if (!t || t > servedAt + 60e3) continue;
      if (k === 'generatedAt' && servedAt - t < 3000) continue; // computed on this request
      return { t, src: k, snapshot: !!lite };
    }
    const p = out._prov;
    if (!lite && p && Array.isArray(p.files) && p.files.length) { const ts = p.files.map((f) => toMs(f.mtime)).filter(Boolean); if (ts.length) return { t: Math.min(...ts), src: 'file mtime', snapshot: false }; }
    const g = toMs(out.generatedAt);
    if (g) return lite ? { t: null, src: 'snapshot (no embedded time)', snapshot: true } : { t: g, src: 'computed live', live: true, snapshot: false };
    return lite ? { t: null, src: 'snapshot (no embedded time)', snapshot: true } : null;
  }
  function header(a) { return a ? { 'x-data-asof': a.t ? new Date(a.t).toISOString() : '', 'x-data-asof-src': a.src, 'x-data-snapshot': a.snapshot ? '1' : '0' } : {}; }
  function info() {
    const s = lite ? snapshot() : null;
    return { lite: !!lite, now: Date.now(), tz: 'America/Los_Angeles', serverStartedAt: startedAt, buildAt, commit: process.env.RENDER_GIT_COMMIT ? String(process.env.RENDER_GIT_COMMIT).slice(0, 7) : null,
      snapshotAt: s?.t || null, snapshotSrc: s?.src || null,
      text: lite ? 'Render snapshot: this deploy serves data frozen from the box at deploy time; no collectors run here, so nothing updates live.' : 'Box server: collectors run continuously; each panel shows when its own data was produced.' };
  }
  if (lite) snapshot(); // freeze the snapshot time at boot
  return { compute, header, info, snapshot };
}
module.exports = { createAsOf, toMs };
