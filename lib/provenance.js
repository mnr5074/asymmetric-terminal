'use strict';
// Data provenance: every number should trace back to its source (API endpoint without keys, chain + block/tx where on-chain,
// fetch time, data as-of time, cache hit vs fresh, transform applied).
//
// Pieces (all additive, nothing here changes existing module behaviour):
//   1. Outbound-fetch registry: instrument() wraps globalThis.fetch ONCE so every upstream request made by any lib/*.js module is
//      noted (sanitized URL — query params named key/token/secret/... and any value equal to an env secret are redacted, JSON-RPC
//      POSTs keep only origin + rpc method — status, latency, time). Headers and bodies are never recorded.
//   2. record(source, meta): explicit registry for modules that want to tag a value (e.g. record('perps:binance', {url, asOf})).
//      taggedFetch(url, opts, meta) -> { data, prov } for new code. Convention: API responses carry `_prov` =
//      { v:1, level, route, asOf, servedAt, sources:[...], file?, fields? } (see attach()).
//   3. Surface map (lib/provenance_map.js): per API route which fields come from which upstream and how they were transformed,
//      used by resolve() for /api/provenance?path=&field=&row=.  Routes not mapped fall back to file-level provenance
//      (data file + mtime + generatedAt + any embedded src/asof fields), honestly labelled 'file-level'.
//   4. Append-only audit log data/provenance_log.jsonl (fetches + record() calls), batched, rotated by size (PROV_LOG_MAX_MB, default 8,
//      keeps provenance_log.1..5.jsonl). PROV_LOG=off disables the log (registry still works).
const fs = require('fs');
const path = require('path');

const MAX_FETCH = 4000;
const fetches = new Map(); // sanitized url -> { url, host, method, rpc, status, ok, ms, at, n, fails, lastOkAt, bytes }
const records = new Map(); // source -> meta (latest)
let queue = [];
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = +process.env.PORT || 8000;
const LOG_ON = process.env.PROV_LOG !== 'off';
const LOG_MAX = +(process.env.PROV_LOG_MAX_MB || 8) * 1048576, LOG_KEEP = 5;
const SENSITIVE_PARAM = /(^|[_-])(api[_-]?key|apikey|key|token|access[_-]?token|secret|sig|signature|auth|password|pass|bearer|client[_-]?secret|session)$/i;
const KEY_IN_PATH_HOSTS = /(ntfy|alchemy|infura|helius|quicknode|quiknode|ankr|chainstack|blastapi|drpc|getblock|nodereal|blockpi|moralis|tatum|syndica|triton|shyft)/i;

