// Text / push alerts: ntfy.sh (HTTPS phone push), Brevo transactional email-to-SMS, optional plain SMTP.
// ntfy is LIVE when NTFY_TOPIC is set (independent of SMTP). Brevo is LIVE when BREVO_API_KEY + BREVO_SENDER are set.
// SMTP still DRY RUN unless ALERTS_LIVE=1 AND SMTP_* / ALERT_TO are set. Shared dedupe + hourly cap; quiet hours skipped for HARD flags.
// Brevo/SMS is tighter: max 6/h and 30/day, and only HARD / launch-model / A-grade (when ALERT_AGRADE=on) / sentiment euphoria|divergence / refresh failures / unplanned restarts.
// A-grade phone pushes default OFF (ALERT_AGRADE=off) pending grade retraining; pump phone alerts use birthphase launch-model with CALIBRATED odds (pump.fun only).
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

function publicUrl() {
  const e = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (e) return e.replace(/\/$/, '');
  try {
    for (const p of [path.join(process.cwd(), 'PUBLIC_URL.txt'), path.join(__dirname, '..', 'PUBLIC_URL.txt')]) {
      if (fs.existsSync(p)) { const u = fs.readFileSync(p, 'utf8').trim(); if (u) return u.replace(/\/$/, ''); }
    }
  } catch {}
  return '';
}

async function ntfySend({ topic, title, body, priority, tags, click }) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: String(title || 'Asymmetric Terminal').slice(0, 120), Priority: String(priority || 3) };
  if (tags) headers.Tags = String(tags);
  if (click) headers.Click = String(click);
  const r = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), { method: 'POST', headers, body: String(body || '').slice(0, 2000) });
  if (!r.ok) throw new Error('ntfy ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
  return true;
}

