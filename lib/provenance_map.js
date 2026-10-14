'use strict';
// Provenance surface map + resolver for lib/provenance.js.
//   SURFACES: field-level specs for the highest-value API routes (which upstream endpoint, chain/block, as-of, transform per field).
//   FILES:    route -> data file(s) + writer for file-level fallback (mtime, generatedAt, embedded src/method fields).
//   PANELS:   UI panel inventory (panel id -> route) used for the coverage report and the UI 'src' affordance.
// Levels: 'field' (explicit per-field spec), 'field-embedded' (the data row itself carries src/venue/as-of fields),
//         'file' (data file / in-memory snapshot time + writer + declared sources only), 'none'.
const fs = require('fs');
const path = require('path');
const prov = require('./provenance');

const DS = 'https://api.dexscreener.com';
const VENUE_EP = {
  binance: 'https://www.binance.com/fapi/v1/premiumIndex (funding/mark) + /fapi/v1/ticker/24hr + /futures/data/openInterestHist',
  bybit: 'https://api.bybit.com/v5/market/tickers?category=linear',
  okx: 'https://www.okx.com/api/v5/public/funding-rate + /public/open-interest?instType=SWAP + /market/tickers',
  hyperliquid: 'https://api.hyperliquid.xyz/info {type:metaAndAssetCtxs}',
  gate: 'https://api.gateio.ws/api/v4/futures/usdt/tickers',
};
const VENUE_HOST = { binance: 'binance.com/fapi/v1/premiumindex', bybit: 'v5/market/tickers?category=linear', okx: 'okx.com/api/v5/public/funding-rate', hyperliquid: 'api.hyperliquid.xyz/info', gate: 'gateio.ws/api/v4/futures/usdt/tickers' };
const STABLE_RPC = { ethereum: 'https://rpc.mevblocker.io (eth_getLogs Transfer from/to 0x0, eth_call totalSupply)', base: 'https://gateway.tenderly.co/public/base', robinhood: 'https://rpc.mainnet.chain.robinhood.com', solana: 'https://api.mainnet-beta.solana.com (getTokenSupply snapshots)' };
const iso = (t) => (t ? new Date(t).toISOString() : null);
const toMs = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; const n = Date.parse(v); return Number.isFinite(n) ? n : null; };

// ---- composite factor -> upstream map (lib/composite.js factor keys) ----
const FACTOR_SRC = {
  crash: { source: 'crash catalog + crash-lookalike', files: ['crash_catalog.json', 'crash_fingerprints.json'], transform: 'lib/crashmatch.js nearest-25 historical chart similarity -> crash odds -> score' },
  patterns: { source: 'pattern detectors', files: ['patterns_hours.json', 'patterns_wallets_live.json', 'patterns_flows_live.json', 'patterns_aging_live.json'], transform: 'lib/patterns.js detector values (0-100) averaged' },
  pump: { source: 'launch footprint research', files: ['screener.json', 'analysis.json'], transform: 'graduation speed / holder spread / buy-size curve -> score' },
  rug: { source: 'live feed rug forecast (on-chain scan + DexScreener liquidity)', mem: 'live', transform: 'lib/rugrisk.js forecast score -> inverted factor' },
  sleeper: { source: 'sleeper screen (CoinGecko free API)', files: ['sleepers.json'], transform: 'research/sleepers.py score' },
  moonshot: { source: 'live feed asymmetry score (DexScreener/GeckoTerminal/on-chain scan)', mem: 'live', transform: 'lib/livefeed.js score()' },
  macro: { source: 'macro calendar (FRED, federalreserve.gov, Kalshi, Polymarket)', mem: 'macro', transform: 'event proximity penalty up to -10' },
  perp: { source: 'perp funding/OI (Binance/Bybit/OKX/Hyperliquid/Gate public APIs)', mem: 'perps', files: ['perps.json', 'perps_stats.json'], transform: 'OI-weighted annualized funding + 24h OI change -> score' },
  unlocks: { source: 'token unlock schedule (research/unlocks.py, CoinGecko + public vesting data)', files: ['unlocks.json', 'unlocks_calendar.json'], transform: '% of circulating unlocking in 30d -> penalty up to -30' },
  dev: { source: 'GitHub commit activity (research/devactivity.py)', files: ['devactivity_map.json'], transform: 'commit frequency / silence / burst -> score' },
  liq: { source: 'liquidation cascades (Gate/OKX liquidation feeds, Binance/Bybit WS)', mem: 'liquidations', files: ['liquidations.json'], transform: 'cascade level -> fixed score table' },
  gaps: { source: 'cross-exchange price gaps (Binance/OKX/Kraken/Coinbase/Gate tickers)', mem: 'pricegaps', files: ['pricegaps.json'], transform: 'sustained gap / gap-prone history -> score' },
  contract: { source: 'contract vulnerability scan (public RPC bytecode/source)', files: ['contractscan.json'], transform: 'lib/contractscan.js findings -> score/cap' },
  season: { source: 'session seasonality (research/seasonality.py, exchange candles)', files: ['seasonality_live.json'], transform: 'window vol ratio (BH q<0.05) -> score' },
  sentiment: { source: 'X social oscillator (free collector)', files: ['sentiment_counts.json', 'sentiment_history.json'], transform: 'contrarian oscillator -> score (weight 0.25)' },
  fakevol: { source: 'fake/wash volume detector (DexScreener + GeckoTerminal trades)', files: ['fakevolume_live.json'], transform: 'lib/fakevolume.js -> score' },
  news: { source: 'Grok headline layer (xAI API over RSS/priority/regradar headlines)', files: ['grok_signals.json'], transform: '50 ± 12 from confidence×urgency×recency-weighted tone (24h, 12h half-life)' },
};

const DSF = (label, key, tf) => ({ source: 'DexScreener', label, ep: `${DS}/tokens/v1/{chain}/{address}`, match: (r) => ['api.dexscreener.com/tokens/v1/' + r.chain, r.address], asOf: (r) => r.mAt, transform: tf || `best pair by USD liquidity; pair.${key} (server summarizePair)`, chain: (r) => r.chain, pair: (r) => r.pairAddress });

