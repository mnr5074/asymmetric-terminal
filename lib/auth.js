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

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function eq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function makeToken() {
  const data = `${USER}.${Math.floor(Date.now() / 1000) + TTL_S}.${pwTag}`;
  return `${Buffer.from(data).toString('base64url')}.${sign(data)}`;
}
function valid(tok) {
  if (!tok) return false;
  const [b, s] = tok.split('.');
  if (!b || !s) return false;
  let data; try { data = Buffer.from(b, 'base64url').toString(); } catch { return false; }
  if (!eq(sign(data), s)) return false;
  const [u, exp, tag] = data.split('.');
  return u === USER && tag === pwTag && +exp > Date.now() / 1000;
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
    if (eq(f.get('user') || '', USER) & eq(f.get('password') || '', PASSWORD)) {
      fails.delete(ip);
      res.writeHead(303, { location: safeNext(f.get('next')), 'cache-control': 'no-store',
        'set-cookie': `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_S}${isHttps(req) ? '; Secure' : ''}` });
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
  if (valid(cookies(req)[COOKIE])) return false;
  if (p.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end('{"error":"login required"}'), true;
  }
  res.writeHead(302, { location: '/login?next=' + encodeURIComponent(p + u.search), 'cache-control': 'no-store' });
  return res.end(), true;
}
module.exports = { gate, ENABLED, USER };