async function brevoSend({ apiKey, sender, to, text }) {
  const body = { sender: { email: sender, name: 'Asym Terminal' }, to: [{ email: to }], subject: '', textContent: String(text || '').slice(0, 150) };
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('brevo ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
  return true;
}

function isHard(kind, key, text, opts) {
  if (opts && opts.hard) return true;
  const k = String(kind || ''), id = String(key || ''), t = String(text || '');
  if (k === 'restart' || id.startsWith('restart-')) return true;
  if (/^hard[-_]|mint|freeze|lp[-_]?pull|rug-rise/i.test(k)) return true;
  if (/mint\/freeze|mint authority|freeze authority|LP being pulled|liquidity pulled|hard.?rug/i.test(t)) return true;
  return false;
}

function priorityOf(kind, hard, opts) {
  if (opts && opts.priority != null) return Math.max(1, Math.min(5, +opts.priority || 3));
  if (hard) return 5;
  if (kind === 'launch-model' || kind === 'new-A' || kind === 'grade-A') return 4;
  return 3;
}

function tagsOf(kind, hard, opts) {
  if (opts && opts.tags) return opts.tags;
  if (hard) return 'rotating_light,warning';
  if (kind === 'launch-model') return 'rocket,chart_with_upwards_trend';
  if (kind === 'new-A') return 'chart_with_upwards_trend,star';
  if (/sentiment|euphoria|divergence/i.test(kind || '')) return 'speech_balloon';
  if (/restart/i.test(kind || '')) return 'arrows_counterclockwise';
  if (/priority/i.test(kind || '')) return 'pushpin';
  return 'bell';
}

function smsEligible(kind, key, text, hard, opts) {
  if (opts && opts.sms === false) return false;
  if (opts && opts.sms === true) return true;
  if (hard) return true;
  if (kind === 'launch-model' || kind === 'new-A' || kind === 'grade-A') return true;
  if (/sentiment|euphoria|divergence|refresh[-_]?fail/i.test(String(kind || '') + ' ' + String(key || ''))) return true;
  if (/euphoria|sentiment.?price.?diverg|divergenc|refresh fail/i.test(String(text || ''))) return true;
  return false;
}

function createAlerts({ DATA_DIR, log = () => {} }) {
  const E = process.env;
  // ALERTS_ENABLED=0 (or off/false/no) turns every outbound transport off (ntfy, Brevo, SMTP) -> DRY RUN only. Default on.
  // Use it on a second copy (e.g. Render) so the box and the hosted copy don't both push the same alert to the phone.
  const alertsOn = () => !/^(0|off|false|no)$/i.test(String(E.ALERTS_ENABLED || '').trim());
  const cfg = () => ({
    enabled: alertsOn(),
    live: alertsOn() && E.ALERTS_LIVE === '1', host: E.SMTP_HOST, port: +(E.SMTP_PORT || 587), user: E.SMTP_USER, pass: E.SMTP_PASS, from: E.SMTP_FROM || E.SMTP_USER,
    to: (E.ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxPerHour: +(E.ALERT_MAX_PER_HOUR || 10), quiet: E.ALERT_QUIET || '23-7', tz: E.ALERT_TZ || 'America/Los_Angeles', minGrade: E.ALERT_MIN_GRADE || 'A', digestHours: +(E.ALERT_DIGEST_HOURS || 4),
    ntfyTopic: alertsOn() ? (E.NTFY_TOPIC || '') : '', brevoKey: alertsOn() ? (E.BREVO_API_KEY || '') : '', brevoSender: E.BREVO_SENDER || '',
    smsMaxPerHour: +(E.ALERT_SMS_MAX_PER_HOUR || 6), smsMaxPerDay: +(E.ALERT_SMS_MAX_PER_DAY || 30),
    // Phone A-grade pushes OFF by default (backtest: 86% of live A/B fell 50% or rugged). Set ALERT_AGRADE=on to re-enable after retrain.
    agrade: /^(1|on|true|yes)$/i.test(String(E.ALERT_AGRADE || '').trim()),
    launchP: Math.min(1, Math.max(0, +(E.ALERT_LAUNCH_P != null && E.ALERT_LAUNCH_P !== '' ? E.ALERT_LAUNCH_P : 0.2))), // legacy (raw p); no longer used for phone picks
    // Launch picks use CALIBRATED odds (data/birthphase/launch_calibration.json): lift vs pump.fun base rate, daily budget, spacing.
    launchMinLift: +(E.ALERT_LAUNCH_MIN_LIFT || 3), launchMaxDay: +(E.ALERT_LAUNCH_MAX_DAY || 8), launchGapMin: +(E.ALERT_LAUNCH_GAP_MIN || 60),
    launchMaxAgeMin: +(E.ALERT_LAUNCH_MAX_AGE_MIN || 30), launchBundleMax: +(E.ALERT_LAUNCH_BUNDLE_MAX || 1.01), launchMinLiq: +(E.ALERT_LAUNCH_MIN_LIQ || 1000),
  });
  const sf = path.join(DATA_DIR, 'alerts_state.json'); const lf = path.join(DATA_DIR, 'alerts.log');
  let S = { sent: {}, recent: [], smsRecent: [], smsDay: [], lastDigest: 0 }; try { S = { ...S, ...JSON.parse(fs.readFileSync(sf, 'utf8')) } } catch {}
  S.smsRecent ||= []; S.smsDay ||= []; S.launchSent ||= {};
  const save = () => fs.writeFileSync(sf, JSON.stringify(S));
  const hourLocal = (tz) => +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()) % 24;
  const timeLocal = (t, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(t));
  function quietNow(c) { if (!c.quiet || c.quiet === 'off') return false; const [a, b] = c.quiet.split('-').map(Number); if (isNaN(a) || isNaN(b)) return false; const h = hourLocal(c.tz); return a > b ? h >= a || h < b : h >= a && h < b; }
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
  function titleOf(kind, hard, opts, text) {
    if (opts && opts.title) return opts.title;
    if (hard) return 'AT HARD';
    if (kind === 'launch-model') return 'AT Launch pick';
    if (kind === 'new-A') return 'AT A-grade';
    if (/sentiment|euphoria|divergence/i.test(kind || '')) return 'AT Sentiment';
    if (/restart/i.test(kind || '')) return 'AT Restart';
    if (/priority/i.test(kind || '')) return 'AT Priority';
    return 'Asymmetric Terminal';
  }

  async function deliver(text, kind, key, opts = {}) {
    const c = cfg(); const now = Date.now();
    const hard = isHard(kind, key, text, opts);
    const pri = priorityOf(kind, hard, opts);
    S.recent = (S.recent || []).filter((t) => now - t < 3600e3);
    S.smsRecent = (S.smsRecent || []).filter((t) => now - t < 3600e3);
    S.smsDay = (S.smsDay || []).filter((t) => now - t < 86400e3);
    const entry = { t: now, kind, key, text, chars: text.length, hard: !!hard, priority: pri, transports: {} };
    if (S.recent.length >= c.maxPerHour) { entry.status = 'suppressed: hourly cap ' + c.maxPerHour; log1(entry); return entry; }
    if (quietNow(c) && !hard) { entry.status = `suppressed: quiet hours ${c.quiet} ${c.tz}`; log1(entry); return entry; }

    const ntfyOk = !!c.ntfyTopic;
    const brevoOk = !!(c.brevoKey && c.brevoSender);
    const smtpOk = !!(c.live && c.host && c.user && c.pass && c.to.length);
    const anyLive = ntfyOk || brevoOk || smtpOk;
    if (!anyLive) {
      entry.status = (c.enabled ? 'DRY RUN (ntfy/brevo/smtp unset; would send to ' : 'DRY RUN (ALERTS_ENABLED=0; would send to ') + (c.to.join(',') || 'ALERT_TO') + ')';
      S.recent.push(now); log1(entry); save(); log('alert dry-run: ' + text); return entry;
    }

    const click = opts.click || publicUrl() || undefined;
    const title = titleOf(kind, hard, opts, text);
    const tags = tagsOf(kind, hard, opts);
    const parts = [];

    if (ntfyOk) {
      try { await ntfySend({ topic: c.ntfyTopic, title, body: text, priority: pri, tags, click }); entry.transports.ntfy = 'sent'; parts.push('ntfy'); }
      catch (e) { entry.transports.ntfy = 'error: ' + e.message; }
    }

    const wantSms = smsEligible(kind, key, text, hard, opts);
    if (brevoOk && wantSms) {
      if (S.smsRecent.length >= c.smsMaxPerHour) entry.transports.brevo = 'suppressed: sms hourly cap ' + c.smsMaxPerHour;
      else if (S.smsDay.length >= c.smsMaxPerDay) entry.transports.brevo = 'suppressed: sms daily cap ' + c.smsMaxPerDay;
      else {
        try {
          await brevoSend({ apiKey: c.brevoKey, sender: c.brevoSender, to: c.to[0], text: text.slice(0, 150) });
          entry.transports.brevo = 'sent'; parts.push('brevo'); S.smsRecent.push(now); S.smsDay.push(now);
        } catch (e) { entry.transports.brevo = 'error: ' + e.message; }
      }
    } else if (brevoOk && !wantSms) {
      entry.transports.brevo = 'skipped: not SMS class';
    } else if (!brevoOk && wantSms) {
      entry.transports.brevo = 'waiting for key';
    }

    if (smtpOk) {
      try { await smtpSend({ host: c.host, port: c.port, user: c.user, pass: c.pass, from: c.from, to: c.to, subject: 'AT', text, secure: c.port === 465 }); entry.transports.smtp = 'sent'; parts.push('smtp'); }
      catch (e) { entry.transports.smtp = 'error: ' + e.message; }
    }

    const sentAny = parts.length > 0;
    if (sentAny) S.recent.push(now);
    else if (ntfyOk || brevoOk) S.recent.push(now); // count attempts that had a live transport configured
    entry.status = sentAny ? 'sent via ' + parts.join('+') : ('error: ' + Object.values(entry.transports).join('; '));
    log1(entry); save(); if (sentAny) log('alert: ' + text); else log('alert fail: ' + entry.status);
    return entry;
  }

  let calCache = null;
  function launchCal() {
    const f = path.join(DATA_DIR, 'birthphase', 'launch_calibration.json');
    try { const m = fs.statSync(f).mtimeMs; if (!calCache || calCache.m !== m) calCache = { m, d: JSON.parse(fs.readFileSync(f, 'utf8')) }; return calCache.d; } catch { return null; }
  }
  // isotonic step map: raw p -> population-real odds (block with the largest p_lo <= p)
  function calibrate(cal, p) {
    const iso = (cal && cal.isotonic) || []; if (!iso.length || p == null) return null;
    let b = iso[0]; for (const x of iso) if (p >= x.p_lo) b = x;
    return { real: b.real, lift: cal.base_rate ? b.real / cal.base_rate : null, n: b.n, pos: b.pos };
  }
  let solPx = { v: null, t: 0 };
  async function getJson(u) { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'asymmetric-terminal alerts' }, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function solPrice() {
    if (solPx.v && Date.now() - solPx.t < 10 * 60e3) return solPx.v;
    try { const d = await getJson('https://frontend-api-v3.pump.fun/sol-price'); if (d && d.solPrice > 0) solPx = { v: +d.solPrice, t: Date.now() }; } catch {}
    return solPx.v;
  }
  // current mcap / liquidity (SOL in the bonding curve) / curve % for a pump.fun mint; DexScreener fallback for liq/mcap.
  async function pumpMarket(mint) {
    const SOLQ = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);
    let out = null;
    try {
      const d = await getJson('https://frontend-api-v3.pump.fun/coins-v2/' + mint);
      if (d && d.mint) {
        if (d.quote_mint && !SOLQ.has(d.quote_mint)) return { skip: 'not SOL-quoted (quote ' + String(d.quote_mint).slice(0, 6) + ')' };
        if (d.is_banned) return { skip: 'banned on pump.fun' };
        if (d.complete) return { skip: 'graduated since snapshot (calibration is on-curve only)' };
        // standard pump curve: virtual SOL = 30 SOL + real SOL; anything else (e.g. $20K 'mcap' with 0 real SOL) is a fake/odd curve
        if (d.virtual_sol_reserves != null && d.real_sol_reserves != null && Math.abs(d.virtual_sol_reserves - 30e9 - d.real_sol_reserves) > 2e9) return { skip: 'non-standard curve reserves (virtual ' + (d.virtual_sol_reserves / 1e9).toFixed(0) + ' SOL vs real ' + (d.real_sol_reserves / 1e9).toFixed(1) + ')' };
        const px = await solPrice();
        const mcap = d.usd_market_cap > 0 ? +d.usd_market_cap : (px && d.market_cap > 0 ? d.market_cap * px : null);
        const liq = px && d.real_sol_reserves != null ? (d.real_sol_reserves / 1e9) * px : null;
        const curve = d.real_token_reserves != null ? Math.max(0, Math.min(100, 100 * (1 - d.real_token_reserves / 793100000e6))) : null;
        out = { mcap, liq, curve };
      }
    } catch {}
    if (!out || out.mcap == null || out.liq == null) {
      try {
        const a = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + mint);
        const pr = (Array.isArray(a) ? a : []).find((x) => x.baseToken && x.baseToken.address === mint && (!x.quoteToken || /^(SOL|WSOL)$/i.test(x.quoteToken.symbol || '')));
        if (pr) out = { mcap: (out && out.mcap) ?? pr.marketCap ?? pr.fdv ?? null, liq: (out && out.liq) ?? (pr.liquidity && pr.liquidity.usd) ?? null, curve: out && out.curve };
      } catch {}
    }
    return out || { skip: 'no market data' };
  }
  async function launchPicks(c, items, now) {
    const bp = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'birthphase', 'live.json'), 'utf8'));
    if (!bp.generatedAt || now - bp.generatedAt > c.launchMaxAgeMin * 60e3) return; // stale snapshot: never alert on old data
    const cal = launchCal(); if (!cal || !(cal.isotonic || []).length) return;
    const pads = new Set(cal.calibrated_pads || ['pump.fun']);
    S.launchDay = (S.launchDay || []).filter((t) => now - t < 86400e3);
    if (S.launchDay.length >= c.launchMaxDay) return;
    if (S.launchDay.length && now - Math.max(...S.launchDay) < c.launchGapMin * 60e3) return;
    const bundleOf = (x) => { for (const w of x.why || []) { const m = /^(\d+)% of first buys landed in the same second/.exec(w); if (m) return +m[1] / 100; } return null; };
    const cands = [];
    for (const x of bp.items || []) {
      const pr = x.probs && x.probs['1000000'];
      if (!pr || pr.note || pr.p == null || pr.calibrated !== true || !pads.has(x.launchpad)) continue; // uncalibrated pads (*) never alert
      if (!(x.mcap >= (cal.min_mcap || 5000))) continue; // calibration population: snapshot mcap >= $5K
      if (S.launchSent[x.key] && now - S.launchSent[x.key] < 86400e3) continue;
      const k = calibrate(cal, pr.p); if (!k || k.lift == null || k.lift < c.launchMinLift) continue;
      const bun = bundleOf(x); if (bun != null && bun >= c.launchBundleMax) continue; // default off: backtest shows bundled launches do not hit less
      cands.push({ x, p: pr.p, ...k, bundle: bun });
    }
    cands.sort((a, b) => b.lift - a.lift || b.p - a.p);
    for (const cd of cands.slice(0, 4)) { // look at the best few; send at most 1 per poll
      const x = cd.x; const mk = x.launchpad === 'pump.fun' ? await pumpMarket(x.address) : null;
      if (!mk || mk.skip || mk.mcap == null || mk.liq == null || mk.mcap < (cal.min_mcap || 5000) || mk.liq < c.launchMinLiq) { log1({ t: now, kind: 'launch-model', key: x.key, text: '$' + (x.symbol || '?'), status: 'skipped: ' + ((mk && mk.skip) || 'mcap<5K, liq<$' + c.launchMinLiq + ' or missing mcap/liq'), transports: {} }); S.launchSent[x.key] = now; continue; }
      const odds = cd.real < 0.01 ? (cd.real * 100).toFixed(1) : (cd.real * 100).toFixed(cd.real < 0.1 ? 1 : 0);
      const ch = x.chain === 'solana' ? 'SOL' : String(x.chain || '?').toUpperCase();
      const text = `Launch pick: $${(x.symbol || '?').trim().slice(0, 10)} — ~${odds}% real odds of $1M (${Math.round(cd.lift)}× normal), mcap $${fmtUsd(mk.mcap)}, liq $${fmtUsd(mk.liq)}${mk.curve != null ? `, ${Math.round(mk.curve)}% curve` : ''}, ${ch}`.slice(0, 150);
      const click = x.launchpad === 'pump.fun' ? `https://pump.fun/coin/${x.address}` : `https://dexscreener.com/${x.chain}/${x.address}`;
      S.launchSent[x.key] = now; // claim before awaiting (overlapping onFeed calls double-sent the same pick)
      const entry = await deliver(text, 'launch-model', x.key, { hard: false, priority: 4, sms: true, title: 'AT Launch pick', tags: 'rocket,chart_with_upwards_trend', click });
      // Cap/quiet suppressions must retry later; real attempts (sent / dry-run / transport error) count toward the daily budget.
      if (entry && String(entry.status || '').startsWith('suppressed:')) { delete S.launchSent[x.key]; break; }
      S.launchDay.push(now); break;
    }
  }

  return {
    async onFeed(feed, items, newA, calls) {
      const c = cfg(); const G = { A: 4, B: 3, C: 2 }; const now = Date.now();
      // A/B grades stay on the feed + calls log for retraining; phone push only when ALERT_AGRADE=on.
      const fresh = items.filter((x) => (G[x.grade] || 0) >= (G[c.minGrade] || 4) && newA.includes(x.key) && !(S.sent[x.key] && now - S.sent[x.key] < 86400e3));
      for (const x of fresh.slice(0, 5)) {
        S.sent[x.key] = now;
        if (!c.agrade) { log1({ t: now, kind: 'new-' + x.grade, key: x.key, text: tokenText(x), chars: tokenText(x).length, status: 'suppressed: ALERT_AGRADE=off (paused pending grade retrain; still logged)', hard: false, priority: x.grade === 'A' ? 4 : 3, transports: {} }); continue; }
        await deliver(tokenText(x), 'new-' + x.grade, x.key, { hard: false, priority: x.grade === 'A' ? 4 : 3 });
      }
      // Launch-model phone alerts (birthphase P reach $1M). Only pads with a calibrated population base rate (pump.fun;
      // Virtuals only if launch_calibration.json lists it). Raw model p is over-confident -> mapped through the isotonic
      // calibration from research/birthphase/calibrate_launch.py (out-of-sample, population-weighted pump.fun backtest).
      // Gates: calibrated lift >= ALERT_LAUNCH_MIN_LIFT (3x), fresh live.json, SOL-quoted & still on curve, mcap >= $5K,
      // liq known. Rank by lift then raw p; 1 per poll, >= ALERT_LAUNCH_GAP_MIN apart, <= ALERT_LAUNCH_MAX_DAY per 24h.
      try { await launchPicks(c, items, now); } catch (e) { if (e.code !== 'ENOENT') log('launch-model alerts: ' + e.message); }
      const watchKeys = new Set((process.env.ALERT_WATCH || '').split(',').map((x) => x.trim()).filter(Boolean));
      S.rug ||= {}; S.hardSent ||= {};
      for (const x of items) {
        if (!x.rug || !x.exit || !(S.sent[x.key] || S.launchSent[x.key] || watchKeys.has(x.key))) continue;
        const prev = S.rug[x.key] || { s: 0, t: 0 };
        if (x.rug.score >= 45 && x.rug.score >= prev.s + 15 && Date.now() - prev.t > 6 * 3600e3) {
          S.rug[x.key] = { s: x.rug.score, t: Date.now() };
          await deliver(x.exit.sms.replace(' rug risk ', ' rug risk rose to ').replace(': take', ': consider taking').replace('; trail stop', '; trailing stop'), 'rug-rise', x.key, { hard: true });
        }
        const sigs = x.rug.signals || [];
        const hardSig = sigs.find((s) => s.type === 'hard_rug' || s.type === 'mint_freeze_abuse' || /LP being pulled|mint\/freeze|mint authority|freeze authority/i.test(s.why || ''));
        if (hardSig && !(S.hardSent[x.key] && Date.now() - S.hardSent[x.key] < 6 * 3600e3)) {
          S.hardSent[x.key] = Date.now();
          await deliver(`HARD $${(x.symbol || '?').slice(0, 10)}: ${hardSig.why}`.slice(0, 159), 'hard-flag', x.key, { hard: true });
        }
      }
      if (calls && Date.now() - S.lastDigest > c.digestHours * 3600e3) {
        const alerted = [...new Set([...Object.keys(S.sent), ...Object.keys(S.launchSent || {})])].filter((k) => Date.now() - (S.sent[k] || S.launchSent[k] || 0) < 3 * 86400e3);
        const cs = alerted.map((k) => calls.forKey(k).find((cc) => cc.grade === 'A')).filter(Boolean).sort((a, b) => b.retNow - a.retNow).slice(0, 3);
        if (cs.length) { S.lastDigest = Date.now(); let t = 'Call log update: ' + cs.map((cc) => `$${cc.symbol} called ${timeLocal(cc.t, c.tz)} at $${fmtPx(cc.px0)}, now ${cc.retNow >= 0 ? '+' : ''}${cc.retNow.toFixed(0)}%`).join('; '); await deliver(t.slice(0, 159), 'digest', null, { sms: false, title: 'AT Call log update', tags: 'memo' }); }
      }
      for (const k of Object.keys(S.sent)) if (Date.now() - S.sent[k] > 7 * 86400e3) delete S.sent[k];
      for (const k of Object.keys(S.launchSent || {})) if (Date.now() - S.launchSent[k] > 7 * 86400e3) delete S.launchSent[k];
      for (const k of Object.keys(S.hardSent || {})) if (Date.now() - S.hardSent[k] > 7 * 86400e3) delete S.hardSent[k];
      save();
    },
    async notice(id, text, opts) { S.notices ||= {}; if (S.notices[id]) return null; S.notices[id] = Date.now(); save(); return deliver(String(text).slice(0, 159), (opts && opts.kind) || 'notice', id, opts || {}); },
    queue(kind, key, text, status) { const e = { t: Date.now(), kind, key, text, chars: text.length, status: status || 'queued' }; log1(e); return e; },
    async test(text) { return deliver(text || 'Asymmetric Terminal test alert', 'test', null, { priority: 4, tags: 'white_check_mark', title: 'Asymmetric Terminal' }); },
    async send(title, message, priority, opts = {}) {
      const pri = priority != null ? +priority : undefined;
      const kind = opts.kind || 'cli';
      return deliver(String(message || '').slice(0, 159), kind, opts.key || null, { ...opts, title: title || opts.title, priority: pri });
    },
    status() {
      const c = cfg(); let recent = []; try { recent = fs.readFileSync(lf, 'utf8').trim().split('\n').slice(-30).map((l) => JSON.parse(l)).reverse(); } catch {}
      const ntfy = !!c.ntfyTopic; const brevo = !!(c.brevoKey && c.brevoSender); const smtp = !!(c.live && c.host && c.user && c.pass && c.to.length);
      return {
        mode: (ntfy || brevo || smtp) ? 'LIVE' : 'DRY RUN', alertsEnabled: c.enabled,
        transports: { ntfy: ntfy ? 'live' : 'off', brevo: brevo ? 'live' : 'waiting for key', smtp: smtp ? 'live' : 'dry-run' },
        to: c.to.map((t) => t.replace(/^(\d{3})\d+(\d{2})@/, '$1*****$2@')),
        smtpHost: c.host || null, ntfyTopicSet: ntfy, publicUrl: publicUrl() || null,
        maxPerHour: c.maxPerHour, smsMaxPerHour: c.smsMaxPerHour, smsMaxPerDay: c.smsMaxPerDay,
        quiet: c.quiet, tz: c.tz, minGrade: c.minGrade, digestHours: c.digestHours,
        agrade: c.agrade, launchP: c.launchP,
        launchMinLift: c.launchMinLift, launchMaxDay: c.launchMaxDay, launchGapMin: c.launchGapMin,
        note: (c.agrade ? '' : 'A-grade phone pushes paused (ALERT_AGRADE=off) pending grade retraining. ') + 'Launch picks: pump.fun only (calibrated base rate), calibrated lift ≥ ' + c.launchMinLift + '×, ≤ ' + c.launchMaxDay + '/day, ≥ ' + c.launchGapMin + ' min apart.',
        lastHour: (S.recent || []).filter((t) => Date.now() - t < 3600e3).length,
        smsLastHour: (S.smsRecent || []).filter((t) => Date.now() - t < 3600e3).length,
        smsLastDay: (S.smsDay || []).filter((t) => Date.now() - t < 86400e3).length,
        recent,
      };
    },
    tokenText,
  };
}
module.exports = { createAlerts, smtpSend, ntfySend, brevoSend, publicUrl };