// env secret values (never stored; only used to redact anything that accidentally contains them)
function secretValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 6 && (/(KEY|TOKEN|SECRET|PASSWORD|BEARER|PRIVATE)/i.test(k) || /^NTFY_TOPIC$/.test(k)) && !/_NAMES$/.test(k)) out.push(v);
  // .env-only secrets (e.g. NTFY_TOPIC: the topic name IS the credential for ntfy.sh)
  try { for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && /(KEY|TOKEN|SECRET|PASSWORD|NTFY_TOPIC)/.test(m[1])) { const v = m[2].trim().replace(/^['"]|['"]$/g, ''); if (v.length >= 6) out.push(v); } } } catch {}
  return out.sort((a, b) => b.length - a.length);
}
let SECRETS = secretValues();
function redactSecrets(s) { let o = String(s); for (const v of SECRETS) if (o.includes(v)) o = o.split(v).join('REDACTED'); return o; }

function sanitizeUrl(raw, method = 'GET', body = null) {
  let u; try { u = new URL(String(raw)); } catch { return { url: redactSecrets(String(raw)).slice(0, 300), host: '?', rpc: null }; }
  u.username = ''; u.password = '';
  let rpc = null;
  if (method !== 'GET' && typeof body === 'string' && body.length < 200000 && /"jsonrpc"|"method"/.test(body)) {
    try { const j = JSON.parse(body); const arr = Array.isArray(j) ? j : [j]; rpc = [...new Set(arr.map((x) => x && x.method).filter(Boolean))].slice(0, 4).join(',') || null; } catch {}
  }
  if (rpc) return { url: `${u.protocol}//${u.host}${KEY_IN_PATH_HOSTS.test(u.host) ? '/…' : u.pathname.length > 1 ? '/…' : ''} [rpc ${rpc}]`, host: u.host, rpc };
  if (/ntfy/i.test(u.host)) u.pathname = '/REDACTED-topic';
  for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, 'REDACTED');
  if (KEY_IN_PATH_HOSTS.test(u.host)) u.pathname = u.pathname.split('/').map((seg) => (seg.length >= 20 && /[0-9]/.test(seg) && /[a-zA-Z]/.test(seg) ? 'REDACTED' : seg)).join('/');
  let s = redactSecrets(u.toString());
  if (s.length > 4000) s = s.slice(0, 4000) + '…'; // full url kept in memory (address matching); the log truncates
  return { url: s, host: u.host, rpc: null };
}

function note(entry) {
  const k = entry.url;
  const prev = fetches.get(k);
  const e = { ...(prev || { n: 0, fails: 0 }), ...entry, n: (prev?.n || 0) + 1 };
  if (!entry.ok) e.fails = (prev?.fails || 0) + 1; else e.lastOkAt = entry.at;
  fetches.delete(k); fetches.set(k, e); // LRU order
  if (fetches.size > MAX_FETCH) fetches.delete(fetches.keys().next().value);
  if (LOG_ON) queue.push({ type: 'fetch', t: entry.at, url: entry.url.length > 400 ? entry.url.slice(0, 400) + '…' : entry.url, m: entry.method, st: entry.status, ms: entry.ms, b: entry.bytes ?? undefined, pid: process.pid, port: PORT });
}

let instrumented = false;
function instrument() {
  if (instrumented || typeof globalThis.fetch !== 'function') return;
  instrumented = true;
  const orig = globalThis.fetch;
  const wrapped = async function provFetch(input, init) {
    const t0 = Date.now();
    let url = '', method = 'GET', body = null;
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url || String(input);
      method = String(init?.method || input?.method || 'GET').toUpperCase();
      body = typeof init?.body === 'string' ? init.body : null;
    } catch {}
    try {
      const r = await orig(input, init);
      try { const s = sanitizeUrl(url, method, body); const cl = r.headers?.get?.('content-length'); note({ ...s, method, status: r.status, ok: r.ok, ms: Date.now() - t0, at: t0, bytes: cl ? +cl : null }); } catch {}
      return r;
    } catch (e) {
      try { const s = sanitizeUrl(url, method, body); note({ ...s, method, status: 'ERR:' + String(e?.name || 'error').slice(0, 30), ok: false, ms: Date.now() - t0, at: t0 }); } catch {}
      throw e;
    }
  };
  globalThis.fetch = wrapped;
}

// explicit tagging API for modules
function record(source, meta = {}) {
  const m = { ...meta, source, recordedAt: Date.now() };
  if (m.url) m.url = sanitizeUrl(m.url).url;
  records.set(source, m);
  if (records.size > 2000) records.delete(records.keys().next().value);
  if (LOG_ON) queue.push({ type: 'record', t: m.recordedAt, source, url: m.url, chain: m.chain, block: m.block, tx: m.tx, asOf: m.asOf, cache: m.cache, transform: m.transform ? String(m.transform).slice(0, 200) : undefined, pid: process.pid, port: PORT });
  return m;
}
async function taggedFetch(url, opts = {}, meta = {}) {
  const t0 = Date.now();
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { status: 502 });
  const prov = record(meta.source || new URL(url).host + new URL(url).pathname, { ...meta, url, fetchedAt: t0, cache: 'fresh', asOf: meta.asOf ?? t0 });
  return { data, prov };
}
// most recent registry entry whose url contains every needle (strings) — used to tie a value to the upstream request that produced it
function lastFetch(needles = [], { okOnly = false } = {}) {
  const ns = needles.filter(Boolean).map((x) => String(x).toLowerCase());
  let best = null;
  for (const e of fetches.values()) {
    if (okOnly && !e.ok) continue;
    const u = e.url.toLowerCase();
    if (ns.every((n) => u.includes(n)) && (!best || e.at > best.at)) best = e;
  }
  return best;
}
function recent(limit = 50, host = null) {
  return [...fetches.values()].filter((e) => !host || e.host.includes(host)).sort((a, b) => b.at - a.at).slice(0, limit);
}
function hosts() {
  const h = {};
  for (const e of fetches.values()) { const x = (h[e.host] ||= { host: e.host, urls: 0, requests: 0, fails: 0, lastAt: 0, lastOkAt: 0 }); x.urls++; x.requests += e.n; x.fails += e.fails; x.lastAt = Math.max(x.lastAt, e.at); x.lastOkAt = Math.max(x.lastOkAt, e.lastOkAt || 0); }
  return Object.values(h).sort((a, b) => b.lastAt - a.lastAt);
}

