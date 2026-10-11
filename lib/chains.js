// Chain registry: DexScreener chainId -> GeckoTerminal network, GoPlus id, Honeypot.is id, public RPC, native coin.
// Every endpoint below was verified keyless on 2026-10-10 (see README "Multi-chain" table).
'use strict';
const CHAINS = {
  solana:    { name: 'Solana',    short: 'SOL',  kind: 'solana', gt: 'solana',       goplus: 'solana', native: 'SOL',  cg: 'solana',             explorer: 'https://solscan.io/token/' },
  ethereum:  { name: 'Ethereum',  short: 'ETH',  kind: 'evm', gt: 'eth',             goplus: '1',     honeypot: 1,    rpc: 'https://ethereum-rpc.publicnode.com',        native: 'ETH',  cg: 'ethereum',          explorer: 'https://etherscan.io/token/' },
  base:      { name: 'Base',      short: 'BASE', kind: 'evm', gt: 'base',            goplus: '8453',  honeypot: 8453, rpc: 'https://base-rpc.publicnode.com',            native: 'ETH',  cg: 'ethereum',          explorer: 'https://basescan.org/token/' },
  bsc:       { name: 'BSC',       short: 'BSC',  kind: 'evm', gt: 'bsc',             goplus: '56',    honeypot: 56,   rpc: 'https://bsc-rpc.publicnode.com',             native: 'BNB',  cg: 'binancecoin',       explorer: 'https://bscscan.com/token/' },
  arbitrum:  { name: 'Arbitrum',  short: 'ARB',  kind: 'evm', gt: 'arbitrum',        goplus: '42161',                 rpc: 'https://arbitrum-one-rpc.publicnode.com',    native: 'ETH',  cg: 'ethereum',          explorer: 'https://arbiscan.io/token/' },
  polygon:   { name: 'Polygon',   short: 'POL',  kind: 'evm', gt: 'polygon_pos',     goplus: '137',                   rpc: 'https://polygon-bor-rpc.publicnode.com',     native: 'POL',  cg: 'polygon-ecosystem-token', explorer: 'https://polygonscan.com/token/' },
  avalanche: { name: 'Avalanche', short: 'AVAX', kind: 'evm', gt: 'avax',            goplus: '43114',                 rpc: 'https://avalanche-c-chain-rpc.publicnode.com', native: 'AVAX', cg: 'avalanche-2',     explorer: 'https://snowtrace.io/token/' },
  blast:     { name: 'Blast',     short: 'BLST', kind: 'evm', gt: 'blast',           goplus: '81457',                 rpc: 'https://blast-rpc.publicnode.com',           native: 'ETH',  cg: 'ethereum',          explorer: 'https://blastscan.io/token/' },
  optimism:  { name: 'Optimism',  short: 'OP',   kind: 'evm', gt: 'optimism',        goplus: '10',                    rpc: 'https://optimism-rpc.publicnode.com',        native: 'ETH',  cg: 'ethereum',          explorer: 'https://optimistic.etherscan.io/token/' },
  robinhood: { name: 'Robinhood Chain', short: 'RH', kind: 'evm', gt: 'robinhood',   goplus: '4663',                  rpc: 'https://rpc.mainnet.chain.robinhood.com',    native: 'ETH',  cg: 'ethereum' },
  sui:       { name: 'Sui',       short: 'SUI',  kind: 'sui', gt: 'sui-network',     goplus: 'sui',   native: 'SUI',  cg: 'sui',               explorer: 'https://suivision.xyz/coin/' },
  ton:       { name: 'TON',       short: 'TON',  kind: 'ton', gt: 'ton',             native: 'TON',  cg: 'the-open-network',  explorer: 'https://tonviewer.com/' },
  tron:      { name: 'Tron',      short: 'TRX',  kind: 'tron', gt: 'tron',           goplus: 'tron',  native: 'TRX',  cg: 'tron',              explorer: 'https://tronscan.org/#/token20/' },
};
const IDS = Object.keys(CHAINS);
const isChain = (c) => Object.prototype.hasOwnProperty.call(CHAINS, c);
const EVM = IDS.filter((c) => CHAINS[c].kind === 'evm');
const re = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  sui: /^0x[0-9a-fA-F]{1,64}(::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*)?$/,
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|-?\d:[0-9a-fA-F]{64})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
function validAddr(chain, a) { const c = CHAINS[chain]; return !!c && re[c.kind].test(a || ''); }
// Guess chains for a pasted address (for "All chains" scanner / wallet)
function guessKinds(a) { return Object.entries(re).filter(([, r]) => r.test(a || '')).map(([k]) => k); }
// Public view for the frontend
const publicList = () => IDS.map((id) => ({ id, name: CHAINS[id].name, short: CHAINS[id].short, kind: CHAINS[id].kind, native: CHAINS[id].native, explorer: CHAINS[id].explorer || null }));
module.exports = { CHAINS, IDS, EVM, isChain, validAddr, guessKinds, publicList };
