'use strict';
// HTTP glue for the swap / MEV (and portfolio) modules. Mounted from server.js with one line so the
// main route table (GET-only) stays untouched. POST is used only for build/submit/settings bodies.
const swaps = require('./swaps');
const mev = require('./mev');
let portfolio = null; try { portfolio = require('./portfolio'); } catch {}

const GET = {
  '/api/swap/config': () => swaps.config(),
  '/api/swap/quote': (q, req) => swaps.quote(Object.fromEntries(q), req),
  '/api/mev/log': (q) => mev.log(q),
  '/api/mev/audit': (q, req) => {
    if (q.get('job')) return mev.getAudit(q.get('job'));
    const a = (q.get('address') || '').trim();
    if (!swaps.isAddr(a)) throw Object.assign(new Error('a Solana address is required'), { status: 400 });
    return mev.startAudit(a, +q.get('limit') || 20, req);
  },
  '/api/mev/audits': () => mev.audits(),
};
const POST = {
  '/api/swap/build': (b, req) => swaps.build(b, req),
  '/api/swap/submit': (b, req) => swaps.submit(b, req, mev),
  '/api/mev/settings': (b) => mev.setSettings(b),
};
if (portfolio) { Object.assign(GET, portfolio.GET || {}); Object.assign(POST, portfolio.POST || {}); }

function owns(pathname) { return pathname.startsWith('/api/swap/') || pathname.startsWith('/api/mev/') || pathname.startsWith('/api/portfolio'); }
async function handle(req, res, u) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const table = req.method === 'POST' ? POST : req.method === 'GET' ? GET : null;
  const h = table && table[u.pathname];
  if (!h) return send(table ? 404 : 405, { error: 'not found' });
  try {
    const arg = req.method === 'POST' ? await swaps.readBody(req) : u.searchParams;
    send(200, await h(arg, req));
  } catch (e) { send(e.status || 502, { error: String(e.message || e) }); }
}
module.exports = { owns, handle };
