'use strict';
const cache = new Map(); // key -> {exp, val, p}
async function cached(key, ttl, fn) {
  const now = Date.now();
  const c = cache.get(key);
  if (c && c.val !== undefined && c.exp > now) return c.val;
  if (c && c.p) return c.p;
  const p = (async () => {
    try {
      const val = await fn();
      cache.set(key, { exp: Date.now() + ttl, val });
      return val;
    } catch (e) {
      // serve stale on error if we have it
      if (c && c.val !== undefined) { cache.set(key, { exp: Date.now() + 5000, val: c.val }); return c.val; }
      cache.delete(key);
      throw e;
    }
  })();
  cache.set(key, { ...(c || {}), p, exp: c?.exp || 0 });
  return p;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of cache) if (v.exp && v.exp < n - 3600e3) cache.delete(k); }, 600e3).unref();

async function getJSON(url, headers = {}, timeout = 15000) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { status: 502 });
  return r.json();
}
async function postJSON(url, body, timeout = 20000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { throw Object.assign(new Error(`HTTP ${r.status} non-JSON from ${new URL(url).host}`), { httpStatus: r.status }); }
  if (!r.ok && !j.error) throw Object.assign(new Error(`HTTP ${r.status}`), { httpStatus: r.status });
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { cached, getJSON, postJSON, sleep };