const SURFACES = {
  '/api/live': {
    label: 'Live alpha feed', file: 'live_feed.json', rows: 'items', rowKey: ['key', 'address', 'symbol'], asOf: (d) => d.generatedAt,
    fields: {
      price: DSF('Price', 'priceUsd'), mcap: DSF('Market cap', 'marketCap', 'marketCap (falls back to fdv in the UI)'), fdv: DSF('FDV', 'fdv'), liq: DSF('Liquidity', 'liquidity.usd'),
      vol1h: DSF('Volume 1h', 'volume.h1'), vol24: DSF('Volume 24h', 'volume.h24'), ch5: DSF('Change 5m', 'priceChange.m5'), ch1: DSF('Change 1h', 'priceChange.h1'), ch24: DSF('Change 24h', 'priceChange.h24'),
      ageH: { ...DSF('Age', 'pairCreatedAt'), transform: '(now - pair.pairCreatedAt | pool created | first seen) in hours' },
      score: { source: 'derived (lib/livefeed.js score)', transform: 'weighted factors flow/participation/safety/upside/similarity/narrative/smart/attention from DexScreener m, GeckoTerminal unique buyers, on-chain scan, moonshot model (data/live_model.json), weights data/live_weights.json', asOf: (r, d) => d.generatedAt, inputs: ['price', 'liq', 'vol1h', 'risk'] },
      grade: { source: 'derived (lib/livefeed.js)', transform: 'score thresholds + vetoes (mint/freeze authority, honeypot, tax, bundle, fake liquidity)', asOf: (r, d) => d.generatedAt },
      risk: { source: 'on-chain scan (lib/scanner.js)', ep: '{chain} public RPC (lib/solrpc.js / chains.js) + DexScreener /token-pairs/v1 + rugcheck.xyz (solana)', match: (r) => [r.address], asOf: (r) => r.scannedAt, transform: 'riskScore = weighted check levels', chain: (r) => r.chain },
      rug: { source: 'rug forecast (lib/rugrisk.js)', transform: 'liquidity drop / holder trend / whale exit signals over live snapshots', asOf: (r, d) => d.generatedAt, chain: (r) => r.chain },
    },
    aliases: { mcap: ['mcap', 'marketcap', 'mc'], liq: ['liq', 'liquidity'], ch1: ['1h', 'ch1', 'change1h'], ch24: ['24h', 'ch24'], ch5: ['5m', 'ch5'], score: ['score', 'asym'], grade: ['gr', 'grade'], ageH: ['age', 'ageh'], risk: ['risk'], rug: ['rug'], price: ['price', 'px'] },
    display: ['grade', 'score', 'ageH', 'mcap', 'liq', 'ch1', 'ch24', 'rug'],
  },
  '/api/tokens': {
    label: 'Watchlist prices (DexScreener)', rows: '*', rowKey: ['address', 'symbol'],
    fields: {
      priceUsd: { source: 'DexScreener', ep: `${DS}/tokens/v1/{chain}/{address}`, match: (r) => ['api.dexscreener.com/tokens/v1/', r.address], asOf: () => null, transform: 'best pair by USD liquidity, cached 12s', chain: (r) => r.chainId, pair: (r) => r.pairAddress },
      liquidityUsd: { source: 'DexScreener', ep: `${DS}/tokens/v1/{chain}/{address}`, match: (r) => ['api.dexscreener.com/tokens/v1/', r.address], transform: 'pair.liquidity.usd', chain: (r) => r.chainId, pair: (r) => r.pairAddress },
      change: { source: 'DexScreener', ep: `${DS}/tokens/v1/{chain}/{address}`, match: (r) => ['api.dexscreener.com/tokens/v1/', r.address], transform: 'pair.priceChange', chain: (r) => r.chainId, pair: (r) => r.pairAddress },
    },
    aliases: { priceUsd: ['price'], liquidityUsd: ['liq'], change: ['1h', '24h'] }, display: ['priceUsd', 'change', 'liquidityUsd'],
  },
  '/api/perps': {
    label: 'Perp desk funding / OI', file: 'perps.json', rows: 'tokens', rowKey: ['sym'], asOf: (d) => d.generatedAt,
    fields: {
      fAnn: { source: 'perp venues (per-venue funding)', venues: true, transform: 'OI-weighted mean of per-venue annualized funding (rate × 24/intervalH × 365 × 100); weight = max(OI, $100k)' },
      oiUsd: { source: 'perp venues (open interest)', venues: true, transform: 'sum of per-venue open interest in USD' },
      mark: { source: 'perp venues (mark price)', venues: true, transform: 'first venue mark (normalized for 1000x contracts)' },
      z: { source: 'settled funding history (research/perps.py -> data/perps_stats.json)', file: 'perps_stats.json', transform: 'OI-weighted per-venue z-score vs settled funding history' },
      spread: { source: 'perp venues', venues: true, transform: 'max - min annualized funding across venues' },
      vol24Usd: { source: 'perp venues (24h volume)', venues: true, transform: 'sum across venues' },
      ch24: { source: 'perp venues (24h change)', venues: true, transform: 'venue ticker 24h % change' },
    },
    aliases: { fAnn: ['funding', 'fund', 'fann', 'funding ann', 'f/yr', 'funding%'], oiUsd: ['oi', 'open interest'], mark: ['mark', 'price'], z: ['z', 'zscore'], spread: ['spread'], ch24: ['24h'] },
    display: ['mark', 'fAnn', 'z', 'oiUsd', 'spread', 'ch24'],
  },
  '/api/composite': {
    label: 'Composite A–F grades', rows: 'tokens', rowKey: ['sym', 'key', 'symbol'], asOf: (d) => d.generatedAt, factors: true,
    fields: {
      score: { source: 'derived (lib/composite.js)', transform: 'weighted average of available factor scores, then penalty adjustments (macro ≤ −10, unlocks ≤ −30); see factors[] for each input', asOf: (r, d) => d.generatedAt },
      grade: { source: 'derived (lib/composite.js)', transform: 'A ≥ 68, B ≥ 58, C ≥ 48, D ≥ 38, else F; factor caps (rug/contract/unlocks) applied', asOf: (r, d) => d.generatedAt },
    },
    aliases: { score: ['score', 'composite'], grade: ['grade', 'gr', 'comp'] }, display: ['grade', 'score', '<factors>'],
  },
  '/api/stables': {
    label: 'Stablecoin issuance', file: 'stables.json', asOf: (d) => toMs(d.generatedAt), stables: true,
    fields: {}, display: ['chains.*.net_1d', 'chains.*.net_7d', 'chains.*.supply', 'onchain.*.windows.24h.mint', 'onchain.*.windows.24h.burn', 'onchain.*.totalSupply', 'velocity_ranking', 'base_share'],
  },
  '/api/priority': {
    label: 'Priority watch (NEAR/ZEC)', file: 'priority.json', rows: 'tokens', rowKey: ['sym'], asOf: (d) => toMs(d.generatedAt), embedded: true,
    fields: {
      'market.*': { source: 'CoinGecko /coins/markets (free)', ep: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids={cgId}', asOf: (r) => toMs(r.market?.updated), transform: 'none (as reported); updated = CoinGecko last_updated' },
      'perps.*': { source: 'perp venues via research/priority.py', venues: 'perps.venues', transform: 'per-venue funding annualized; OI change from venue OI history (oiChSrc)' },
    },
    display: ['market.price', 'market.ch24', 'market.mcap', 'perps.venues.fAnnPct', 'perps.venues.oiUsd', 'tokenomics.*'],
  },
  '/api/priority/shielded': { label: 'ZEC shielded supply', file: 'zec_shielded.json', embedded: true, asOf: (d) => toMs(d.generatedAt), fields: {}, display: ['current.shielded', 'current.sharePct', 'current.height'] },
  '/api/x': {
    label: 'X mentions (X API v2)', file: 'x_cache.json', rows: 'items', rowKey: ['sym'],
    fields: {
      '*': { source: 'X API v2 recent search (pay-per-use)', ep: 'https://api.x.com/2/tweets/search/recent?query=${sym} -is:retweet lang:en&max_results={n}&tweet.fields=created_at,public_metrics', match: (r) => ['api.x.com/2/tweets/search/recent', encodeURIComponent('$' + r.sym)], asOf: (r) => r.t, transform: 'dedupe copy-paste openings; tone = keyword +/−; postsPerHour = sample / time span; cached X_CACHE_H (6h)', cacheTtlMs: +(process.env.X_CACHE_H || 6) * 3600e3 },
    },
    display: ['sample', 'postsPerHour', 'tone', 'engagement'],
  },
  '/api/nansen/token': {
    label: 'Nansen flows', file: 'nansen_cache.json',
    fields: {
      'flow.*': { source: 'Nansen API tgm/flow-intelligence', ep: 'https://api.nansen.ai/api/v1/tgm/flow-intelligence {chain, token_address, timeframe}', asOf: (r, d) => d.flow?.at || d.flow?.summary?.at, cache: (r, d) => (d.flow?.cached ? 'cache-hit (persistent Nansen cache, TTL 6h/24h)' : 'fresh'), transform: 'smart = smart_trader + top_pnl net flow USD; whale/exchange net flows as reported' },
      'netflow.*': { source: 'Nansen API smart-money/netflow', ep: 'https://api.nansen.ai/api/v1/smart-money/netflow {chains:[solana,ethereum,base,bnb]}', file: 'nansen_cache.json', transform: 'row for this token from top-500 24h netflow (refreshed ≤ every 12h)' },
    },
    display: ['flow.summary.smart', 'flow.summary.whale', 'netflow.net_flow_24h_usd'],
  },
  '/api/nansen/status': {
    label: 'Nansen credits', file: 'nansen_budget.json',
    fields: { creditsRemaining: { source: 'Nansen API account (0 credits) + x-nansen-credits-remaining response header', ep: 'https://api.nansen.ai/api/v1/account', match: () => ['api.nansen.ai/api/v1'], transform: 'latest header value' } },
    display: ['creditsRemaining', 'usedToday', 'usedThisMonth'],
  },
  '/api/grok': {
    label: 'Grok headline scores', file: 'grok_signals.json', rows: 'items', rowKey: ['id', 'title'], embedded: true,
    fields: { '*': { source: 'xAI chat completions (model per item = m)', ep: 'https://api.x.ai/v1/chat/completions', asOf: (r) => (typeof r.scored === 'number' ? r.scored : null) || r.at || r.scoredAt || r.ts, transform: 'structured-output score (urgency, sentiment, category, confidence) by the model named in `model` over the headline; cached by content hash (paid once)', headline: (r) => r.url || null } },
    aliases: { urgency: ['u', 'urg', 'urgency'], sentiment: ['s', 'sent', 'tone', 'sentiment'], confidence: ['f', 'conf', 'confidence'], category: ['c', 'cat', 'category'] },
    display: ['sentiment', 'urgency', 'confidence', 'category'],
  },
  '/api/alerts': {
    label: 'Alert queue', file: 'alerts.log', rows: 'recent', rowKey: ['key', 't'],
    fields: { '*': { source: 'alert generator (lib/alerts.js / lib/copytrade.js / notices)', asOf: (r) => r.t, transform: 'text built from the live-feed record / module snapshot at alert time; status = delivery (DRY RUN unless SMTP configured)', link: (r) => (r.key && /^[a-z]+:/.test(r.key) ? { path: '/api/live', row: r.key.split(':').slice(0, 2).join(':') } : null) } },
    display: ['t', 'text', 'status'],
  },
};

// file-level fallbacks: route -> [files], writer
const FILES = {
  '/api/options': [['options.json'], 'research/options.py'], '/api/airdrops': [['airdrops.json'], 'research/airdrops.py'], '/api/sleepers': [['sleepers.json'], 'research/sleepers.py'],
  '/api/narratives': [['narratives.json'], 'research/narratives.py'], '/api/agents': [['agents.json'], 'research/agents.py'], '/api/birthphase': [['birthphase'], 'research/birthphase/*.py'],
  '/api/sentiment': [['sentiment_counts.json', 'sentiment_history.json'], 'free X collector (research/sentiment)'], '/api/copytrade': [['copytrade.json', 'copytrade_events.json'], 'research/copytrade.py + lib/copytrade.js'],
  '/api/socialalt': [['socialalt.json'], 'research/socialalt.py'], '/api/seasonality': [['seasonality_live.json', 'seasonality.json'], 'research/seasonality.py'], '/api/patterns': [['patterns_hours.json', 'patterns_wallets_live.json', 'patterns_flows_live.json'], 'research/patterns_*.py'],
  '/api/bridges': [['bridges_registry.json'], 'lib/bridges.js'], '/api/derive': [['derive_snapshot.json'], 'lib/derive.js (api.derive.xyz/v3)'], '/api/devactivity': [['devactivity_map.json'], 'research/devactivity.py (GitHub API)'],
  '/api/flatbase': [['flatbase.json', 'flatbase_backtest.json'], 'lib/flatbase.js + research/flatbase_backfill.js'], '/api/accumulation': [['accumulation.json'], 'lib/accumulation.js'],   '/api/unlocks': [['unlocks.json', 'net_supply.json'], 'research/unlocks.py'], '/api/fees': [['fee_history.json'], 'lib/fees.js'], '/api/oracles': [['riskinfra_oracles.json'], 'research/riskinfra/oracles.py'],
  '/api/dependencies': [['riskinfra_dependencies.json'], 'research/riskinfra/dependencies.py'], '/api/otcflow': [['riskinfra_otcflow.json'], 'research/riskinfra/otcflow.py'], '/api/feedhealth': [['riskinfra_staleness.json'], 'lib/staleness.js'],
  '/api/riskinfra': [['riskinfra_oracles.json', 'riskinfra_dependencies.json', 'riskinfra_otcflow.json'], 'lib/oracles.js + dependencies.js + otcflow.js'],
  '/api/fakevolume': [['fakevolume_live.json'], 'lib/fakevolume.js'], '/api/vcwatch': [['vc_wallets.json', 'vcwatch_nansen.json'], 'research/vcwatch.py'], '/api/contractscan': [['contractscan.json'], 'research/contractscan.py'],
  '/api/orderbook': [['orderbook.json'], 'lib/orderbook.js (exchange L2 WS/REST)'], '/api/liquidations': [['liquidations.json'], 'lib/liquidations.js (Gate/OKX REST + WS)'], '/api/fundingdiv': [['fundingdiv.json'], 'lib/fundingdiv.js'],
  '/api/pricegaps': [['pricegaps.json', 'pricegaps_history.json'], 'lib/pricegaps.js'], '/api/desks': [['desks.json'], 'lib/desks.js'], '/api/calls': [['calls.json'], 'lib/calls.js'], '/api/reportcard': [['calls.json'], 'lib/calls.js'],
  '/api/rug/cases': [['rug_cases.json'], 'research/rugwatch.py'], '/api/crash/catalog': [['crash_catalog.json'], 'research/catalog_build.py'], '/api/airdrops/desk': [['airdrop_desk.json', 'airdrop_farms.json'], 'research/airdrops_v2.py'],
  '/api/regradar': [['regradar.json'], 'research/regradar.py'], '/api/regradar/study': [['regradar_study.json'], 'research/regradar.py'], '/api/moon/analysis': [['analysis.json'], 'research/analyze.py'], '/api/moon/screener': [['screener.json'], 'research/screener.py'],
  '/api/poolwatch': [['poolwatch.json'], 'lib/poolwatch.js'], '/api/macro': [[], 'lib/macro.js (in-memory: FRED, federalreserve.gov, Kalshi, Polymarket, RSS)'], '/api/grok/pulse': [['grok_signals.json', 'liquidations.json', 'pricegaps.json', 'fundingdiv.json'], 'lib/grok.js pulse'],
  '/api/scan': [[], 'lib/scanner.js (on-demand on-chain scan: public RPC + DexScreener + rugcheck)'], '/api/exitplan': [['live_state.json'], 'lib/exitplan.js over live record'], '/api/ohlcv': [[], 'GeckoTerminal OHLCV (cached 30s)'],
  '/api/news': [[], 'lib/macro.js RSS (cointelegraph, decrypt, coindesk, theblock, federalreserve.gov)'], '/api/discover': [[], 'DexScreener / GeckoTerminal discovery lists'], '/api/pumpfun': [[], 'pump.fun frontend API'],
};
const MEM_HOSTS = { '/api/macro': ['fred.stlouisfed.org', 'federalreserve.gov', 'kalshi.com', 'polymarket.com'], '/api/scan': ['rpc', 'dexscreener', 'rugcheck'], '/api/ohlcv': ['geckoterminal'], '/api/news': ['cointelegraph', 'decrypt', 'coindesk', 'theblock'], '/api/discover': ['dexscreener', 'geckoterminal'], '/api/pumpfun': ['pump.fun'], '/api/derive': ['derive.xyz'], '/api/orderbook': ['binance', 'okx', 'kraken', 'coinbase', 'gateio'], '/api/liquidations': ['gateio', 'okx'], '/api/pricegaps': ['binance', 'okx', 'kraken', 'coinbase', 'gateio'], '/api/fundingdiv': ['hyperliquid', 'gateio', 'binance', 'okx'] };

// UI panel inventory: [panel element id, label, route, displayed fields (for field coverage)]
const PANELS = [
  ['ccLive', 'Live alpha feed', '/api/live'], ['ccSlow', 'Slow-rug watch', '/api/live'], ['ccWatch', 'Watchlist', '/api/tokens'], ['watchPanel', 'Watchlist (main)', '/api/tokens'],
  ['ccDetail', 'Scanner detail', '/api/scan'], ['scanPanel', 'Scanner (main)', '/api/scan'], ['ccExit', 'Exit plan', '/api/exitplan'], ['chartPanel', 'Chart', '/api/ohlcv'], ['discPanel', 'Discover', '/api/discover'],
  ['ccMacro', 'Macro / Fed', '/api/macro'], ['ccOpt', 'Top options', '/api/options'], ['ccAir', 'Top airdrops', '/api/airdrops'], ['ccSleep', 'Sleepers', '/api/sleepers'], ['ccPatterns', 'Pattern detectors', '/api/patterns'],
  ['ccX', 'X mentions', '/api/x'], ['ccNansen', 'Nansen credits', '/api/nansen/status'], ['ccDesks', 'Desks', '/api/desks'], ['narrPanel', 'Narratives desk', '/api/narratives'], ['agOut', 'AI agents desk', '/api/agents'],
  ['bpOut', 'Birth-phase library', '/api/birthphase'], ['sentOut', 'Social sentiment', '/api/sentiment'], ['ctOut', 'Copy-trade watch', '/api/copytrade'], ['prioOut', 'Priority watch', '/api/priority'],
  ['zsChart', 'ZEC shielded supply', '/api/priority/shielded'], ['ccStables', 'Stablecoin issuance', '/api/stables'], ['ccSeason', 'Seasonality', '/api/seasonality'], ['gkBody', 'Grok news', '/api/grok'], ['gkPulse', 'Grok pulse', '/api/grok/pulse'],
  ['perpDesk', 'Perp desk (funding/OI)', '/api/perps'], ['perpComposite', 'Composite grades (perp desk)', '/api/composite'], ['perpFdiv', 'Funding divergence', '/api/fundingdiv'], ['perpLiq', 'Liquidations', '/api/liquidations'],
  ['perpOb', 'Order book', '/api/orderbook'], ['perpGaps', 'Price gaps', '/api/pricegaps'], ['perpUnlocks', 'Unlocks', '/api/unlocks'], ['riRoot', 'Risk infra', '/api/riskinfra'], ['rrOut', 'Regulatory radar', '/api/regradar'],
  ['dvOut', 'Derive desk', '/api/derive'], ['optOut', 'Options view', '/api/options'], ['adOut', 'Airdrop desk', '/api/airdrops/desk'], ['alertQueue', 'Alert queue', '/api/alerts'],
];
const EXCLUDED = [['taxRoot', 'Tax desk', 'private user ledger (user-entered / wallet-synced), not market data'], ['pfTable', 'Portfolio', 'user wallets (on-chain balances via RPC)'], ['swQuote', 'Swap', 'live quote at request time (Jupiter / 0x), not stored']];

// ---------------- helpers ----------------
const norm = (s) => String(s || '').toLowerCase().replace(/[ⓘ?]/g, '').replace(/\s+i$/, '').replace(/[^a-z0-9%/]+/g, ' ').trim();
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function readFileInfo(DATA_DIR, f) {
  const p = path.join(DATA_DIR, f); let st; try { st = fs.statSync(p); } catch { return { name: f, exists: false }; }
  const info = { name: 'data/' + f, exists: true, mtime: st.mtimeMs, mtimeIso: iso(st.mtimeMs), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000), size: st.size };
  if (st.isFile() && f.endsWith('.json') && st.size < 40 * 1048576) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const g = d.generatedAt ?? d.generated_at ?? d.updatedAt ?? d.savedAt; if (g != null) { info.generatedAt = toMs(g); info.generatedAtIso = iso(toMs(g)); }
      for (const k of ['sources', 'source', 'src', 'method', 'priceSource', 'rv_sources', 'flow_sources']) if (d[k] != null) info[k] = summarize(d[k]);
    } catch { /* big or mid-write: mtime only */ }
  }
  return info;
}
function safeJsonSnippet(v) { try { const s = JSON.stringify(v); return s.length > 1500 ? s.slice(0, 1500) + '…' : v; } catch { return null; } }
function summarize(v) { if (typeof v === 'string') return v.slice(0, 600); try { const s = JSON.stringify(v); return s.length > 600 ? s.slice(0, 600) + '…' : v; } catch { return null; } }
// find a row in data by key: surface rows path, else deep search arrays/maps up to depth 4
function findRow(data, spec, row) {
  if (row == null || row === '') return null;
  const want = String(row).toLowerCase();
  if (String(row).includes('.')) { const v = getPath(data, String(row)); if (v && typeof v === 'object') return { row: v, at: String(row) }; }
  const keys = spec?.rowKey || ['key', 'sym', 'symbol', 'address', 'id', 'pair', 'name', 'title'];
  const hit = (o) => o && typeof o === 'object' && keys.some((k) => o[k] != null && String(o[k]).toLowerCase() === want);
  if (spec?.rows && spec.rows !== '*') {
    const arr = getPath(data, spec.rows);
    if (Array.isArray(arr)) { const i = arr.findIndex(hit); if (i >= 0) return { row: arr[i], at: `${spec.rows}[${i}]` }; }
    else if (arr && typeof arr === 'object') { for (const [k, v] of Object.entries(arr)) if (k.toLowerCase() === want || hit(v)) return { row: v, at: spec.rows + '.' + k }; }
  }
  const seen = new Set();
  const walk = (o, p, depth) => {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return null; seen.add(o);
    if (Array.isArray(o)) { for (let i = 0; i < Math.min(o.length, 2000); i++) { if (hit(o[i])) return { row: o[i], at: `${p}[${i}]` }; } for (let i = 0; i < Math.min(o.length, 300); i++) { const r = walk(o[i], `${p}[${i}]`, depth + 1); if (r) return r; } return null; }
    for (const [k, v] of Object.entries(o)) { if (k.toLowerCase() === want && v && typeof v === 'object') return { row: v, at: p ? `${p}.${k}` : k }; }
    for (const [k, v] of Object.entries(o)) { if (k === '_prov') continue; const r = walk(v, p ? `${p}.${k}` : k, depth + 1); if (r) return r; }
    return null;
  };
  return walk(data, '', 0);
}
function matchField(row, spec, field) {
  if (!field) return null;
  const f = String(field); const nf = norm(f);
  if (row && f.includes('.') && getPath(row, f) !== undefined) return f;
  if (spec?.aliases) for (const [k, al] of Object.entries(spec.aliases)) if (al.some((a) => norm(a) === nf) || norm(k) === nf) return k;
  if (row && typeof row === 'object') {
    for (const k of Object.keys(row)) if (norm(k) === nf) return k;
    for (const k of Object.keys(row)) if (nf.length >= 3 && norm(k).startsWith(nf)) return k;
    // composite factor label / key
    if (Array.isArray(row.factors)) { const fx = row.factors.find((x) => norm(x.key) === nf || norm(x.label) === nf || (nf.length > 2 && norm(x.label).includes(nf))); if (fx) return 'factors:' + fx.key; }
  }
  return f;
}
const EMB_SRC = ['src', 'source', 'sources', 'zSrc', 'oiChSrc', 'priceSource', 'venue', 'route', 'publisher', 'm', 'model'];
const EMB_TIME = ['updated', 'updatedAt', 'asof', 'asOf', 'as_of', 'at', 't', 'ts', 'time', 'publishedAt', 'scannedAt', 'fetchedAt', 'last_ts', 'totalSupply_at', 'date', 'generatedAt'];
const EMB_CHAIN = ['block', 'blockNumber', 'block_number', 'height', 'slot', 'first', 'last', 'tx', 'txHash', 'tx_hash', 'signature', 'hash', 'chain', 'chainId', 'pairAddress', 'contract', 'addr', 'address'];
function embeddedOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const e = {};
  for (const k of EMB_SRC) if (o[k] != null && (typeof o[k] === 'string' || Array.isArray(o[k]))) e[k] = Array.isArray(o[k]) ? o[k].slice(0, 6).map((x) => (typeof x === 'string' ? x.slice(0, 160) : x?.name || x?.url || x?.src || JSON.stringify(x).slice(0, 120))) : String(o[k]).slice(0, 240);
  for (const k of EMB_TIME) if (o[k] != null && (typeof o[k] === 'number' || typeof o[k] === 'string')) { const ms = toMs(o[k]); if (ms && ms > 1.2e12 && ms < Date.now() + 864e5 * 400) e[k] = iso(ms); else if (k === 'date') e[k] = String(o[k]); }
  for (const k of EMB_CHAIN) if (o[k] != null && (typeof o[k] === 'number' || typeof o[k] === 'string')) e[k] = typeof o[k] === 'string' ? o[k].slice(0, 100) : o[k];
  return Object.keys(e).length ? e : null;
}
// walk from root to the target (row path + field path) collecting embedded provenance at each level (nearest wins)
function embeddedChain(data, rowAt, fieldPath) {
  const levels = [];
  const add = (label, o) => { const e = embeddedOf(o); if (e) levels.push({ where: label || '(root)', ...e }); };
  add('', data);
  let cur = data, p = '';
  const steps = (rowAt || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  for (const s of steps) { cur = cur?.[s]; p = p ? p + '.' + s : s; if (cur && typeof cur === 'object') add(p, cur); }
  if (fieldPath && cur) { const fs2 = fieldPath.split('.').slice(0, -1); for (const s of fs2) { cur = cur?.[s]; p += '.' + s; if (cur && typeof cur === 'object' && !Array.isArray(cur)) add(p, cur); } }
  return levels.reverse();
}
const fill = (tpl, r) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (r && r[k] != null ? String(r[k]) : m));
function cacheState(asOf, fetch, ttl) {
  if (!fetch) return { state: 'unknown', detail: 'no matching upstream request in this server process (fetched before restart, by another process, or served from a persistent cache file)' };
  if (!asOf) return { state: fetch.ok ? 'fetched' : 'error', detail: `last upstream request ${iso(fetch.at)} (HTTP ${fetch.status})` };
  const d = asOf - fetch.at;
  if (d >= -1000 && d < 3000) return { state: 'fresh', detail: `value captured ${Math.max(0, Math.round(d / 1000))}s after the upstream response` };
  if (d >= 3000) return { state: 'cache-hit', detail: `value captured from a response cached ${Math.round(d / 1000)}s earlier${ttl ? ` (TTL ${Math.round(ttl / 1000)}s)` : ''}` };
  return { state: 'refetched-since', detail: `a newer upstream response exists (${Math.round(-d / 1000)}s later); this row still shows the earlier capture until its next refresh` };
}

