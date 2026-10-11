'use strict';
// API key health + rotation schedule (never reads, prints or stores secret VALUES — only salted scrypt fingerprints to notice a change).
//   * key age: first-seen date per fingerprint (lower bound) or the provider's own creation time when available (xAI GET /v1/api-key)
//   * schedule: rotate every KEY_ROTATE_DAYS (default 90) — per-key override in data/keyhealth_config.json {"defaultDays":90,"remindDays":14,"keys":{"XAI_API_KEY":{"days":60}}}
//   * reminders: terminal (/api/keyhealth + header badge) and the alert queue (alerts.notice, once per key/due-date/stage) remindDays before due
//   * health: zero-cost validity probes (Nansen GET /account = 0 credits; X GET /2/usage/tweets = not billed; xAI GET /v1/api-key = free)
//             + passive 401/403 detection from the modules' own budget files; every 12h on the main :8000 instance (KEYHEALTH_CHECK=1 elsewhere)
//   * leak scan: scripts/leakscan.js in a child process (daily on :8000) -> data/keyhealth_leakscan.json (paths only)
//   * SESSION_SECRET: auto-rotated on schedule by scripts/rotate-session-secret.js (rewrites .env, restarts via scripts/restart-server.sh;
//     effect: everyone is logged out). KEYHEALTH_AUTOROTATE=off disables. Provider keys need the user (see KEY_ROTATION.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DAY = 864e5;
const KEYS = [
  { name: 'XAI_API_KEY', provider: 'xAI (Grok API)', where: 'Grok Bot secure box (env)', auto: 'possible with an xAI management key (POST /auth/api-keys/{id}/rotate) — not configured', probe: 'xai' },
  { name: 'X_BEARER_TOKEN', provider: 'X API v2 (app-only bearer)', where: 'Grok Bot secure box (env)', auto: 'possible with the app consumer key+secret (oauth2/invalidate_token + oauth2/token) — not configured', probe: 'x' },
  { name: 'NANSEN_API_KEY', provider: 'Nansen API', where: 'Grok Bot secure box (env)', auto: 'not possible: Nansen has no key-management API (dashboard only)', probe: 'nansen' },
  { name: 'BREVO_API_KEY', provider: 'Brevo (email/SMS alerts)', where: 'Grok Bot secure box (env)', auto: 'no public key-rotation API; rotate in the Brevo dashboard (SMTP & API -> API keys)', probe: 'brevo', optional: true },
  { name: 'NTFY_TOPIC', provider: 'ntfy.sh push topic (topic name = credential)', where: '.env', auto: 'possible locally (new random topic) but your phone must re-subscribe — manual by design', local: true },
  { name: 'SESSION_SECRET', provider: 'local (cookie HMAC)', where: '.env', auto: 'yes — scripts/rotate-session-secret.js (logs everyone out)', local: true, autoRotate: true },
  { name: 'SITE_PASSWORD', provider: 'local (login password)', where: '.env', auto: 'no — you choose the password; rotate manually', local: true },
];

