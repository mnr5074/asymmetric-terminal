#!/usr/bin/env node
// Rotate SESSION_SECRET (cookie-signing HMAC key) in .env. Safe & local: the only effect is that every browser session is logged out.
// Writes the new value atomically (mode 600), never prints it, appends an event to data/keyhealth_events.jsonl.
// --restart   apply now via scripts/restart-server.sh (planned restart of :8000); otherwise it takes effect at the next restart.
// --dry-run   show what would happen.   --reason "text"   recorded in the event log.
// Scheduled by lib/keyhealth.js (every KEY_ROTATE_DAYS / data/keyhealth_config.json keys.SESSION_SECRET.days, default 90).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const a = process.argv.slice(2);
const DRY = a.includes('--dry-run'), RESTART = a.includes('--restart');
const reason = a.includes('--reason') ? a[a.indexOf('--reason') + 1] : 'manual';
let txt = ''; try { txt = fs.readFileSync(ENV, 'utf8'); } catch { console.error('no .env at ' + ENV); process.exit(1); }
const mode = (() => { try { return fs.statSync(ENV).mode & 0o777; } catch { return 0o600; } })();
const fresh = crypto.randomBytes(32).toString('hex');
const lines = txt.split('\n'); let found = false;
const out = lines.map((l) => (/^\s*SESSION_SECRET\s*=/.test(l) ? ((found = true), 'SESSION_SECRET=' + fresh) : l));
if (!found) { if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, 'SESSION_SECRET=' + fresh); else out.push('SESSION_SECRET=' + fresh); }
const restartScript = path.join(ROOT, 'scripts', 'restart-server.sh');
if (DRY) { console.log(`[dry-run] would ${found ? 'replace' : 'add'} SESSION_SECRET in .env (mode ${(mode & 0o777).toString(8)} -> 600)${RESTART ? `; then ${fs.existsSync(restartScript) ? 'run scripts/restart-server.sh' : 'NOT restart (scripts/restart-server.sh missing)'}` : '; no restart'}`); process.exit(0); }
const tmp = ENV + '.tmp-' + process.pid;
fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, ENV);
const ev = { t: Date.now(), iso: new Date().toISOString(), key: 'SESSION_SECRET', action: 'rotated', reason, by: process.env.AGENT_NAME || process.env.USER || 'unknown', restart: RESTART ? 'requested' : 'pending (takes effect at next server restart)' };
let restarted = null;
if (RESTART) {
  if (fs.existsSync(restartScript)) { const r = spawnSync('sh', [restartScript, 'SESSION_SECRET rotation (' + reason + ')'], { cwd: ROOT, stdio: 'inherit', timeout: 180e3 }); restarted = r.status === 0; ev.restart = restarted ? 'done (scripts/restart-server.sh)' : 'restart script failed (exit ' + r.status + ') — restart pending'; }
  else ev.restart = 'scripts/restart-server.sh missing — restart pending';
}
try { fs.appendFileSync(path.join(DATA, 'keyhealth_events.jsonl'), JSON.stringify(ev) + '\n', { mode: 0o600 }); } catch {}
console.log(`SESSION_SECRET rotated in .env (value not shown). restart: ${ev.restart}`);