// ---------------- route-level _prov (attached to API responses) ----------------
function describe(route, data, DATA_DIR) {
  const s = SURFACES[route], fl = FILES[route];
  const out = { v: 1, route, servedAt: Date.now() };
  if (s) {
    out.level = 'field'; out.label = s.label;
    const a = s.asOf ? s.asOf(data) : null; if (a) out.asOf = iso(toMs(a));
    out.fields = Object.fromEntries(Object.entries(s.fields || {}).map(([k, f]) => [k, { source: f.source, endpoint: f.ep || (f.venues ? 'per-venue (see /api/provenance)' : undefined), transform: f.transform }]));
    if (s.factors) out.factors = Object.fromEntries(Object.entries(FACTOR_SRC).map(([k, f]) => [k, { source: f.source, files: f.files, transform: f.transform }]));
    if (s.file) { const fi = readFileInfoLite(DATA_DIR, s.file); if (fi) out.file = fi; }
  } else if (fl) {
    out.level = 'file'; out.writer = fl[1];
    out.files = fl[0].map((f) => readFileInfoLite(DATA_DIR, f)).filter(Boolean);
    const g = data && (data.generatedAt ?? data.generated_at); if (g) out.asOf = iso(toMs(g));
    if (MEM_HOSTS[route]) out.upstream = prov.hosts().filter((h) => MEM_HOSTS[route].some((x) => h.host.includes(x))).slice(0, 8).map((h) => ({ host: h.host, lastOkAt: iso(h.lastOkAt), requests: h.requests, fails: h.fails }));
  } else {
    out.level = 'none';
    const g = data && (data.generatedAt ?? data.generated_at); if (g) { out.asOf = iso(toMs(g)); out.level = 'file'; out.note = 'response carries generatedAt only (no source map yet)'; }
  }
  out.lookup = `/api/provenance?path=${encodeURIComponent(route)}&field=<field>&row=<row key>`;
  return out;
}
function readFileInfoLite(DATA_DIR, f) { // stat only (cheap, called on every response)
  try { const st = fs.statSync(path.join(DATA_DIR, f)); return { name: 'data/' + f, mtime: iso(st.mtimeMs), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) }; } catch { return null; }
}

