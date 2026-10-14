'use strict';
// "First posted / Updated" stamps for every pick/setup/alert card (Martin, Oct 2026).
// Walks selected API payloads, finds pick-like objects (an id field + a signal field), and adds `_fs: { f, u, c }`:
//   f = first time this pick was ever served (ms), u = last time its score/label/grade changed (ms, null if never), c = what changed.
// Persisted to data/firstseen.json (atomic write, debounced) so it survives restarts; the file is committed as a snapshot for Render.
// If the item carries its own creation time (t / ts / firstSeen / createdAt) and that is earlier, it is used as `f`.
const fs = require('fs');
const path = require('path');
const ROUTES = new Set(['/api/fplog', '/api/flatbase', '/api/options', '/api/desks', '/api/alerts/ranked', '/api/sleepers', '/api/calls', '/api/priority', '/api/accumulation']);
const IDS = ['key', 'address', 'mint', 'id', 'instrument', 'symbol', 'sym', 'ticker', 'underlying'];
const SIG = ['label', 'grade', 'verdict', 'tier', 'severity', 'state', 'action', 'status', 'score'];
const EXTRA_ID = ['type', 'strike', 'expiry', 'detector', 'chain']; // option contracts: underlying+type+strike+expiry
const OWN_T = ['firstSeen', 'first_seen', 'createdAt', 'created_at', 't', 'ts'];
// price-at-alert: first price seen with the pick (or its own px0 / price_at_call), 'now' = price in the current payload
const PX = ['price', 'priceUsd', 'price_usd', 'px', 'pxNow', 'close', 'last', 'mid', 'spot'];
const PX0 = ['px0', 'price_at_call', 'priceAtAlert', 'entry'];
const STOP = ['stop', 'stop_price', 'stopPrice', 'walkAway', 'walk_away', 'invalidation', 'invalidate_below'];
const FRESH = ['dataAsOf', 'priceAt', 'updatedAt', 'fetchedAt', 'asOf', 'at'];
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : typeof v === 'string' && +v > 0 ? +v : null);
const pick = (o, ks) => { for (const k of ks) { const v = num(o[k]); if (v != null) return v; } return null; };
const pxOf = (o) => pick(o, PX) ?? (o.m && typeof o.m === 'object' ? pick(o.m, ['close', 'price']) : null);
const stopOf = (o) => pick(o, STOP) ?? (o.m && typeof o.m === 'object' ? num(o.m.baseLo) : null); // flat-base: walk away below the base low
const freshOf = (o, now) => { for (const k of FRESH) { let v = o[k]; if (typeof v === 'string') v = Date.parse(v); if (typeof v === 'number' && v > 1e9) return v < 1e12 ? v * 1000 : v; } return now; };
const broken = (o) => !!(o.veto || (num(o.rugRisk) || 0) >= 50 || o.rugged || o.invalidated || /invalid|rug/i.test(String(o.label || o.verdict || '')) || (Array.isArray(o.flags) && o.flags.some((f) => /rug|honeypot|danger/i.test(String(f)))));
const MAX = 60000, KEEP_MS = 90 * 86400e3, WALK_CAP = 25000;

function createFirstSeen({ DATA_DIR, log = () => {}, readOnly = false }) {
  const file = path.join(DATA_DIR, 'firstseen.json');
  let M = {}; try { M = JSON.parse(fs.readFileSync(file, 'utf8')).items || {}; } catch {}
  let dirty = false, timer = null;
  const save = () => {
    timer = null; if (!dirty || readOnly) return; dirty = false;
    const now = Date.now(); const ks = Object.keys(M);
    for (const k of ks) if (now - (M[k].seen || M[k].f) > KEEP_MS) delete M[k];
    const left = Object.keys(M); if (left.length > MAX) left.sort((a, b) => (M[a].seen || 0) - (M[b].seen || 0)).slice(0, left.length - MAX).forEach((k) => delete M[k]);
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: now, items: M })); fs.renameSync(tmp, file); } catch (e) { log('[firstseen] save: ' + e.message); }
  };
  const later = () => { dirty = true; if (!timer) { timer = setTimeout(save, 60e3); timer.unref?.(); } };
  process.once('exit', save); // sync write on exit; no SIGTERM handler (must not delay the supervisor's restarts)

  const idOf = (o) => { const f = IDS.find((k) => o[k] != null && o[k] !== '' && typeof o[k] !== 'object'); if (!f) return null; return [o[f], ...EXTRA_ID.filter((k) => o[k] != null && typeof o[k] !== 'object').map((k) => o[k])].join('|'); };
  const sigOf = (o) => { const p = {}; let any = false; for (const k of SIG) if (o[k] != null && typeof o[k] !== 'object') { p[k] = k === 'score' && typeof o[k] === 'number' ? Math.round(o[k]) : o[k]; any = true; } return any ? p : null; };
  const ownT = (o) => { for (const k of OWN_T) { let v = o[k]; if (typeof v === 'string') v = Date.parse(v); if (typeof v === 'number' && v > 1e9) { if (v < 1e12) v *= 1000; if (v > Date.now() - 2 * 365 * 86400e3 && v <= Date.now() + 60e3) return v; } } return null; };
  const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k] ?? '—'}→${b[k] ?? '—'}`).join(', ');

  function stamp(route, o, now) {
    const id = idOf(o); if (!id) return; const sig = sigOf(o); if (!sig) return;
    const k = route + '|' + id; let r = M[k]; const own = ownT(o);
    const pn = pxOf(o), p0own = pick(o, PX0);
    if (!r) { r = M[k] = { f: own && own < now ? own : now, u: null, c: null, s: sig, seen: now, p0: p0own ?? pn ?? null }; later(); }
    else {
      if (own && own < r.f) { r.f = own; later(); }
      const d = diff(r.s, sig); if (d) { r.u = now; r.c = d.slice(0, 120); r.s = sig; later(); }
      if (r.p0 == null && (p0own ?? pn) != null) { r.p0 = p0own ?? pn; later(); }
      if (now - (r.seen || 0) > 3600e3) { r.seen = now; later(); }
    }
    const fsx = { f: r.f, u: r.u, c: r.c };
    if (r.p0 != null) {
      fsx.p0 = r.p0;
      if (pn != null) {
        fsx.pn = pn; fsx.pct = +((pn / r.p0 - 1) * 100).toFixed(2); fsx.pnAt = freshOf(o, now);
        const stop = stopOf(o); if (stop != null) fsx.stop = stop;
        if (broken(o) || (stop != null && pn < stop)) fsx.st = 'invalid';
        else if (pn < r.p0) fsx.st = 'cheaper';
      }
    }
    o._fs = fsx;
  }
  const done = new WeakMap(); // payload object -> last annotate time (same cached object is re-stamped at most once a minute)
  function annotate(route, data) {
    if (!ROUTES.has(route) || !data || typeof data !== 'object') return data;
    const now = Date.now(); const last = done.get(data); if (last && now - last < 60e3) return data; done.set(data, now);
    let n = 0;
    const walk = (x, depth) => {
      if (n > WALK_CAP || depth > 5 || !x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) { if (y && typeof y === 'object' && !Array.isArray(y)) { n++; stamp(route, y, now); } walk(y, depth + 1); } return; }
      for (const k in x) { if (k === '_fs' || k === '_prov') continue; const v = x[k]; if (v && typeof v === 'object') walk(v, depth + 1); }
    };
    try { walk(data, 0); } catch (e) { log('[firstseen] ' + e.message); }
    return data;
  }
  return { annotate, save, size: () => Object.keys(M).length };
}
module.exports = { createFirstSeen, ROUTES };
