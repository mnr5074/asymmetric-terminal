'use strict';
// Private storage for the Tax desk. Everything lives under DATA_DIR/tax (gitignored, dir 0700, files 0600).
// Never written inside the repo tree outside data/, never sent to third parties.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DIR = process.env.TAX_DATA_DIR || path.join(DATA_DIR, 'tax');
function ensureDir(d = DIR) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} return d; }
function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}
const LEDGER = () => path.join(ensureDir(), 'ledger.json');
const EMPTY = () => ({ version: 1, wallets: [], events: [], imports: [], settings: { method: 'FIFO', scope: 'wallet', washCrypto: 'off', year: 2026, filingStatus: 'single', otherIncome: 0, qualifiedDividends: 0, stCarryover: 0, ltCarryover: 0, identicalGroups: '' }, overrides: {} });
function load() {
  try { const d = JSON.parse(fs.readFileSync(LEDGER(), 'utf8')); return { ...EMPTY(), ...d, settings: { ...EMPTY().settings, ...(d.settings || {}) } }; } catch { return EMPTY(); }
}
function save(d) { writePrivate(LEDGER(), JSON.stringify(d)); return d; }
const eventId = (e) => 'e' + crypto.createHash('sha1').update([e.source, e.account, e.ts, e.type, e.txid || '', e.out?.asset, e.out?.qty, e.in?.asset, e.in?.qty, e.subIdx || 0].join('|')).digest('hex').slice(0, 16);
// Merge events, de-duplicating on content hash (re-importing the same CSV or re-syncing a wallet is idempotent)
function addEvents(d, events, importInfo) {
  const have = new Set(d.events.map((e) => e.id));
  let added = 0;
  for (const e of events) { e.id = e.id || eventId(e); if (have.has(e.id)) continue; have.add(e.id); d.events.push(e); added++; }
  d.events.sort((a, b) => a.ts - b.ts);
  if (importInfo) d.imports.push({ ...importInfo, added, at: Date.now() });
  return added;
}
function exportPath(name) { return path.join(ensureDir(path.join(DIR, 'exports')), name.replace(/[^A-Za-z0-9._-]/g, '_')); }
module.exports = { DIR, ensureDir, writePrivate, load, save, addEvents, eventId, exportPath, EMPTY };