// ---------- audit log (append-only, rotated by size) ----------
function logFile() { return path.join(DATA_DIR, 'provenance_log.jsonl'); }
function rotateIfNeeded() {
  const f = logFile(); let st; try { st = fs.statSync(f); } catch { return; }
  if (st.size < LOG_MAX) return;
  try {
    for (let i = LOG_KEEP - 1; i >= 1; i--) { const a = path.join(DATA_DIR, `provenance_log.${i}.jsonl`), b = path.join(DATA_DIR, `provenance_log.${i + 1}.jsonl`); if (fs.existsSync(a)) fs.renameSync(a, b); }
    fs.renameSync(f, path.join(DATA_DIR, 'provenance_log.1.jsonl'));
  } catch {}
}
function flush() {
  if (!queue.length) return;
  const q = queue; queue = [];
  try { rotateIfNeeded(); fs.appendFileSync(logFile(), q.map((x) => redactSecrets(JSON.stringify(x))).join('\n') + '\n'); } catch {}
}
let flushTimer = null;
function start({ dataDir } = {}) {
  if (dataDir) DATA_DIR = dataDir;
  SECRETS = secretValues();
  instrument();
  if (!flushTimer && LOG_ON) { flushTimer = setInterval(flush, 20e3); flushTimer.unref(); process.once('beforeExit', flush); }
}
function tailLog(n = 100) {
  try { const s = fs.readFileSync(logFile(), 'utf8'); return s.trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; }
}

// ---------- API: attach `_prov` to responses + /api/provenance routes ----------
// attach(route, data, DATA_DIR): returns a SHALLOW COPY of plain-object responses with `_prov` (never mutates module state).
function attach(route, data, DATA_DIR2) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.isBuffer(data) || data._prov || process.env.PROV_ATTACH === 'off') return data;
  try { const m = require('./provenance_map'); return { ...data, _prov: m.describe(route, data, DATA_DIR2 || DATA_DIR) }; } catch { return data; }
}
function routes({ routes: R, DATA_DIR: D, mem = {} }) {
  const m = require('./provenance_map');
  const dd = D || DATA_DIR;
  const fakeReq = { headers: {}, socket: {}, method: 'GET' };
  return {
    async '/api/provenance'(q) {
      const route = q.get('path') || '';
      if (!route) return { usage: '/api/provenance?path=/api/live&field=price&row=solana:<address>  (extra route params as q.<name>=..., e.g. q.kind=perp)', coverage: '/api/provenance/coverage', log: '/api/provenance/log', upstream: '/api/provenance/upstream', surfaces: Object.keys(m.SURFACES), fileLevel: Object.keys(m.FILES) };
      if (!/^\/api\//.test(route) || /^\/api\/(provenance|keyhealth|tax|swap|mev|portfolio)/.test(route) || !R[route]) throw Object.assign(new Error('unknown or unsupported path'), { status: 404 });
      const params = new URLSearchParams();
      for (const [k, v] of q) if (k.startsWith('q.') && k !== 'q.wl') params.set(k.slice(2), v);
      if (route === '/api/nansen/token') params.delete('fetch'); // never spend credits from a provenance lookup
      let data = null, err = null;
      try { data = await R[route](params, fakeReq); } catch (e) { err = String(e.message || e); }
      const res = await m.resolve({ route, field: q.get('field'), row: q.get('row'), data: data || {}, DATA_DIR: dd, extra: { mem } });
      if (err) res.routeError = err;
      res.route = m.describe(route, data || {}, dd);
      if (!q.get('field')) delete res.fieldKey;
      return res;
    },
    async '/api/provenance/coverage'() { return m.coverage(dd); },
    async '/api/provenance/log'(q) { return { file: 'data/provenance_log.jsonl', maxMb: LOG_MAX / 1048576, keep: LOG_KEEP, entries: tailLog(Math.min(500, +(q.get('n') || 100))) }; },
    async '/api/provenance/upstream'(q) { return { hosts: hosts(), recent: recent(Math.min(300, +(q.get('n') || 60)), q.get('host')), records: [...records.values()].slice(-50).reverse() }; },
  };
}

module.exports = { attach, routes, instrument, start, record, taggedFetch, sanitizeUrl, redactSecrets, lastFetch, recent, hosts, records, fetches, flush, tailLog, logFile };
