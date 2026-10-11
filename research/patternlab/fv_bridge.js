// Bridge: run lib/fakevolume.js analyzeTrades()+score() (the SAME detector the live terminal uses) on trade lists from Python.
// stdin: {"<key>": [{t, trader, side, usd, amt}], ...}  stdout: {"<key>": {analysis..., score}}
const fv = require('../../lib/fakevolume');
let buf = ''; process.stdin.on('data', (d) => (buf += d)); process.stdin.on('end', () => {
  const inp = JSON.parse(buf); const out = {};
  for (const [k, trades] of Object.entries(inp)) { try { const a = fv.analyzeTrades(trades, {}); let s = null; try { s = fv.score(a, {}); } catch (e) { s = { err: String(e).slice(0, 80) }; } out[k] = { ...a, score: s }; } catch (e) { out[k] = { ok: false, err: String(e).slice(0, 120) }; } }
  process.stdout.write(JSON.stringify(out));
});
