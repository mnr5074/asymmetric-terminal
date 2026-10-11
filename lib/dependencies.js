'use strict';
// Cross-protocol dependency risk (research/riskinfra/dependencies.py -> data/riskinfra_dependencies.json).
// Graph: watchlist tokens / DeFi positions -> oracle provider, bridge, collateral, issuer, lending market. Stress signals: stablecoin
// depegs, LST/LRT discount to NAV, lending utilization ~100% / paused reserves, bridge TVL outflows, DefiLlama hacks, oracle flags.
// Dependents of a stressed node are flagged with the path. Runs after each oracle run and on its own every 15 min.
const { createRunner } = require('./oracles');

function createDependencies({ DATA_DIR, log = () => {}, everyMs = 15 * 60e3 }) {
  const r = createRunner({ DATA_DIR, name: 'dependencies', script: 'dependencies.py', file: 'riskinfra_dependencies.json', everyMs, timeoutMs: 5 * 60e3, log });
  function api(q) {
    const d = r.load();
    if (!d) { r.run(); throw Object.assign(new Error('riskinfra_dependencies.json is being generated; try again shortly'), { status: 503 }); }
    if (q && q.get && q.get('full') === '1') return { ...d, runner: r.status() };
    const { nodes, edges, method, ...rest } = d;
    return { ...rest, graphSize: { nodes: Object.keys(nodes || {}).length, edges: (edges || []).length }, runner: r.status() };
  }
  return { ...r, api };
}
module.exports = { createDependencies };
