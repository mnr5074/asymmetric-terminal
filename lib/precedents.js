// Real crash precedents (research/forensics_cases.json) attached to exit-plan triggers as "this happened before" examples.
'use strict';
const fs = require('fs'); const path = require('path');
let P = []; try { P = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'forensics_cases.json'), 'utf8')).cases || []; } catch {}
const by = (sig) => P.find((c) => c.signal === sig);
// map exit-plan trigger text -> precedent signal
const MAP = [[/unlock/i, 'unlock'], [/fund|VC/, 'fund_to_cex'], [/several wallets|cluster|top holders exiting/i, 'cex_cluster'], [/dev\/insider|deployer|treasury|reward/i, 'deployer_sell'], [/trailing stop/i, 'offchain_dump']];
function forTrigger(t) { for (const [re, s] of MAP) if (re.test(t)) { const c = by(s); if (c) return `${c.symbol}: ${c.finding.split(';')[0]}.`; } return null; }
module.exports = { all: () => P, forTrigger };