// ---------------- field resolver ----------------
async function resolve({ route, field, row, data, DATA_DIR, extra = {} }) {
  const s = SURFACES[route], fl = FILES[route];
  const res = { path: route, field: field || null, row: row || null, resolvedAt: iso(Date.now()), level: 'none' };
  const found = row ? findRow(data, s, row) : null;
  const R = found?.row || null;
  if (row && !R) res.warning = 'row not found in the current response; showing route-level provenance';
  if (found) res.rowPath = found.at;
  let fk = matchField(R || data, s, field);
  res.fieldKey = fk;
  let value;
  if (fk && fk.startsWith('factors:')) value = (R?.factors || []).find((x) => x.key === fk.slice(8));
  else if (fk) value = getPath(R || data, fk);
  if (value !== undefined) res.value = typeof value === 'object' ? safeJsonSnippet(value) : value;
  const routeAsOf = s?.asOf ? toMs(s.asOf(data)) : toMs(data?.generatedAt);
  if (routeAsOf) res.responseAsOf = iso(routeAsOf);

  // 1) explicit spec
  let f = null;
  if (s && fk) {
    f = s.fields?.[fk] || null;
    if (!f) { const wk = Object.keys(s.fields || {}).find((k) => k.endsWith('.*') && fk.startsWith(k.slice(0, -2))); if (wk) f = s.fields[wk]; }
    if (!f && s.fields?.['*'] && R) f = s.fields['*'];
  }
  if (s?.factors && fk && fk.startsWith('factors:')) {
    const k = fk.slice(8), F = FACTOR_SRC[k];
    if (F) {
      res.level = 'field'; res.source = F.source; res.transform = F.transform; res.factor = { key: k, label: value?.label, score: value?.score, weight: value?.weight, adj: value?.adj, value: value?.value, explain: value?.explain ? String(value.explain).slice(0, 400) : undefined };
      res.files = (F.files || []).map((x) => readFileInfo(DATA_DIR, x)).filter((x) => x.exists).map(({ name, mtimeIso, ageSec, generatedAtIso }) => ({ name, mtime: mtimeIso, ageSec, generatedAt: generatedAtIso }));
      if (F.mem && extra.mem?.[F.mem]) { let m = null; try { m = extra.mem[F.mem](); } catch {} if (m) res.memorySnapshot = { module: F.mem, asOf: iso(toMs(m)) }; }
      const times = [...(res.files || []).map((x) => Date.parse(x.generatedAt || x.mtime)), res.memorySnapshot ? Date.parse(res.memorySnapshot.asOf) : null].filter(Boolean);
      if (times.length) { res.asOf = iso(Math.min(...times)); res.ageSec = Math.round((Date.now() - Math.min(...times)) / 1000); res.asOfNote = 'oldest input of this factor'; }
      res.computedAt = iso(routeAsOf);
      return res;
    }
  }
  if (f) {
    res.level = 'field'; res.source = f.source; res.transform = f.transform;
    const venuesPath = f.venues === true ? 'venues' : typeof f.venues === 'string' ? f.venues.replace(/^perps\./, 'perps.') : null;
    if (venuesPath && R) {
      const vs = getPath(R, venuesPath) || [];
      const vmeta = data?.venues || {};
      res.venues = (Array.isArray(vs) ? vs : []).slice(0, 8).map((v) => {
        const fe = prov.lastFetch([VENUE_HOST[v.venue] || v.venue]);
        const vm = vmeta[v.venue] || {};
        const fetchedAt = vm.at || fe?.at || null;
        const sub = {}; for (const k of ['fAnn', 'fAnnPct', 'rate', 'intervalH', 'oiUsd', 'oiCh24Pct', 'oiChSrc', 'mark', 'index', 'vol24Usd', 'nextFunding']) if (v[k] != null) sub[k] = v[k];
        return { venue: v.venue, contract: v.contract, endpoint: VENUE_EP[v.venue] || v.venue, route: vm.route || null, fetchedAt: iso(fetchedAt), ageSec: fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null, venueOk: vm.ok, lastRequest: fe ? { url: fe.url, status: fe.status, at: iso(fe.at) } : null, ...sub };
      });
      res.endpoint = 'per-venue (see venues[])';
      const ts = res.venues.map((v) => Date.parse(v.fetchedAt)).filter(Boolean);
      const a = routeAsOf || (ts.length ? Math.max(...ts) : null);
      if (a) { res.asOf = iso(a); res.ageSec = Math.round((Date.now() - a) / 1000); }
      res.cache = { state: 'snapshot', detail: 'value from the in-memory perp snapshot (venues polled every ~2 min); per-venue fetch times listed' };
    } else {
      if (f.ep) res.endpoint = fill(f.ep, R || {});
      if (f.chain && R) res.chain = f.chain(R, data) || undefined;
      if (f.pair && R) res.pairAddress = f.pair(R, data) || undefined;
      const a = f.asOf ? toMs(f.asOf(R || {}, data)) : routeAsOf;
      if (a) { res.asOf = iso(a); res.ageSec = Math.round((Date.now() - a) / 1000); }
      const fe = f.match && R ? prov.lastFetch(f.match(R, data)) : null;
      if (fe) { res.fetch = { url: fe.url, status: fe.status, at: iso(fe.at), ms: fe.ms, requests: fe.n }; res.fetchedAt = iso(fe.at); }
      res.cache = f.cache ? { state: f.cache(R || {}, data) } : f.match ? cacheState(a, fe, f.cacheTtlMs) : /^derived/.test(f.source) ? { state: 'derived', detail: 'computed in-process from the inputs listed' } : s?.file ? { state: 'file', detail: `served from data/${s.file} (written by its research/module job)` } : { state: 'unknown' };
      if (f.link && R) { const l = f.link(R, data); if (l) res.traceTo = l; }
      if (f.headline && R) { const h = f.headline(R); if (h) res.headlineUrl = h; }
      if (f.file) { const fi = readFileInfo(DATA_DIR, f.file); if (fi.exists) res.file = { name: fi.name, mtime: fi.mtimeIso, ageSec: fi.ageSec }; }
      if (f.inputs) res.inputs = f.inputs;
    }
  }
  // 2) stables special-case: on-chain block ranges / DefiLlama
  if (s?.stables) {
    const at = res.rowPath || '';
    const m = at.match(/^(onchain|pairs|chains)\.([^.]+)/) || String(field || '').match(/^(onchain|pairs|chains)\.([^.]+)/);
    if (m) {
      const kind = m[1], key = m[2];
      if (kind === 'onchain') {
        let oc = null; try { oc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stables_onchain.json'), 'utf8'))[key]; } catch {}
        const d = data?.onchain?.[key] || oc || {};
        const chain = key.split(':')[0];
        res.level = 'field'; res.source = `on-chain ${chain} token events (mint = Transfer from 0x0, burn = Transfer to 0x0)`; res.chain = chain; res.contract = d.addr || oc?.addr;
        res.endpoint = STABLE_RPC[chain] || 'public RPC';
        if (oc) { res.blockRange = { from: oc.first, to: oc.last, fromTime: iso(toMs(oc.first_ts)), toTime: iso(toMs(oc.last_ts)) }; res.block = oc.last; }
        const a = toMs(d.last_ts || oc?.last_ts); if (a) { res.asOf = iso(a); res.ageSec = Math.round((Date.now() - a) / 1000); }
        if (d.totalSupply_at) res.totalSupplyAt = iso(toMs(d.totalSupply_at));
        res.reconcile = d.reconcile || undefined;
        res.transform = 'hourly buckets of decoded Transfer events, summed over rolling windows to scan time; reconcile = supply delta vs events net';
        res.cache = { state: 'file', detail: 'research/stables.py output (data/stables.json + hourly cache data/stables_onchain.json), refreshed ~6h' };
      } else {
        const d = (kind === 'chains' ? data?.chains : data?.pairs)?.[key] || {};
        res.level = 'field'; res.source = 'DefiLlama stablecoins API'; res.endpoint = kind === 'chains' ? `https://stablecoins.llama.fi/stablecoincharts/${key}?stablecoin={id} (per coin: ${(d.coins || []).join(', ')})` : `https://stablecoins.llama.fi/stablecoincharts/${key.split(':')[0]}?stablecoin={id for ${key.split(':')[1]}}`;
        res.chain = key.split(':')[0];
        if (d.asof) { res.asOf = d.asof + 'T00:00:00Z'; res.ageSec = Math.round((Date.now() - Date.parse(res.asOf)) / 1000); }
        res.transform = 'day-over-day change in totalCirculating (USD) per chain per coin; DefiLlama snapshot at ~00:00 UTC; velocity = 7d net / supply';
        res.cache = { state: 'file', detail: 'research/stables.py output, refreshed ~6h' };
      }
    } else if (!res.source) { res.level = 'field'; res.source = 'DefiLlama stablecoins API + public RPC token events'; res.note = 'pass row=onchain.<chain:COIN> or row=chains.<chain> (or field=onchain.base:USDC.windows.24h.net) for block-level detail'; }
  }
  // 3) embedded provenance in the data itself
  const emb = embeddedChain(data, found?.at, fk && !fk.startsWith('factors:') ? fk : null);
  if (emb.length) {
    res.embedded = emb.slice(0, 4);
    const nearest = emb[0];
    const rowLevel = found && nearest.where !== '(root)';
    if (res.level === 'none' && rowLevel && (EMB_SRC.some((k) => nearest[k]) || EMB_CHAIN.some((k) => ['block', 'height', 'blockNumber', 'tx', 'txHash', 'signature', 'slot'].includes(k) && nearest[k] != null))) {
      res.level = 'field-embedded'; res.source = res.source || EMB_SRC.map((k) => nearest[k]).find(Boolean);
    }
    if (!res.asOf) { const tk = EMB_TIME.find((k) => nearest[k] && k !== 'date'); if (tk) { res.asOf = nearest[tk]; res.ageSec = Math.round((Date.now() - Date.parse(nearest[tk])) / 1000); res.asOfFrom = `${nearest.where}.${tk}`; } }
    if (res.block == null) { const bk = ['block', 'blockNumber', 'block_number', 'height', 'slot'].find((k) => nearest[k] != null); if (bk) res.block = nearest[bk]; }
    if (!res.tx) { const tk = ['tx', 'txHash', 'tx_hash', 'signature'].find((k) => nearest[k] != null); if (tk) res.tx = nearest[tk]; }
  }
  // 4) file-level fallback
  const files = s?.file ? [s.file] : fl ? fl[0] : [];
  if (files.length) {
    res.files = files.map((x) => readFileInfo(DATA_DIR, x)).filter((x) => x.exists).map(({ name, mtimeIso, ageSec, generatedAtIso, sources, source, src, method }) => ({ name, mtime: mtimeIso, ageSec, generatedAt: generatedAtIso, declaredSources: sources || source || src || undefined, method: method || undefined }));
    if (fl) res.writer = fl[1];
    if (res.level === 'none') {
      res.level = 'file'; res.source = res.source || (fl ? fl[1] : s?.label);
      const g = res.files[0]; if (!res.asOf && g) { res.asOf = g.generatedAt || g.mtime; res.ageSec = g.ageSec; res.asOfFrom = g.generatedAt ? 'file generatedAt' : 'file mtime'; }
      res.cache = { state: 'file', detail: 'served from the data file written by ' + (fl ? fl[1] : 'its module') };
    }
  }
  if (MEM_HOSTS[route]) {
    res.upstream = prov.hosts().filter((h) => MEM_HOSTS[route].some((x) => h.host.includes(x))).slice(0, 8).map((h) => ({ host: h.host, lastOkAt: iso(h.lastOkAt), requests: h.requests, fails: h.fails }));
    if (res.level === 'none' && res.upstream.length) { res.level = 'file'; res.source = fl ? fl[1] : 'in-memory module'; res.note = 'route-level: upstream hosts + last successful request time (in-memory snapshot, no data file)'; const t = Math.max(...res.upstream.map((u) => Date.parse(u.lastOkAt) || 0)); if (t && !res.asOf) { res.asOf = iso(t); res.ageSec = Math.round((Date.now() - t) / 1000); } }
  }
  if (!res.asOf && routeAsOf) { res.asOf = iso(routeAsOf); res.ageSec = Math.round((Date.now() - routeAsOf) / 1000); res.asOfFrom = 'response generatedAt'; }
  return res;
}

// ---------------- coverage (static: map + data files; does not call routes) ----------------
function coverage(DATA_DIR) {
  const panels = PANELS.map(([id, label, route]) => {
    const s = SURFACES[route];
    let level = s ? 'field' : FILES[route] ? 'file' : 'none';
    let fields = null;
    if (s) {
      const disp = s.display || [];
      const mapped = disp.filter((d) => d === '<factors>' || s.fields?.[d] || s.fields?.['*'] || s.stables || Object.keys(s.fields || {}).some((k) => k.endsWith('.*') && d.startsWith(k.slice(0, -2))) || s.embedded);
      fields = { displayed: disp.length, fieldLevel: mapped.length };
    } else if (FILES[route]) {
      // upgrade to field-embedded when rows of the data file carry their own src/venue/time fields
      for (const f of FILES[route][0]) {
        try {
          const p = path.join(DATA_DIR, f); const st = fs.statSync(p); if (!st.isFile() || st.size > 30 * 1048576) continue;
          const d = JSON.parse(fs.readFileSync(p, 'utf8'));
          const arrs = Object.values(d).filter((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
          if (arrs.some((a) => { const e = embeddedOf(a[0]); return e && EMB_SRC.some((k) => e[k]); })) { level = 'field-embedded'; break; }
        } catch {}
      }
    }
    return { id, label, route, level, fields };
  });
  const n = panels.length, c = (l) => panels.filter((p) => p.level === l).length;
  const pct = (x) => Math.round((x / n) * 1000) / 10;
  const fl = panels.filter((p) => p.fields); const disp = fl.reduce((a, p) => a + p.fields.displayed, 0), mapped = fl.reduce((a, p) => a + p.fields.fieldLevel, 0);
  return {
    generatedAt: iso(Date.now()), panels: n,
    summary: { field: c('field'), fieldEmbedded: c('field-embedded'), file: c('file'), none: c('none'), pct: { field: pct(c('field')), fieldEmbedded: pct(c('field-embedded')), file: pct(c('file')), none: pct(c('none')) } },
    keyPanelFields: { displayed: disp, fieldLevel: mapped, pct: disp ? Math.round((mapped / disp) * 1000) / 10 : null },
    detail: panels, excluded: EXCLUDED.map(([id, label, why]) => ({ id, label, why })),
    definitions: { field: 'explicit per-field spec: upstream endpoint, chain/pair or venue, per-row as-of, fetch-registry match (cache hit vs fresh), transform', 'field-embedded': 'data rows carry their own src/venue/time fields (written by the research script); resolver reads them', file: 'data file (mtime, generatedAt, declared sources/method) or in-memory snapshot time + upstream hosts only', none: 'no provenance' },
  };
}

module.exports = { SURFACES, FILES, PANELS, FACTOR_SRC, describe, resolve, coverage, findRow, embeddedOf };
