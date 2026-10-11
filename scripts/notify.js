#!/usr/bin/env node
// CLI: send one alert through lib/alerts.js (ntfy + Brevo, shared caps).
// Usage: scripts/notify.js "title" "message" [priority]
//   priority: 1-5 (default 3; use 5 for HARD, 4 for A-grade / high sentiment)
// Kind is inferred from title/message for SMS eligibility (euphoria, divergence, refresh fail, HARD).
// Loads .env from the project root. Exit 0 on send/suppress, 1 on hard failure.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] != null && process.env[m[1]] !== '') continue;
      let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {}

const title = process.argv[2] || 'Asymmetric Terminal';
const message = process.argv[3] || '';
const priority = process.argv[4] != null ? +process.argv[4] : undefined;
if (!message) { console.error('Usage: scripts/notify.js "title" "message" [priority]'); process.exit(2); }

const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const { createAlerts } = require(path.join(root, 'lib', 'alerts'));
const alerts = createAlerts({ DATA_DIR, log: (m) => console.error(m) });

const blob = (title + ' ' + message).toLowerCase();
let kind = 'cli';
let hard = false;
if (/restart/.test(blob)) { kind = 'restart'; hard = true; }
else if (/hard\b|mint\/freeze|mint authority|freeze authority|lp (being )?pull|rug\b/.test(blob)) { kind = 'hard-flag'; hard = true; }
else if (/euphoria/.test(blob)) kind = 'sentiment-euphoria';
else if (/diverg/.test(blob)) kind = 'sentiment-divergence';
else if (/refresh fail/.test(blob)) kind = 'refresh-fail';
else if (/\ba-grade\b|\bgrade a\b/.test(blob)) kind = 'new-A';

(async () => {
  const e = await alerts.send(title, message, priority != null && !isNaN(priority) ? priority : (hard ? 5 : kind.startsWith('sentiment') || kind === 'new-A' ? 4 : 3), { kind, hard, key: 'cli:' + kind + ':' + Date.now() });
  console.log(JSON.stringify({ status: e.status, transports: e.transports, priority: e.priority, hard: e.hard, kind }));
  process.exit(e.status && String(e.status).startsWith('error') && !(e.transports && Object.values(e.transports).some((v) => v === 'sent')) ? 1 : 0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
