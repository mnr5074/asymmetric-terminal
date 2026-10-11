'use strict';
// Asset normalization + classification used by every parser and by the wash-sale grouping.
const FIAT = new Set(['USD', 'ZUSD', 'USD4']);
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'USDG', 'FDUSD', 'TUSD', 'USDP', 'GUSD', 'BUSD', 'USDE', 'USDS', 'USD1', 'RLUSD', 'USDC.E', 'USDBC', 'USDT0']);
// Kraken legacy asset codes
const KRAKEN = { XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE', XDG: 'DOGE', XLTC: 'LTC', XXRP: 'XRP', XXLM: 'XLM', XETC: 'ETC', XZEC: 'ZEC', XXMR: 'XMR', XREP: 'REP', XMLN: 'MLN', ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD', ZJPY: 'JPY' };
const WRAPPED = { WSOL: 'SOL', WETH: 'ETH', WBNB: 'BNB', WPOL: 'POL', WMATIC: 'POL', MATIC: 'POL', WAVAX: 'AVAX' };
function norm(sym) {
  if (!sym) return '';
  let s = String(sym).trim().toUpperCase();
  s = s.replace(/\.(S|M|F|P|B)$/, ''); // Kraken staking/earn suffixes: ETH2.S, DOT.S, SOL.F, USDC.M
  if (KRAKEN[s]) s = KRAKEN[s];
  if (s === 'ETH2') s = 'ETH';
  return s;
}
// Tax identity of an asset: wrapped natives are the same economic asset for matching transfers,
// but swaps SOL<->WSOL are not disposals (handled by the Solana parser ignoring WSOL wrap/unwrap).
const taxKey = (sym) => WRAPPED[norm(sym)] || norm(sym);
const isFiat = (s) => FIAT.has(norm(s));
const isStable = (s) => STABLE.has(norm(s));
// OCC option symbol, e.g. "AAPL 250117C00150000" or "AAPL250117C150"
const OPT_RE = /^([A-Z.]{1,6})\s*(\d{6})([CP])(\d{3,8}(\.\d+)?)$/;
// Tokenized stocks: xStocks on Solana ("AAPLx"), Robinhood stock tokens, Ondo GM ("AAPLon"), Backed ("bAAPL")
const TOKENIZED_RE = /^(?:([A-Z]{1,5})X|([A-Z]{1,5})ON|B([A-Z]{1,5}))$/i;
const KNOWN_TICKERS = new Set('AAPL TSLA NVDA MSFT AMZN GOOGL GOOG META SPY QQQ COIN HOOD MSTR AMD NFLX PLTR CRCL GME IBIT GLD TLT'.split(' '));
function classify(sym, hint) {
  const raw = String(sym || '').trim();
  if (hint && ['crypto', 'stock', 'option', 'tokenized_security', 'nft'].includes(hint)) return hint;
  if (OPT_RE.test(raw.toUpperCase().replace(/\s+/g, ' '))) return 'option';
  const m = raw.match(/^([A-Za-z]{1,5})x$/) || raw.match(/^([A-Za-z]{1,5})on$/) || raw.match(/^b([A-Z]{1,5})$/);
  if (m && KNOWN_TICKERS.has(m[1].toUpperCase())) return 'tokenized_security';
  return 'crypto';
}
// Group key for "substantially identical" matching.
// Securities: stock, its options and tokenized versions share the underlying ticker (conservative; the IRS has not
// ruled on tokenized stock vs stock). Crypto: same tax key, plus user-defined groups like "BTC,WBTC,CBBTC".
function underlying(sym, cls) {
  const s = String(sym || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (cls === 'option') { const m = s.match(OPT_RE); return m ? m[1] : s; }
  if (cls === 'tokenized_security') { const m = String(sym).match(/^([A-Za-z]{1,5})(x|on)$/) || String(sym).match(/^b([A-Z]{1,5})$/); return m ? m[1].toUpperCase() : s; }
  return s;
}
function groupFn(groupsText) {
  const map = {};
  for (const line of String(groupsText || '').split(/[;\n]/)) {
    const syms = line.split(/[,\s]+/).map(norm).filter(Boolean);
    if (syms.length > 1) for (const s of syms) map[s] = syms[0];
  }
  return (sym, cls) => { if (cls && cls !== 'crypto' && cls !== 'nft') return 'SEC:' + underlying(sym, cls); const k = taxKey(sym); return 'CRY:' + (map[k] || k); };
}
module.exports = { norm, taxKey, isFiat, isStable, classify, underlying, groupFn, OPT_RE };