function createKeyHealth({ DATA_DIR, root, log = () => {}, alerts = null }) {
  const PORT = +process.env.PORT || 8000;
  const MAIN = PORT === 8000;
  const F = { state: path.join(DATA_DIR, 'keyhealth.json'), cfg: path.join(DATA_DIR, 'keyhealth_config.json'), salt: path.join(DATA_DIR, 'keyhealth_salt'), leak: path.join(DATA_DIR, 'keyhealth_leakscan.json'), events: path.join(DATA_DIR, 'keyhealth_events.jsonl') };
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const wj = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); } catch (e) { log('keyhealth write: ' + e.message); } };
  const event = (e) => { try { fs.appendFileSync(F.events, JSON.stringify({ t: Date.now(), iso: new Date().toISOString(), port: PORT, ...e }) + '\n', { mode: 0o600 }); } catch {} };
  let salt; try { salt = fs.readFileSync(F.salt, 'utf8').trim(); } catch { salt = ''; }
  if (!salt) { salt = crypto.randomBytes(16).toString('hex'); try { fs.writeFileSync(F.salt, salt, { mode: 0o600 }); } catch {} }
  const fpCache = new Map();
  const fp = (v) => { if (!v) return null; const h = crypto.createHash('sha256').update(v).digest('hex'); if (fpCache.has(h)) return fpCache.get(h); const f = crypto.scryptSync(v, salt, 9, { N: 16384 }).toString('hex'); fpCache.set(h, f); return f; };
  const envFile = path.join(root, '.env');
  function dotenv() { const o = {}; try { for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ''); } } catch {} return o; }
  function cfg() {
    const c = rj(F.cfg, {}) || {};
    return { defaultDays: +(process.env.KEY_ROTATE_DAYS || c.defaultDays || 90), remindDays: +(process.env.KEY_REMIND_DAYS || c.remindDays || 14), keys: c.keys || {}, sessionAutoRotate: process.env.KEYHEALTH_AUTOROTATE !== 'off' && c.sessionAutoRotate !== false, restartAfterRotate: c.restartAfterRotate !== false && process.env.KEYHEALTH_AUTORESTART !== 'off' };
  }
  let S = rj(F.state, null) || { keys: {}, createdAt: Date.now() };
  S.keys ||= {};

  // ---- fingerprints / age ----
  function observe() {
    const de = dotenv(); const now = Date.now();
    for (const k of KEYS) {
      const file = k.local ? de[k.name] || '' : '';
      const live = process.env[k.name] || (k.local ? file : '');
      const r = (S.keys[k.name] ||= { history: [] });
      const f = fp(live);
      r.present = !!live; r.lastSeen = now;
      r.length = undefined; // never store anything derived from the value besides the fingerprint
      r.optional = !!k.optional; if (k.local) { const ff = fp(file); r.pendingRestart = !!(ff && f && ff !== f); r.inDotenv = !!file; }
      if (!f) continue;
      if (r.fp !== f) {
        if (r.fp) { r.history.push({ fp: r.fp.slice(0, 6), firstSeen: r.firstSeen, retiredAt: now }); r.history = r.history.slice(-12); r.rotatedAt = now; event({ key: k.name, action: 'change-detected', note: 'new value observed (fingerprint changed)' }); }
        r.fp = f; r.firstSeen = now; r.firstSeenIsLowerBound = !r.rotatedAt; // first ever observation: real age unknown (>=)
        if (r.rotatedAt === now) r.firstSeenIsLowerBound = false;
      }
    }
    // a pending (.env) rotation counts once the server runs with it; the rotate script records rotatedAt in events
    wj(F.state, S);
  }
  function schedule(name) {
    const c = cfg(); const r = S.keys[name] || {}; const days = +(c.keys[name]?.days || c.defaultDays);
    const created = r.providerCreatedAt ? Date.parse(r.providerCreatedAt) : null;
    const basis = created || r.rotatedAt || r.firstSeen || null;
    const basisKind = created ? 'provider creation time' : r.rotatedAt ? 'rotation detected' : 'first seen by the terminal (actual key may be older)';
    if (!basis) return { days, status: 'unknown' };
    const due = basis + days * DAY, left = (due - Date.now()) / DAY;
    return { days, remindDays: c.remindDays, basis: new Date(basis).toISOString(), basisKind, ageDays: +((Date.now() - basis) / DAY).toFixed(1), ageIsLowerBound: !created && !r.rotatedAt, dueAt: new Date(due).toISOString().slice(0, 10), daysLeft: +left.toFixed(1), status: left < 0 ? 'overdue' : left <= c.remindDays ? 'due-soon' : 'ok' };
  }

  // ---- health probes (zero cost) ----
  async function probe(k) {
    const v = process.env[k.name]; if (!v) return { status: k.optional ? 'not configured' : 'missing', detail: 'not set in this process environment' };
    const t0 = Date.now();
    const go = async (url, headers) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); let j = null; try { j = await r.json(); } catch {} return { r, j }; };
    try {
      if (k.probe === 'nansen') { const { r } = await go('https://api.nansen.ai/api/v1/account', { apikey: v, accept: 'application/json' }); return verdict(r.status, 'GET api.nansen.ai/api/v1/account (0 credits)', t0); }
      if (k.probe === 'x') { const { r } = await go('https://api.x.com/2/usage/tweets?days=1', { authorization: 'Bearer ' + v }); return verdict(r.status, 'GET api.x.com/2/usage/tweets (usage endpoint, not billed)', t0, r.status === 403 ? 'authenticated; usage endpoint not permitted for this app tier' : null); }
      if (k.probe === 'brevo') { const { r } = await go('https://api.brevo.com/v3/account', { 'api-key': v, accept: 'application/json' }); return verdict(r.status, 'GET api.brevo.com/v3/account (free)', t0); }
      if (k.probe === 'xai') {
        const { r, j } = await go('https://api.x.ai/v1/api-key', { authorization: 'Bearer ' + v });
        const out = verdict(r.status, 'GET api.x.ai/v1/api-key (free key-info endpoint)', t0);
        if (r.ok && j) {
          const ct = j.create_time ? new Date(typeof j.create_time === 'number' || /^\d+$/.test(j.create_time) ? +j.create_time * (String(j.create_time).length <= 10 ? 1000 : 1) : j.create_time) : null;
          out.provider = { createTime: ct && !isNaN(ct) ? ct.toISOString() : null, modifyTime: j.modify_time || null, blocked: !!j.api_key_blocked, disabled: !!j.api_key_disabled, teamBlocked: !!j.team_blocked, aclCount: Array.isArray(j.acls) ? j.acls.length : null, apiKeyId: j.api_key_id || null, note: ct && !isNaN(ct) ? null : 'xAI returned no create_time for this key; age = first seen by the terminal' };
          if (out.provider.blocked || out.provider.disabled || out.provider.teamBlocked) { out.status = 'invalid'; out.detail = 'key blocked/disabled at xAI'; }
        }
        return out;
      }
    } catch (e) { return { status: 'error', detail: String(e.name === 'TimeoutError' ? 'timeout' : e.message).slice(0, 120), checkedAt: new Date().toISOString() }; }
    return { status: 'n/a' };
  }
  function verdict(code, how, t0, note) {
    const status = code >= 200 && code < 300 ? 'valid' : code === 401 ? 'invalid' : code === 403 ? (note ? 'valid' : 'forbidden') : code === 429 ? 'valid (rate-limited)' : code === 402 ? 'valid (payment/credits required)' : 'error';
    return { status, http: code, via: how, ms: Date.now() - t0, detail: note || (code === 401 ? '401 Unauthorized — key revoked, expired or wrong' : null), checkedAt: new Date().toISOString() };
  }
  // passive: 401/403 seen by the modules themselves (their own budget/cache files; no extra calls)
  function passive() {
    const out = {};
    const nb = rj(path.join(DATA_DIR, 'nansen_budget.json'), null);
    if (nb) { const recent = (nb.calls || []).filter((c) => Date.now() - c.t < 3 * DAY); const bad = recent.filter((c) => c.status === 401 || c.status === 403); const ok = recent.filter((c) => c.status >= 200 && c.status < 300); out.NANSEN_API_KEY = { calls72h: recent.length, ok72h: ok.length, auth401_72h: bad.length, lastOkAt: ok.length ? new Date(Math.max(...ok.map((c) => c.t))).toISOString() : null }; }
    const gb = rj(path.join(DATA_DIR, 'grok_budget.json'), null);
    if (gb) out.XAI_API_KEY = { lastCallAt: gb.lastCallAt ? new Date(gb.lastCallAt).toISOString() : null, lastError: gb.lastError ? String(gb.lastError).replace(/:.*/, '') : null, auth401: /HTTP 40[13]/.test(gb.lastError || '') };
    const xb = rj(path.join(DATA_DIR, 'x_budget.json'), null), xc = rj(path.join(DATA_DIR, 'x_cache.json'), null);
    if (xb) { const ts = Object.values(xc || {}).map((x) => x.t).filter(Boolean); out.X_BEARER_TOKEN = { callsThisMonth: xb.calls, lastResultAt: ts.length ? new Date(Math.max(...ts)).toISOString() : null }; }
    return out;
  }
  let checking = false, lastCheck = S.lastCheckAt || 0;
  async function checkAll(force = false) {
    if (checking || (!force && Date.now() - lastCheck < 11 * 3600e3)) return;
    checking = true; lastCheck = Date.now();
    try {
      for (const k of KEYS.filter((x) => x.probe)) {
        const r = (S.keys[k.name] ||= { history: [] });
        const h = await probe(k);
        const prev = r.health?.status;
        r.health = h;
        if (h.provider?.createTime) r.providerCreatedAt = h.provider.createTime;
        if (h.provider?.apiKeyId) r.providerKeyId = h.provider.apiKeyId; // id (not secret) needed for management-API rotation
        if (h.status === 'invalid' && prev !== 'invalid') { event({ key: k.name, action: 'health-invalid', http: h.http }); notify(`keyhealth:${k.name}:invalid:${new Date().toISOString().slice(0, 10)}`, `KEY ${k.name} failed health check (${h.http || h.status}). Rotate it: see KEY_ROTATION.md`); }
      }
      S.lastCheckAt = lastCheck; wj(F.state, S);
    } finally { checking = false; }
  }

  // ---- reminders ----
  function notify(id, text) {
    if (!alerts || !(MAIN || process.env.KEYHEALTH_NOTIFY === '1')) return;
    try { alerts.notice(id, text); } catch {}
  }
  function remind() {
    for (const k of KEYS) {
      const s = schedule(k.name); if (!S.keys[k.name]?.present) continue;
      if (s.status === 'due-soon') notify(`keyrot:${k.name}:${s.dueAt}:soon`, `KEY ${k.name} rotation due ${s.dueAt} (${Math.ceil(s.daysLeft)}d). ${k.autoRotate ? 'Auto-rotates.' : 'Steps: KEY_ROTATION.md'}`);
      if (s.status === 'overdue' && !k.autoRotate) notify(`keyrot:${k.name}:${s.dueAt}:overdue`, `KEY ${k.name} rotation OVERDUE since ${s.dueAt}. Steps: KEY_ROTATION.md`);
    }
  }
  // ---- SESSION_SECRET auto-rotation ----
  let rotating = false;
  function maybeRotateSession() {
    const c = cfg(); if (!c.sessionAutoRotate || !MAIN || rotating) return;
    const s = schedule('SESSION_SECRET'); const r = S.keys.SESSION_SECRET || {};
    if (s.status !== 'overdue' || r.pendingRestart) return;
    rotating = true;
    const args = [path.join(root, 'scripts', 'rotate-session-secret.js'), '--reason', 'scheduled (lib/keyhealth.js, every ' + s.days + 'd)'];
    if (c.restartAfterRotate) args.push('--restart');
    log('keyhealth: SESSION_SECRET overdue -> rotating' + (c.restartAfterRotate ? ' + planned restart' : ' (restart pending)'));
    const ch = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'ignore', detached: true });
    ch.on('exit', () => { rotating = false; }); ch.on('error', () => { rotating = false; }); ch.unref();
  }
  // ---- leak scan ----
  let scanning = false;
  function leakScan(force = false) {
    const last = rj(F.leak, null); const age = last ? Date.now() - Date.parse(last.generatedAt) : Infinity;
    if (scanning || (!force && age < 23 * 3600e3)) return false;
    scanning = true;
    const ch = spawn('nice', ['-n', '15', process.execPath, path.join(root, 'scripts', 'leakscan.js'), '--out', F.leak, '--quiet'], { cwd: root, env: process.env, stdio: 'ignore' });
    ch.on('exit', () => { scanning = false; const d = rj(F.leak, null); if (d && (d.summary.critical || d.summary.high)) notify(`leakscan:${d.generatedAt.slice(0, 10)}`, `LEAK SCAN: ${d.summary.critical} critical / ${d.summary.high} high key-like findings. Paths in /api/keyhealth (Settings ⓘ keys).`); });
    ch.on('error', () => { scanning = false; });
    return true;
  }

  function tick() { try { observe(); remind(); maybeRotateSession(); } catch (e) { log('keyhealth tick: ' + e.message); } }
  let timers = [];
  function start() {
    tick();
    timers.push(setInterval(tick, 3600e3));
    if (MAIN || process.env.KEYHEALTH_CHECK === '1') { timers.push(setTimeout(() => checkAll(), 90e3)); timers.push(setInterval(() => checkAll(), 3600e3)); }
    if (MAIN || process.env.KEYHEALTH_SCAN === '1') { timers.push(setTimeout(() => leakScan(), 10 * 60e3)); timers.push(setInterval(() => leakScan(), 3 * 3600e3)); }
    for (const t of timers) t.unref?.();
  }
  let lastManual = 0, lastManualScan = 0;
  async function api(q) {
    if (q.get('check') === '1' && Date.now() - lastManual > 10 * 60e3) { lastManual = Date.now(); await checkAll(true); }
    if (q.get('scan') === '1' && Date.now() - lastManualScan > 30 * 60e3) { lastManualScan = Date.now(); leakScan(true); }
    observe();
    const pas = passive(); const c = cfg(); const leak = rj(F.leak, null);
    const keys = KEYS.map((k) => {
      const r = S.keys[k.name] || {}; const s = schedule(k.name);
      return { name: k.name, provider: k.provider, storedIn: k.where, present: !!r.present, autoRotation: k.auto, autoRotatesNow: !!k.autoRotate && c.sessionAutoRotate, schedule: s, firstSeen: r.firstSeen ? new Date(r.firstSeen).toISOString() : null, rotatedAt: r.rotatedAt ? new Date(r.rotatedAt).toISOString() : null, providerCreatedAt: r.providerCreatedAt || null, providerKeyId: r.providerKeyId || null, previousValues: (r.history || []).length, pendingRestart: !!r.pendingRestart, health: r.health || (k.probe ? { status: 'not checked yet' } : { status: 'n/a (local secret)' }), passive: pas[k.name] || null };
    });
    const worst = keys.some((k) => k.health?.status === 'invalid') || (leak && (leak.summary.critical || leak.summary.high)) ? 'red' : keys.some((k) => k.present && (k.schedule.status === 'overdue' || k.schedule.status === 'due-soon')) ? 'yellow' : 'green';
    let events = []; try { events = fs.readFileSync(F.events, 'utf8').trim().split('\n').slice(-20).map((l) => JSON.parse(l)).reverse(); } catch {}
    return { generatedAt: new Date().toISOString(), status: worst, config: { defaultDays: c.defaultDays, remindDays: c.remindDays, overrides: c.keys, sessionAutoRotate: c.sessionAutoRotate, restartAfterRotate: c.restartAfterRotate, configFile: 'data/keyhealth_config.json' }, keys, lastHealthCheck: S.lastCheckAt ? new Date(S.lastCheckAt).toISOString() : null, healthChecksRunHere: MAIN || process.env.KEYHEALTH_CHECK === '1',
      leakScan: leak ? { generatedAt: leak.generatedAt, filesScanned: leak.filesScanned, mbScanned: leak.mbScanned, summary: leak.summary, git: leak.git, envFile: leak.envFile, findings: leak.findings.slice(0, 50), skipped: leak.skipped, limits: leak.limits, running: scanning } : { note: 'not run yet', running: scanning },
      events, docs: 'KEY_ROTATION.md', note: 'No secret values are read into this response; fingerprints are salted scrypt hashes kept server-side only.' };
  }
  return { start, api, checkAll, leakScan, observe, schedule, KEYS };
}
module.exports = { createKeyHealth, KEYS };
