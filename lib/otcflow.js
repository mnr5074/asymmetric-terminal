'use strict';
// Dark-pool / OTC flow detector (research/riskinfra/otcflow.py -> data/riskinfra_otcflow.json, rolling event log).
// Large wallet-to-wallet ERC-20 transfers of tracked tokens, transfers to/from OTC desks & market makers (vc_wallets.json + public
// explorer labels), CEX-to-CEX moves, round amounts, fan-out splits, and the Binance price move 30/60 min after. Incremental by block.
const { createRunner } = require('./oracles');

function createOtcFlow({ DATA_DIR, log = () => {}, everyMs = 30 * 60e3 }) {
  const r = createRunner({ DATA_DIR, name: 'otcflow', script: 'otcflow.py', file: 'riskinfra_otcflow.json', everyMs, timeoutMs: 15 * 60e3, log });
  function api(q) {
    const d = r.load();
    if (!d) { r.run(); throw Object.assign(new Error('riskinfra_otcflow.json is being generated (~5 min first run); try again shortly'), { status: 503 }); }
    const lim = Math.min(600, +(q && q.get && q.get('limit')) || 150);
    const { events, method, ...rest } = d;
    return { ...rest, events: (events || []).slice(0, lim), totalEvents: (events || []).length, runner: r.status() };
  }
  return { ...r, api };
}
module.exports = { createOtcFlow };
