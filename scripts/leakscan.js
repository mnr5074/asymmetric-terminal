#!/usr/bin/env node
// Leak scan for API keys / secrets in the project tree: source, logs, data/, public/ (the served bundle) and git-tracked files.
// Reports FILE PATHS, line numbers and pattern ids only — never the matched text or any secret value.
// Detection: (1) exact occurrences of the current secret values (env vars named *KEY*/*TOKEN*/*SECRET*/*PASSWORD* + values in .env),
//            (2) key-shaped patterns (xAI keys, X bearer tokens, Bearer headers, apikey assignments, private-key blocks, GitHub/AWS/Slack tokens).
// Usage: node scripts/leakscan.js [--out data/keyhealth_leakscan.json] [--root DIR] [--max-mb 64] [--quiet]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('--root', path.join(__dirname, '..')));
const OUT = opt('--out', null);
const MAX = +opt('--max-mb', 64) * 1048576;
const QUIET = args.includes('--quiet');
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache']);
const BIN_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|db|db-wal|db-shm|sqlite|gz|zip|tar|tgz|xz|bz2|woff2?|ttf|otf|mp4|webm|so|node|wasm|pyc|hex)$/i;
const SELF = new Set(['data/keyhealth_salt']); // fingerprint salt (random, not a secret value)
const EXPECTED = new Set(['.env']); // the one place secrets are supposed to live (checked for permissions instead)

