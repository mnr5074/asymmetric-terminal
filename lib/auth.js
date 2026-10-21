// Optional single-user password gate. Active only when SITE_PASSWORD is set.
// Signed (HMAC-SHA256), httpOnly, SameSite=Lax session cookie; Secure when served over HTTPS.
'use strict';
const crypto = require('crypto');

const PASSWORD = process.env.SITE_PASSWORD || '';
const USER = process.env.SITE_USER || 'martin';
const ENABLED = !!PASSWORD;
let SECRET = process.env.SESSION_SECRET || '';
if (ENABLED && !SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET not set: using a random per-process secret (logins reset on restart).');
}
const COOKIE = 'st_session';
const TTL_S = (+process.env.SESSION_DAYS || 14) * 86400;
const OPEN = new Set(['/api/health', '/login', '/logout']);
// Changing the password (or user) invalidates every existing session.
const pwTag = crypto.createHash('sha256').update(USER + '\0' + PASSWORD).digest('hex').slice(0, 16);

// Restricted guest logins (read-only, no portfolio/wallet, nothing that writes/spends/alerts): config/guests.json holds
// salted scrypt hashes only. Kill switch: env GUEST_LOGINS=off, or delete the user's line in config/guests.json.
const GUESTS = new Map();
if (ENABLED && !/^(0|off|false|no)$/i.test(String(process.env.GUEST_LOGINS || '').trim())) {
  try {
    const cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'guests.json'), 'utf8'));
    for (const [u, h] of Object.entries(cfg.users || {})) if (/^[a-z0-9_-]{2,32}$/.test(u) && u !== USER && /^scrypt\$/.test(h)) GUESTS.set(u, h);
  } catch {}
}
function checkGuest(user, pw) {
  const h = GUESTS.get(user); if (!h) return false;
  const [, N, r, p, salt, hash] = h.split('$');
  try {
    const want = Buffer.from(hash, 'base64url');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
const guestTag = (u) => crypto.createHash('sha256').update(u + '\0' + GUESTS.get(u)).digest('hex').slice(0, 16);

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function eq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function makeToken(user = USER) {
  const data = `${user}.${Math.floor(Date.now() / 1000) + TTL_S}.${user === USER ? pwTag : guestTag(user)}`;
  return `${Buffer.from(data).toString('base64url')}.${sign(data)}`;
}
// Returns null (invalid) or { user, role: 'owner' | 'guest' }
function session(tok) {
  if (!tok) return null;
  const [b, s] = tok.split('.');
  if (!b || !s) return null;
  let data; try { data = Buffer.from(b, 'base64url').toString(); } catch { return null; }
  if (!eq(sign(data), s)) return null;
  const [u, exp, tag] = data.split('.');
  if (!(+exp > Date.now() / 1000)) return null;
  if (u === USER && tag === pwTag) return { user: u, role: 'owner' };
  if (GUESTS.has(u) && tag === guestTag(u)) return { user: u, role: 'guest' };
  return null;
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted || process.env.COOKIE_SECURE === '1';
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// Login attempt limiting: 5 failures per IP per 15 min, plus 30 failures globally per 15 min.
const fails = new Map(); let globalFails = [];
const WIN = 15 * 60e3;
function blocked(ip) {
  const now = Date.now();
  globalFails = globalFails.filter((t) => now - t < WIN);
  const a = (fails.get(ip) || []).filter((t) => now - t < WIN); fails.set(ip, a);
  return a.length >= 5 || globalFails.length >= 30;
}
function fail(ip) { const now = Date.now(); fails.set(ip, [...(fails.get(ip) || []), now]); globalFails.push(now); }
setInterval(() => { const n = Date.now(); for (const [k, v] of fails) if (!v.some((t) => n - t < WIN)) fails.delete(k); }, 5 * 60e3).unref();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeNext = (n) => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) && !n.startsWith('/login') ? n : '/');
function page(res, status, msg, next) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Asymmetric Terminal — sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e13;color:#d7dde8;font:14px ui-monospace,Menlo,Consolas,monospace}
form{background:#11161f;border:1px solid #232b38;border-radius:8px;padding:28px;width:300px}h1{font-size:16px;margin:0 0 4px;letter-spacing:1px}
p{color:#7d889b;margin:0 0 18px;font-size:12px}label{display:block;font-size:11px;color:#7d889b;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;background:#0b0e13;border:1px solid #2a3342;color:#d7dde8;padding:9px;border-radius:5px;font:inherit}
button{margin-top:16px;width:100%;padding:10px;background:#8b5cf6;border:0;color:#fff;border-radius:5px;font:inherit;cursor:pointer}
.err{color:#f87171;font-size:12px;margin-top:12px}</style></head><body>
<form method="post" action="/login"><h1>ASYMMETRIC·TERMINAL</h1><p>Private dashboard: sign in to continue.</p>
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<label>User</label><input name="user" autocomplete="username" autocapitalize="off" spellcheck="false">
<label>Password</label><input name="password" type="password" autocomplete="current-password" autofocus>
<button type="submit">Sign in</button>${msg ? `<div class="err">${esc(msg)}</div>` : ''}</form></body></html>`);
}
function readBody(req, max = 4096) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > max) { b = ''; req.destroy(); } }); req.on('end', () => resolve(b)); req.on('error', () => resolve(''));
  });
}

// Returns true if the request was handled (login page / redirect / 401); false to continue to the app.
async function gate(req, res, u) {
  if (!ENABLED) return false;
  const p = u.pathname;
  if (p === '/login' && req.method === 'POST') {
    const ip = ipOf(req);
    if (blocked(ip)) return page(res, 429, 'Too many failed attempts. Try again in 15 minutes.'), true;
    const f = new URLSearchParams(await readBody(req));
    const fu = (f.get('user') || '').trim().toLowerCase();
    const who = (eq(f.get('user') || '', USER) & eq(f.get('password') || '', PASSWORD)) ? USER : (GUESTS.has(fu) && checkGuest(fu, f.get('password') || '')) ? fu : null;
    if (who) {
      fails.delete(ip);
      res.writeHead(303, { location: safeNext(f.get('next')), 'cache-control': 'no-store',
        'set-cookie': `${COOKIE}=${makeToken(who)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}${isHttps(req) ? '; Secure' : ''}` });
      return res.end(), true;
    }
    fail(ip);
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return page(res, 401, 'Wrong user or password.', f.get('next')), true;
  }
  if (p === '/login') return page(res, 200, '', u.searchParams.get('next')), true;
  if (p === '/logout') {
    res.writeHead(303, { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}` });
    return res.end(), true;
  }
  if (OPEN.has(p)) return false;
  const sess = session(cookies(req)[COOKIE]);
  if (sess) { req.authUser = sess.user; req.authRole = sess.role; return sess.role === 'guest' ? guestBlock(req, res, u) : false; }
  if (p.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end('{"error":"login required"}'), true;
  }
  res.writeHead(302, { location: '/login?next=' + encodeURIComponent(p + u.search), 'cache-control': 'no-store' });
  return res.end(), true;
}

// ---- guest policy: read-only GETs on public market data only ----
// Denied: portfolio/wallet/tax/swap/MEV/paper positions, alerts (status shows recipients; /test sends), paid APIs (Nansen, Grok,
// deep scans), settings/keys, provenance logs, anything that triggers a refresh/write, and the owner-only UI scripts.
const GUEST_DENY = /^\/api\/(portfolio|wallet|tax|swap|mev|paper|alerts|nansen|grok|keyhealth|provenance|copytrade\/wallet|vcwatch\/lookup|agents\/launch|airdrops\/farm|airdrops\/adapters|sol\/blockhash|fees|mycalls)(\/|$|\.)/;
const GUEST_DENY_STATIC = /^\/(portfolio|swap|tax|mycalls)\.js$/; // mycalls = Martin's Calls (personal)
const GUEST_DENY_PARAMS = ['refresh', 'force', 'deep', 'run', 'rebuild', 'live'];
function guestBlock(req, res, u) {
  const p = u.pathname;
  let deny = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') deny = 'read-only guest login';
  else if (GUEST_DENY.test(p)) deny = 'not available for guest login';
  else if (p.startsWith('/api/') && GUEST_DENY_PARAMS.some((k) => u.searchParams.has(k) && !/^(0|false)?$/.test(u.searchParams.get(k)))) deny = 'refresh/deep actions are not available for guest login';
  else if (GUEST_DENY_STATIC.test(p)) deny = 'not available for guest login';
  if (!deny) return false;
  res.writeHead(403, { 'content-type': p.startsWith('/api/') ? 'application/json' : 'text/plain', 'cache-control': 'no-store' });
  res.end(p.startsWith('/api/') ? JSON.stringify({ error: deny }) : deny);
  return true;
}
module.exports = { gate, ENABLED, USER, guests: () => [...GUESTS.keys()], _guestBlock: guestBlock };
