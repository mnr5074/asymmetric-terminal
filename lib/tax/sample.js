'use strict';
// EXAMPLE DATA ONLY: a fictional trader used to demo the Tax desk and generate research/tax_sample/*.
// No real person, wallet or account. Addresses below are obviously fake placeholders.
const { eventId } = require('./store');
const { matchTransfers } = require('./transfers');
const D = (s) => Date.parse(s + (s.length === 10 ? 'T17:00:00Z' : ''));
const SOLW = 'solana:EXAMPLEwa11et1111111111111111111111111', BASEW = 'base:0xexample000000000000000000000000000000b', CB = 'coinbase', KR = 'kraken', BRK = 'broker (EXAMPLE)';
const t = (ts, account, source, o, i, usd, fee, extra = {}) => ({ ts: D(ts), account, source, type: 'trade', out: o, in: i, usd, fee: fee ? fee : null, feeUsd: fee ? fee.usd ?? fee.qty : null, ...extra });
const q = (asset, qty, cls) => ({ asset, qty, ...(cls ? { cls } : {}) });
function events() {
  const E = [
    t('2025-02-10', CB, 'coinbase', q('USD', 48500), q('BTC', 0.5), 48500, { asset: 'USD', qty: 250 }),
    t('2025-03-05', CB, 'coinbase', q('USD', 22000), q('ETH', 10), 22000, { asset: 'USD', qty: 110 }),
    t('2025-06-01', CB, 'coinbase', q('USD', 30000), q('SOL', 200), 30000, { asset: 'USD', qty: 150 }),
    { ts: D('2025-07-15T16:00:00Z'), account: CB, source: 'coinbase', type: 'transfer_out', out: q('SOL', 150), usd: 24000, note: 'Send to own Phantom wallet' },
    { ts: D('2025-07-15T16:04:00Z'), account: SOLW, source: 'solana', type: 'transfer_in', in: q('SOL', 149.99), usd: 23998, note: 'Receive from Coinbase' },
    t('2025-08-01', SOLW, 'solana', q('SOL', 50), q('BONK', 400000000), 8000, { asset: 'SOL', qty: 0.002, usd: 0.32 }),
    t('2025-09-10', SOLW, 'solana', q('SOL', 40), q('WIF', 5000), 6400, { asset: 'SOL', qty: 0.002, usd: 0.3 }),
    t('2025-11-01', SOLW, 'solana', q('SOL', 20), q('RUGCAT', 1000000), 3500, { asset: 'SOL', qty: 0.002, usd: 0.35 }, { note: 'fictional memecoin, later rugged' }),
    t('2026-01-20', SOLW, 'solana', q('BONK', 400000000), q('SOL', 30), 4500, { asset: 'SOL', qty: 0.002, usd: 0.3 }),
    t('2026-02-15', SOLW, 'solana', q('SOL', 30), q('BONK', 420000000), 4600, { asset: 'SOL', qty: 0.002, usd: 0.3 }, { note: 'rebuy 26 days after BONK loss sale (wash sale only if crypto toggle ON)' }),
    t('2026-03-02', BRK, 'generic', q('USD', 25000), q('TSLA', 100, 'stock'), 25000, null),
    t('2026-03-20', CB, 'coinbase', q('BTC', 0.3), q('USD', 31500), 31500, { asset: 'USD', qty: 140 }),
    { ts: D('2026-04-10T15:00:00Z'), account: CB, source: 'coinbase', type: 'transfer_out', out: q('ETH', 5), usd: 16500 },
    { ts: D('2026-04-10T15:20:00Z'), account: KR, source: 'kraken', type: 'transfer_in', in: q('ETH', 4.998), usd: 16493 },
    t('2026-04-15', BRK, 'generic', q('TSLA', 100, 'stock'), q('USD', 21000), 21000, null),
    t('2026-04-28', BRK, 'generic', q('USD', 20500), q('TSLA', 100, 'stock'), 20500, null, { note: 'rebuy 13 days after TSLA loss sale: wash sale (securities)' }),
    t('2026-05-05', KR, 'kraken', q('ETH', 4.998), q('USD', 16993), 16993, { asset: 'USD', qty: 27 }),
    t('2026-05-12', BRK, 'generic', q('USD', 1800), q('AAPL 260918C00220000', 2, 'option'), 1800, { asset: 'USD', qty: 1.3 }),
    { ts: D('2026-06-01'), account: CB, source: 'coinbase', type: 'income', in: q('SOL', 3), usd: 480, incomeKind: 'staking' },
    { ts: D('2026-06-20'), account: SOLW, source: 'solana', type: 'income', in: q('JUP', 1000), usd: 800, incomeKind: 'airdrop' },
    t('2026-07-01', BRK, 'generic', q('AAPL 260918C00220000', 2, 'option'), q('USD', 600), 600, { asset: 'USD', qty: 1.3 }),
    { ts: D('2026-07-01T18:00:00Z'), account: CB, source: 'coinbase', type: 'income', in: q('SOL', 2), usd: 340, incomeKind: 'staking' },
    t('2026-07-20', BRK, 'generic', q('USD', 700), q('AAPL 260918C00220000', 2, 'option'), 700, { asset: 'USD', qty: 1.3 }, { note: 'reopened same option 19 days after loss: wash sale' }),
    t('2026-08-10', BRK, 'generic', q('TSLA', 100, 'stock'), q('USD', 26000), 26000, null),
    { ts: D('2026-08-15'), account: SOLW, source: 'solana', type: 'transfer_in', in: q('MYSTERY', 250), note: 'unsolicited token receipt (possible airdrop/spam)' },
    t('2026-09-20', SOLW, 'solana', q('WIF', 5000), q('SOL', 21.4), 3000, { asset: 'SOL', qty: 0.002, usd: 0.28 }),
    { ts: D('2026-09-25T15:00:00Z'), account: CB, source: 'coinbase', type: 'transfer_out', out: q('ETH', 2), usd: 6500 },
    { ts: D('2026-09-25T15:03:00Z'), account: BASEW, source: 'evm:base', type: 'transfer_in', in: q('ETH', 1.999), usd: 6497 },
    t('2026-09-26', BASEW, 'evm:base', q('ETH', 1.99), q('USDC', 6467), 6467, { asset: 'ETH', qty: 0.00002, usd: 0.07 }),
    t('2026-10-02', SOLW, 'solana', q('SOL', 20.7), q('WIF', 5000), 2900, { asset: 'SOL', qty: 0.002, usd: 0.28 }, { note: 'rebuy 12 days after WIF loss sale (exposed under the H.R. 10357 scenario)' }),
    t('2026-10-05', SOLW, 'solana', q('SOL', 30), q('USDC', 4200), 4200, { asset: 'SOL', qty: 0.002, usd: 0.28 }),
  ];
  for (const e of E) { e.example = true; e.id = eventId(e); }
  matchTransfers(E);
  return E.sort((a, b) => a.ts - b.ts);
}
// fictional "current" prices for the harvest section (EXAMPLE)
const PRICES = { BTC: 98000, ETH: 3100, SOL: 140, BONK: 0.0000098, WIF: 0.5, JUP: 0.45, RUGCAT: 0.000012, USDC: 1, MYSTERY: 0, 'AAPL 260918C00220000': 125, TSLA: 255 };
const SETTINGS = { method: 'FIFO', scope: 'wallet', washCrypto: 'off', year: 2026, filingStatus: 'single', otherIncome: 95000, qualifiedDividends: 0, stCarryover: 0, ltCarryover: 0, identicalGroups: '' };
const NOW = Date.parse('2026-10-11T12:00:00Z');
module.exports = { events, PRICES, SETTINGS, NOW };
