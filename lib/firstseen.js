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
const PX0 = ['px0', 'price0', 'price_at_call', 'priceAtAlert', 'entry'];
const STOP = ['stop', 'stop_price', 'stopPrice', 'walkAway', 'walk_away', 'invalidation', 'invalidate_below'];
const FRESH = ['dataAsOf', 'priceAt', 'updatedAt', 'fetchedAt', 'asOf', 'at'];
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : typeof v === 'string' && +v > 0 ? +v : null);
const pick = (o, ks) => { for (const k of ks) { const v = num(o[k]); if (v != null) return v; } return null; };
const pxOf = (o) => pick(o, PX) ?? (o.m && typeof o.m === 'object' ? pick(o.m, ['close', 'price']) : null);
const stopOf = (o) => pick(o, STOP) ?? (o.m && typeof o.m === 'object' ? num(o.m.baseLo) : null); // flat-base: walk away below the base low
const freshOf = (o, now) => { for (const k of FRESH) { let v = o[k]; if (typeof v === 'string') v = Date.parse(v); if (typeof v === 'number' && v > 1e9) return v < 1e12 ? v * 1000 : v; } return now; };
const broken = (o) => !!(o.veto || (num(o.rugRisk) || 0) >= 50 || o.rugged || o.invalidated || /invalid|rug/i.test(String(o.label || o.verdict || '')) || (Array.isArray(o.flags) && o.flags.some((f) => /rug|honeypot|danger/i.test(String(f)))));
// Live 'Now' price (lib/liveprice.js): `_fs.lk` names the free source to ask on every page load. The snapshot price in the payload
// is NOT shown as 'Now' (on Render it is frozen at deploy time, so it always equalled 'Price at alert').
const { CHAINS, validAddr } = require('./chains');
const OCC = /^[A-Z][A-Z.]{0,5}\d{6}[CP]\d{8}$/;
const SYM = (s) => { const v = String(s || '').toUpperCase(); return /^[A-Z0-9]{1,20}$/.test(v) ? v : null; };
function lkOf(o) {
  if (o.underlying && o.strike != null && typeof o.id === 'string' && OCC.test(o.id)) return 'o:' + o.id;
  if (o.underlying && o.strike != null && typeof o.id === 'string' && /^[A-Z0-9]{2,10}-\d{8}-[\d_]+-[CP]$/.test(o.id)) return 'x:' + o.id; // Derive crypto option
  const key = typeof o.key === 'string' ? o.key : '';
  const kc = key.indexOf(':') > 0 ? key.slice(0, key.indexOf(':')) : '', kr = kc ? key.slice(kc.length + 1) : '';
  if (o.chain && o.chain !== 'perp' && typeof o.address === 'string' && validAddr(o.chain, o.address)) return `d:${o.chain}:${o.address}`;
  if (CHAINS[kc] && validAddr(kc, kr)) return `d:${kc}:${kr}`;
  if (kc === 'perp' || o.chain === 'perp') { const s = SYM(kr || o.symbol); return s ? 'p:' + s : null; }
  if (kc === 'sym') { const s = SYM(kr); return s ? 'b:' + s : null; }
  if (o.src === 'binance' || /^bn_/.test(String(o.id || ''))) { const s = SYM(o.symbol); return s ? 'b:' + s : null; }
  if (typeof o.id === 'string' && /^[a-z0-9-]{2,80}$/.test(o.id) && SYM(o.symbol) && (o.mcap != null || o.ath != null || o.price != null)) return `c:${o.id}:${SYM(o.symbol)}`; // CoinGecko id (sleepers)
  return null;
}
// A stored alert price is 'genuine' only if the pick carried its own (px0/price0/...) or a live (non-RENDER_LITE) server captured it
// within 15 min of the pick being first posted. Records from before g was tracked: genuine iff first seen at/after the stamp launch
// (the price was captured at that moment); earlier-dated picks got today's price, not the alert price.
const LITE = () => process.env.RENDER_LITE === '1';
const LAUNCH = 1791972469746 - 1000; // 2026-10-14 03:07:49 PT, first firstseen save
const GEN_WIN = 15 * 60e3;
const genuine = (r) => (r.g != null ? !!r.g : r.f >= LAUNCH);
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
    if (!r) { const f0 = own && own < now ? own : now; r = M[k] = { f: f0, u: null, c: null, s: sig, seen: now, p0: p0own ?? pn ?? null }; r.g = p0own != null ? 1 : !LITE() && now - f0 < GEN_WIN ? 1 : 0; later(); }
    else {
      if (own && own < r.f) { r.f = own; later(); }
      const d = diff(r.s, sig); if (d) { r.u = now; r.c = d.slice(0, 120); r.s = sig; later(); }
      if (r.p0 == null && (p0own ?? pn) != null) { r.p0 = p0own ?? pn; r.g = p0own != null ? 1 : !LITE() && now - r.f < GEN_WIN ? 1 : 0; later(); }
      if (now - (r.seen || 0) > 3600e3) { r.seen = now; later(); }
    }
    // f/u/c: stamps. p0: genuine price at alert (absent -> unk=1, card says 'alert price unknown'). lk: live-price key (page fetches
    // /api/liveprice). stop: walk-away level, bk: rug/veto flag. Cheaper-than-alert / Invalidated are decided in the page from the LIVE price.
    const fsx = { f: r.f, u: r.u, c: r.c };
    const lk = lkOf(o); if (lk) fsx.lk = lk;
    const p0 = p0own ?? r.p0;
    if (p0 != null && (p0own != null || genuine(r))) fsx.p0 = p0; else if (lk || p0 != null) fsx.unk = 1;
    if (lk || fsx.p0 != null) { const stop = stopOf(o); if (stop != null) fsx.stop = stop; if (broken(o)) fsx.bk = 1; if (pn != null) { fsx.snap = pn; fsx.snapAt = freshOf(o, now); } }
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