// ---- secret values to look for (held in memory only) ----
const vals = []; // {name, v}
const addVal = (name, v, min = 12) => { v = String(v || '').trim().replace(/^['"]|['"]$/g, ''); if (v.length >= min && !vals.some((x) => x.v === v)) vals.push({ name, v }); };
for (const [k, v] of Object.entries(process.env)) if (/(KEY|TOKEN|SECRET|PASSWORD|BEARER|PRIVATE)/i.test(k) && !/^(npm_|GPG_|SSH_AUTH)/i.test(k) && !/_NAMES$/.test(k)) addVal(k, v);
if (process.env.NTFY_TOPIC) addVal('NTFY_TOPIC', process.env.NTFY_TOPIC);
try { for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && /(KEY|TOKEN|SECRET|PASSWORD|NTFY_TOPIC)/.test(m[1])) addVal(m[1], m[2], (m[1] === 'NTFY_TOPIC' || m[1] === 'SITE_PASSWORD') ? 6 : 12); } } catch {}
// short passwords (< 12 chars) are not searched for verbatim (too many false positives) — reported as a limitation

const PATTERNS = [
  ['xai_api_key', /xai-[A-Za-z0-9]{40,}/g, 'high'],
  // X app-only bearer: 21+ 'A' prefix, URL-encoded (%2B/%2F/%3D) body; plain base64 runs of 'A' (Solana tx data in caches) don't match
  ['x_bearer_token', /(?<![A-Za-z0-9+/])AAAAAAAAAAAAAAAAAAAAA(?=[A-Za-z0-9%]*%(?:2B|2F|3D))[A-Za-z0-9%]{50,120}(?![A-Za-z0-9%+/=])/g, 'high'],
  ['bearer_header_literal', /[Bb]earer\s+[A-Za-z0-9\-._~+/%]{32,}=*/g, 'high'],
  ['apikey_assignment', /(?<![A-Za-z0-9_-])(?:api[_-]?key|apikey|x-api-key|secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/]{24,}["']/gi, 'medium'],
  ['brevo_api_key', /\bxkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/g, 'high'],
  ['ntfy_url', /ntfy\.sh\/[A-Za-z0-9_-]{6,}/g, 'medium'],
  ['private_key_block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'high'],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'high'],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g, 'high'],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'high'],
  ['solana_keypair_array', /\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g, 'low'],
];

let tracked = null, gitNote = null;
try { if (fs.existsSync(path.join(ROOT, '.git'))) tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean)); else gitNote = 'not a git repository (no tracked files to check)'; } catch (e) { gitNote = 'git ls-files failed: ' + e.message.slice(0, 80); }

const findings = [], skipped = [];
let files = 0, bytes = 0;
function lineOf(buf, idx, base) { let n = base; for (let i = 0; i < idx; i++) if (buf.charCodeAt(i) === 10) n++; return n; }
function scanText(rel, text, lineBase, acc) {
  for (const { name, v } of vals) { let i = text.indexOf(v); while (i >= 0) { (acc[`exact:${name}`] ||= { sev: 'critical', lines: [] }).lines.push(lineOf(text, i, lineBase)); i = text.indexOf(v, i + v.length); } }
  for (const [id, rx, sev] of PATTERNS) { rx.lastIndex = 0; let m; let c = 0; while ((m = rx.exec(text)) && c < 50) { c++; (acc[id] ||= { sev, lines: [] }).lines.push(lineOf(text, m.index, lineBase)); } }
}
function scanFile(abs, rel) {
  let st; try { st = fs.statSync(abs); } catch { return; }
  if (BIN_EXT.test(rel) || SELF.has(rel)) return;
  if (st.size > MAX) { skipped.push({ path: rel, reason: `larger than ${MAX / 1048576} MB`, size: st.size }); return; }
  files++; bytes += st.size;
  const acc = {};
  if (st.size <= 16 * 1048576) { let t; try { t = fs.readFileSync(abs, 'latin1'); } catch { return; } if (t.indexOf('\0') >= 0 && t.indexOf('\0') < 4096) { files--; return; } scanText(rel, t, 1, acc); }
  else { // chunked with overlap
    const fd = fs.openSync(abs, 'r'); const CH = 8 << 20, OV = 4096; const b = Buffer.alloc(CH + OV); let pos = 0, line = 1, carry = '';
    while (pos < st.size) { const n = fs.readSync(fd, b, 0, CH, pos); if (!n) break; const t = carry + b.toString('latin1', 0, n); scanText(rel, t, line - (carry.match(/\n/g) || []).length, acc); line += (b.toString('latin1', 0, n).match(/\n/g) || []).length; carry = t.slice(-OV); pos += n; }
    fs.closeSync(fd);
  }
  const ids = Object.keys(acc);
  if (!ids.length) return;
  if (EXPECTED.has(rel)) return; // .env is the intended store (permission check below)
  const isPublic = rel.startsWith('public/');
  const dedup = (a) => [...new Set(a)].sort((x, y) => x - y);
  for (const id of ids) {
    let sev = acc[id].sev; let note;
    if (id === 'apikey_assignment' && /(coins?_list|cg_list)\.json$/.test(rel)) { sev = 'info'; note = 'known false positive: CoinGecko platform key "secret" = Secret Network contract address'; }
    if (id === 'solana_keypair_array' && /_cache\//.test(rel)) note = 'inside a cached on-chain transaction (likely 64-byte signature/instruction data, not a keypair)';
    if (isPublic) sev = 'critical';
    findings.push({ path: rel, pattern: id, severity: sev, count: acc[id].lines.length, lines: dedup(acc[id].lines).slice(0, 8), served: isPublic, gitTracked: tracked ? tracked.has(rel) : null, note, kind: rel.startsWith('data/') ? 'data' : /\.log$|\.jsonl$/.test(rel) ? 'log' : isPublic ? 'public-bundle' : 'source' });
  }
}
function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const abs = path.join(dir, e.name); const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); }
    else if (e.isFile()) scanFile(abs, rel);
  }
}
const t0 = Date.now();
walk(ROOT);
let envPerm = null; try { const st = fs.statSync(path.join(ROOT, '.env')); envPerm = (st.mode & 0o777).toString(8); } catch {}
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.path.localeCompare(b.path));
const out = {
  generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, root: ROOT, filesScanned: files, mbScanned: +(bytes / 1048576).toFixed(1),
  secretsSearched: vals.map((x) => x.name), patterns: PATTERNS.map((p) => p[0]),
  git: tracked ? { trackedFiles: tracked.size } : { note: gitNote },
  envFile: envPerm ? { path: '.env', mode: envPerm, ok: envPerm === '600' || envPerm === '400', gitignored: (() => { try { return /^\.env$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')); } catch { return false; } })() } : null,
  summary: { findings: findings.length, critical: findings.filter((f) => f.severity === 'critical').length, high: findings.filter((f) => f.severity === 'high').length, medium: findings.filter((f) => f.severity === 'medium').length, low: findings.filter((f) => f.severity === 'low').length, info: findings.filter((f) => f.severity === 'info').length, exactValueHits: findings.filter((f) => f.pattern.startsWith('exact:')).length, publicBundleHits: findings.filter((f) => f.served).length },
  findings, skipped,
  limits: ['env values shorter than 12 characters are not searched verbatim (SITE_PASSWORD and NTFY_TOPIC: 6)', 'binary files (images, PDFs, sqlite .db) are skipped', 'node_modules/.git skipped'],
};
if (OUT) { fs.writeFileSync(OUT + '.tmp', JSON.stringify(out, null, 1), { mode: 0o600 }); fs.renameSync(OUT + '.tmp', OUT); }
if (!QUIET) { const { findings: f, ...rest } = out; console.log(JSON.stringify({ ...rest, findings: f.map((x) => `${x.severity.toUpperCase()} ${x.pattern} ${x.path}:${x.lines.join(',')} (${x.count})`) }, null, 1)); }
