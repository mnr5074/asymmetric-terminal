'use strict';
// node test/rhalerts.test.js : Trigger alerts dedupe, quiet-hour queueing, HARD bypass, and the real lib/alerts.js quiet window.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { createRhAlerts } = require('../lib/rhalerts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhal-'));
let quiet = true; const sent = [];
const fake = { isQuiet: () => quiet, async push(title, text, o) { if (quiet && !o.hard) return { status: 'suppressed: quiet hours' }; sent.push({ title, text, o }); return { status: 'sent via ntfy' }; } };
const item = { token: '0xabc', symbol: 'TST', state: 'Trigger', price: 0.0025, priceAt: Date.parse('2026-10-19T12:00:00Z'), liqUsd: 100000, strength: 'weak', dexscreener: 'https://dexscreener.com/robinhood/0xpool',
  m: { setupBarUtc: '2026-10-18 16:00', baseHigh: 0.00242, baseLow: 0.00157, volRise: 1.8 }, contract: { honeypot: false, top10: 38 },
  plan: { entry: 'Trigger already fired: buy only while price is under 0.002781', size: '1.0% of portfolio', sells: ['Sell 1/3 at 0.003674 (prior peak close)', 'Sell 1/3 at 0.00495 (2x from entry)'], walkAway: ['4h close below 0.001733: exit all'], backtestNote: 'Replay: 17 of 60.' } };
(async () => {
  const ra = createRhAlerts({ DATA_DIR: dir, alerts: fake });
  let r = await ra.onScan({ strength: 'weak', items: [item] });
  assert.strictEqual(r.queued, 1); assert.strictEqual(sent.length, 0, 'quiet: nothing pushed'); assert.strictEqual(r.pending, 1);
  r = await ra.onScan({ strength: 'weak', items: [item] }); assert.strictEqual(r.queued, 0, 'same trigger not queued twice');
  quiet = false; assert.strictEqual(await ra.flush(), 1, '7 AM flush pushes the queued alert');
  const t = sent[0].text; for (const s of ['0.0025', 'Strength: weak', 'Entry:', 'Size:', 'Sell:', 'Walk away:', '0.003674']) assert(t.includes(s), 'text has ' + s);
  r = await ra.onScan({ strength: 'weak', items: [item] }); assert.strictEqual(r.queued, 0); assert.strictEqual(sent.length, 1, 'never repeats');
  // restart: state persisted, still deduped
  const ra2 = createRhAlerts({ DATA_DIR: dir, alerts: fake }); r = await ra2.onScan({ items: [item] }); assert.strictEqual(sent.length, 1, 'deduped across restarts');
  // a NEW base on the same token is a new alert
  r = await ra2.onScan({ items: [{ ...item, m: { ...item.m, setupBarUtc: '2026-10-25 08:00' } }] }); assert.strictEqual(sent.length, 2);
  // rug during quiet hours: HARD, pushed immediately, once
  quiet = true; const rug = { ...item, state: 'Extended', liqUsd: 50000 };
  r = await ra2.onScan({ items: [rug] }); assert.strictEqual(sent.length, 3, 'HARD bypasses quiet'); assert(sent[2].o.hard && /fell from/.test(sent[2].text));
  r = await ra2.onScan({ items: [rug] }); assert.strictEqual(sent.length, 3, 'HARD once per reason');
  // the real lib/alerts.js quiet window: 23-7 PT
  const { createAlerts } = require('../lib/alerts');
  process.env.ALERT_QUIET = '23-7'; process.env.ALERT_TZ = 'America/Los_Angeles'; process.env.ALERTS_ENABLED = '0';
  const A = createAlerts({ DATA_DIR: dir }); const h = +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' }).format(new Date()) % 24;
  assert.strictEqual(A.isQuiet(), h >= 23 || h < 7, 'quiet window matches 23-7 PT');
  const e = await A.push('t', 'x'.repeat(1000), { kind: 'rh-trigger', key: 'k' }); assert(/DRY RUN|suppressed/.test(e.status));
  if (!A.isQuiet()) assert.strictEqual(e.text.length, 1000, 'long body not cut to 159');
  console.log('rhalerts ok (' + sent.length + ' pushes, quiet now: ' + A.isQuiet() + ')');
})().catch((e) => { console.error(e); process.exit(1); });
