'use strict';
// node test/waking.test.js : Waking Up alerts are inert unless the pool passed the pre-declared test; when on: deduped, quiet-hour
// queued, replayed signals never pushed, invalidation after an alert is HARD; the API strips the ledger and serves the snapshot.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { createWaking } = require('../lib/waking');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
let quiet = true; const sent = [];
const fake = { isQuiet: () => quiet, async push(title, text, o) { if (quiet && !o.hard) return { status: 'suppressed: quiet hours' }; sent.push({ title, text, o }); return { status: 'sent via ntfy' }; } };
const item = { token: 'TokA', symbol: 'TKA', chain: 'solana', contract: 'TokA', status: 'cheaper than flag', priceNow: 0.9, signs: ['volume up 3 of the last 4 days'],
  flag: { how: 'live', signalDay: '2026-10-20', flagPrice: 1, firstFlaggedAt: 1 }, plan: { entry: 'Starter only at or below 1.05', size: '0.25%', sells: ['Sell 1/3 at 2'], walkAway: ['Daily close below 0.65'] } };
const snap = (o) => ({ generatedAt: Date.now(), backtest: { solana: { strength: 'weak', signals: [] } }, predeclared: { file: 'x', sha256: 'y', text: 'z' }, ledger: { k: 1 }, items: [item], ...o });
(async () => {
  const w = createWaking({ DATA_DIR: dir, alerts: fake });
  // OFF: pool did not beat random -> nothing queued, nothing sent, ever
  let r = await w.onScan(snap({ alertsOn: { solana: false } })); assert.strictEqual(r.queued, 0); quiet = false; await w.flush(); assert.strictEqual(sent.length, 0, 'no alerts when off');
  quiet = true;
  // ON: queued in quiet hours, pushed at the 7 AM flush, once
  r = await w.onScan(snap({ alertsOn: { solana: true } })); assert.strictEqual(r.queued, 1); assert.strictEqual(sent.length, 0, 'quiet: held');
  r = await w.onScan(snap({ alertsOn: { solana: true } })); assert.strictEqual(r.queued, 0, 'deduped');
  quiet = false; assert.strictEqual(await w.flush(), 1); for (const s of ['TKA', 'Entry:', 'Size:', 'Sell:', 'Walk away:', 'Strength: weak']) assert(sent[0].text.includes(s), s);
  // replayed (past) signals never alert; majors pool off by its own flag
  r = await w.onScan(snap({ alertsOn: { solana: true }, items: [{ ...item, token: 'TokB', flag: { ...item.flag, how: 'replay' } }, { ...item, token: 'BTC', chain: 'majors (Binance spot)' }] })); assert.strictEqual(r.queued, 0);
  // invalidated after an alert: HARD, bypasses quiet hours, once
  quiet = true; const bad = { ...item, status: 'invalidated', statusWhy: 'safety veto (grade F): top-10 wallets hold 72%' };
  r = await w.onScan(snap({ alertsOn: { solana: true }, items: [bad] })); assert.strictEqual(sent.length, 2); assert(sent[1].o.hard && /top-10/.test(sent[1].text));
  r = await w.onScan(snap({ alertsOn: { solana: true }, items: [bad] })); assert.strictEqual(sent.length, 2, 'hard once');
  // API from a snapshot file (Render path): ledger stripped, spec text omitted unless full=1
  fs.writeFileSync(path.join(dir, 'waking.json'), JSON.stringify(snap({ alertsOn: { solana: false } })));
  const a = w.api(new URLSearchParams()); assert(!a.ledger && a.items.length === 1 && a.predeclared.text === undefined && a.alertState.enabled === false);
  assert.strictEqual(w.api(new URLSearchParams('full=1')).predeclared.text, 'z');
  console.log('waking alerts ok (' + sent.length + ' pushes)');
})().catch((e) => { console.error(e); process.exit(1); });
