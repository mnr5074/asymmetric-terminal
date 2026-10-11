// Text alerts via email-to-SMS (e.g. T-Mobile <number>@tmomail.net) using plain SMTP (no dependencies).
// DRY RUN unless ALERTS_LIVE=1 AND SMTP_HOST/SMTP_USER/SMTP_PASS/ALERT_TO are set. Dedupe, hourly cap, quiet hours.
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

function smtpSend({ host, port, user, pass, from, to, subject, text, secure }) {
  return new Promise((resolve, reject) => {
    let sock = secure ? tls.connect(port, host, { servername: host }) : net.connect(port, host);
    let buf = ''; const steps = [];
    const send = (l) => sock.write(l + '\r\n');
    const expect = (code) => new Promise((res, rej) => steps.push({ code, res, rej }));
    const onData = (d) => { buf += d.toString(); let m; while ((m = buf.match(/^(\d{3})([ -])(.*)\r\n/m))) { const line = m[0]; buf = buf.slice(buf.indexOf(line) + line.length); if (m[2] === ' ') { const s = steps.shift(); if (!s) continue; String(m[1]).startsWith(String(s.code)[0]) ? s.res(m[1] + m[3]) : s.rej(new Error('SMTP ' + m[1] + m[3])); } } };
    sock.on('data', onData); sock.on('error', reject); sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    (async () => {
      await expect(220); send('EHLO asymmetric-terminal'); await expect(250);
      if (!secure) {
        send('STARTTLS'); await expect(220);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host }); sock.on('data', onData); sock.on('error', reject);
        await new Promise((r) => sock.once('secureConnect', r));
        send('EHLO asymmetric-terminal'); await expect(250);
      }
      send('AUTH LOGIN'); await expect(334); send(Buffer.from(user).toString('base64')); await expect(334); send(Buffer.from(pass).toString('base64')); await expect(235);
      send(`MAIL FROM:<${from}>`); await expect(250);
      for (const t of to) { send(`RCPT TO:<${t}>`); await expect(250); }
      send('DATA'); await expect(354);
      send([`From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', text.replace(/^\./gm, '..'), '.'].join('\r\n')); await expect(250);
      send('QUIT'); sock.end(); resolve(true);
    })().catch((e) => { try { sock.destroy(); } catch {} reject(e); });
  });
}

function createAlerts({ DATA_DIR, log = () => {} }) {
  const E = process.env;
  const cfg = () => ({ live: E.ALERTS_LIVE === '1', host: E.SMTP_HOST, port: +(E.SMTP_PORT || 587), user: E.SMTP_USER, pass: E.SMTP_PASS, from: E.SMTP_FROM || E.SMTP_USER, to: (E.ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxPerHour: +(E.ALERT_MAX_PER_HOUR || 10), quiet: E.ALERT_QUIET || '23-7', tz: E.ALERT_TZ || 'America/Los_Angeles', minGrade: E.ALERT_MIN_GRADE || 'A', digestHours: +(E.ALERT_DIGEST_HOURS || 4) });
  const sf = path.join(DATA_DIR, 'alerts_state.json'); const lf = path.join(DATA_DIR, 'alerts.log');
  let S = { sent: {}, recent: [], lastDigest: 0 }; try { S = { ...S, ...JSON.parse(fs.readFileSync(sf, 'utf8')) } } catch {}
  const save = () => fs.writeFileSync(sf, JSON.stringify(S));
  const hourLocal = (tz) => +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()) % 24;
  const timeLocal = (t, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(t));
  function quietNow(c) { const [a, b] = c.quiet.split('-').map(Number); if (isNaN(a) || isNaN(b)) return false; const h = hourLocal(c.tz); return a > b ? h >= a || h < b : h >= a && h < b; }
  const fmtUsd = (n) => (n == null ? '?' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : n.toFixed(0));
  const fmtPx = (p) => (p == null ? '?' : p >= 1 ? p.toFixed(2) : p.toPrecision(3));
  const short = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '');
  function tokenText(x) {
    const ch = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', bsc: 'BSC', arbitrum: 'ARB', robinhood: 'RH' }[x.chain] || x.chain.toUpperCase();
    let t = `${x.grade} ${x.score} $${(x.symbol || '?').slice(0, 10)} ${ch} mc$${fmtUsd(x.mcap || x.fdv)}${x.rug?.dump30 ? ' DUMP-RISK' : ''} ${short(x.url)}`;
    if (t.length > 158) t = t.slice(0, 158);
    return t;
  }
  function log1(entry) { fs.appendFileSync(lf, JSON.stringify(entry) + '\n'); }
  async function deliver(text, kind, key) {
    const c = cfg(); const now = Date.now();
    S.recent = S.recent.filter((t) => now - t < 3600e3);
    const entry = { t: now, kind, key, text, chars: text.length };
    if (S.recent.length >= c.maxPerHour) { entry.status = 'suppressed: hourly cap ' + c.maxPerHour; log1(entry); return entry; }
    if (quietNow(c)) { entry.status = `suppressed: quiet hours ${c.quiet} ${c.tz}`; log1(entry); return entry; }
    const ready = c.live && c.host && c.user && c.pass && c.to.length;
    if (!ready) { entry.status = 'DRY RUN (would send to ' + (c.to.join(',') || 'ALERT_TO unset') + ')'; S.recent.push(now); log1(entry); log('alert dry-run: ' + text); return entry; }
    try { await smtpSend({ host: c.host, port: c.port, user: c.user, pass: c.pass, from: c.from, to: c.to, subject: 'AT', text, secure: c.port === 465 }); entry.status = 'sent'; S.recent.push(now); }
    catch (e) { entry.status = 'error: ' + e.message; }
    log1(entry); return entry;
  }
  return {
    // new A-grade tokens (dedupe 24h per token), plus periodic follow-up digest of earlier calls
    async onFeed(feed, items, newA, calls) {
      const c = cfg(); const G = { A: 4, B: 3, C: 2 };
      const fresh = items.filter((x) => (G[x.grade] || 0) >= (G[c.minGrade] || 4) && newA.includes(x.key) && !(S.sent[x.key] && Date.now() - S.sent[x.key] < 86400e3));
      for (const x of fresh.slice(0, 5)) { S.sent[x.key] = Date.now(); await deliver(tokenText(x), 'new-' + x.grade, x.key); }
      // rug-risk rise for tokens we alerted on or that you hold (ALERT_WATCH=chain:address,...): one text per +15-point step, max once per 6h per token
      const watchKeys = new Set((process.env.ALERT_WATCH || '').split(',').map((x) => x.trim()).filter(Boolean));
      S.rug ||= {};
      for (const x of items) {
        if (!x.rug || !x.exit || !(S.sent[x.key] || watchKeys.has(x.key))) continue;
        const prev = S.rug[x.key] || { s: 0, t: 0 };
        if (x.rug.score >= 45 && x.rug.score >= prev.s + 15 && Date.now() - prev.t > 6 * 3600e3) { S.rug[x.key] = { s: x.rug.score, t: Date.now() }; await deliver(x.exit.sms.replace(' rug risk ', ' rug risk rose to ').replace(': take', ': consider taking').replace('; trail stop', '; trailing stop'), 'rug-rise', x.key); }
      }
      if (calls && Date.now() - S.lastDigest > c.digestHours * 3600e3) {
        const alerted = Object.keys(S.sent).filter((k) => Date.now() - S.sent[k] < 3 * 86400e3);
        const cs = alerted.map((k) => calls.forKey(k).find((cc) => cc.grade === 'A')).filter(Boolean).sort((a, b) => b.retNow - a.retNow).slice(0, 3);
        if (cs.length) { S.lastDigest = Date.now(); let t = cs.map((cc) => `$${cc.symbol} called ${timeLocal(cc.t, c.tz)} @${fmtPx(cc.px0)} now ${cc.retNow >= 0 ? '+' : ''}${cc.retNow.toFixed(0)}%`).join('; '); await deliver(t.slice(0, 159), 'digest', null); }
      }
      for (const k of Object.keys(S.sent)) if (Date.now() - S.sent[k] > 7 * 86400e3) delete S.sent[k];
      save();
    },
    // one-off notice (e.g. Nansen low credits): sent once per id, never repeated
    async notice(id, text) { S.notices ||= {}; if (S.notices[id]) return null; S.notices[id] = Date.now(); save(); return deliver(text.slice(0, 159), 'notice', id); },
    async test(text) { return deliver(text || 'Asymmetric Terminal test alert', 'test', null); },
    status() { const c = cfg(); let recent = []; try { recent = fs.readFileSync(lf, 'utf8').trim().split('\n').slice(-30).map((l) => JSON.parse(l)).reverse(); } catch {} return { mode: c.live && c.host && c.user && c.pass && c.to.length ? 'LIVE' : 'DRY RUN', to: c.to.map((t) => t.replace(/^(\d{3})\d+(\d{2})@/, '$1*****$2@')), smtpHost: c.host || null, maxPerHour: c.maxPerHour, quiet: c.quiet, tz: c.tz, minGrade: c.minGrade, digestHours: c.digestHours, lastHour: S.recent.filter((t) => Date.now() - t < 3600e3).length, recent }; },
    tokenText,
  };
}
module.exports = { createAlerts, smtpSend };
