'use strict';
// PATTERN LAB: 37 crash/pump patterns, each with a backtest on the 50-token detector test set (30 crashed + 20 runners; both directions),
// a live flag, a plain-English explanation, and a small documented composite weight. Read-only, no network calls from the server
// except spawning the FREE live scanner (research/patternlab/pl_live.py, no Nansen) when data/patternlab_live.json is stale.
// Inputs: data/patternlab_backtest.json (research/patternlab/pl_backtest.py), data/patternlab_live.json (pl_live.py), and the outputs of
// existing modules it WRAPS rather than rebuilds: contractscan.json (mint/freeze/owner/code), fakevolume_live.json, copytrade_events.json,
// sandwich_log.json (lib/mev.js), unlocks_calendar.json (lib/unlocks.js), riskinfra_dependencies.json (stables/hacks), fee_history.json
// (lib/fees.js), liquidations.json, riskinfra_oracles.json (incl. TWAP), seasonality_live.json, perps.json, fundingdiv.json, vcwatch_live.json,
// patterns_wallets_live.json (pattern-detector worker, fresh-wallet clusters), nansen_cache.json (flow-intelligence, free re-read).
// Model estimates from public data. Not financial advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// status: built = new detector here; wrapped = existing module result re-used as a per-pattern flag; partial = some legs missing; nf = not feasible
// w = composite adjustment (points on the 0-100 composite score) when the pattern fires for a token; cap = hard grade cap.
// Weights were set AFTER the backtest (PATTERN_LAB.md): only patterns with a measured edge (or hard safety facts) move the grade, and only a little.
const P = [
  { id: 1, name: 'Coordinated smart-money exits', group: 'flows', prio: true, status: 'built', w: 0, dir: 'crash', reuse: 'Nansen tgm/dex-trades (only_smart_money) + labels', explain: 'Two or more wallets that Nansen labels "smart money" sell the same token within one hour. When the best traders leave together, late buyers are usually the exit liquidity. In our test set smart money was mostly present in runners (it trades the winners), so a clustered SM sale is shown as a warning but is NOT weighted down.' },
  { id: 2, name: 'Smart money accumulating (incl. dead tokens)', group: 'flows', status: 'built', w: 0, dir: 'pump', reuse: 'Nansen dex-trades + flow-intelligence cache', explain: 'At least two smart-money wallets are net buyers. On a token that already crashed this can mean they expect a revival; on a fresh token it is early interest. Informational only until it shows an edge.' },
  { id: 3, name: 'Dev funded by mixer / sanctioned / fresh / serial funder', group: 'insider', status: 'built', w: 0, dir: 'crash', reuse: 'public RPC first-funder + OFAC SDN list', explain: 'Who paid for the deployer wallet? A brand-new wallet, a sanctioned (OFAC) address, or a funder that also funded other launches points to throwaway or serial rug operators. Backtest: it fired MORE in runners (13/20) than crashes (10/30), so it carries no weight; sanctioned-funder hits are still shown.' },
  { id: 4, name: 'Mint authority live (HARD)', group: 'contract', prio: true, status: 'wrapped', w: -6, cap: 'D', dir: 'crash', reuse: 'lib/contractscan.js + RPC getMultipleAccounts', explain: 'The issuer can still print unlimited new tokens. Your share can be diluted to nothing at any moment, so the grade is capped at D no matter how good everything else looks (issuer-backed stablecoins excepted).' },
  { id: 5, name: 'Freeze authority live (HARD)', group: 'contract', prio: true, status: 'wrapped', w: -6, cap: 'D', dir: 'crash', reuse: 'lib/contractscan.js + RPC getMultipleAccounts', explain: 'The issuer can freeze any wallet so it cannot sell. That is the core of a Solana honeypot. Grade capped at D (issuer-backed stablecoins excepted).' },
  { id: 6, name: 'Ownership / metadata not renounced', group: 'contract', status: 'wrapped', w: -1, dir: 'crash', reuse: 'lib/contractscan.js (EVM owner) + RugCheck mutable metadata', explain: 'Someone still controls the contract (EVM owner) or can change the token name/logo/links (Solana mutable metadata). Not fatal by itself but it keeps a door open for changes after you buy.' },
  { id: 7, name: 'Sniper / MEV-bot volume (clean volume)', group: 'tape', prio: true, status: 'built', w: 0, dir: 'crash', reuse: 'lib/fakevolume.js + Nansen/GT tape', explain: 'How much of the trading is real? We strip wallets that bought in the first seconds (snipers), MEV-bot-labelled wallets and fake/self-trades. If less than half the volume is "clean", the chart is mostly bots. On pump.fun this fires on almost every launch, so it is a context number, not a grade mover.' },
  { id: 8, name: 'Sandwich attacks on big buys', group: 'tape', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/mev.js sandwich log + tape heuristic', explain: 'A bot buys right before a large buy and sells right after it, skimming the buyer. Frequent sandwiches mean the pool is being farmed by MEV bots; use tight slippage.' },
  { id: 9, name: 'Social: shills only after the pump', group: 'social', status: 'partial', w: 0, dir: 'crash', reuse: 'DexScreener profile/boost timing (no paid X reads)', explain: 'Paid promotion (DexScreener profile, boosts) shows up only after the price already ran. That is marketing to exit, not to build. Repeat-shiller accounts and deleted accounts need paid X post reads, which we do not use.' },
  { id: 10, name: 'Liquidity concentrated in 1-2 pools', group: 'liquidity', status: 'built', w: -1, dir: 'crash', reuse: 'RugCheck markets', explain: 'All the liquidity sits in one or two pools, so one LP withdrawal empties the market. Every launchpad token starts like this; it matters more for older tokens. Backtest: 30/30 crashes vs 9/20 runners (p<0.001), so a small -1.' },
  { id: 11, name: 'Fake volume then LP pull', group: 'tape', status: 'wrapped', w: -1, dir: 'crash', reuse: 'lib/fakevolume.js + pattern-detector LP-pull output', explain: 'Wash trading inflates the volume to attract buyers, then the liquidity is pulled. We flag the fake-volume leg live and join the liquidity-pull leg from the pattern-detector worker when it has data.' },
  { id: 12, name: 'Wash trading across same-entity wallets', group: 'tape', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/fakevolume.js rings/self-trades', explain: 'Groups of wallets pass the same amount back and forth (rings) or one wallet buys and sells to itself. Volume that is not real demand.' },
  { id: 13, name: 'Copy-trading clusters', group: 'tape', status: 'built', w: -1, dir: 'crash', reuse: 'tape heuristic + lib/copytrade.js events', explain: 'Several wallets copy one source wallet within seconds, entering and exiting together. When the source sells, the cluster dumps at once.' },
  { id: 14, name: 'Vesting cliff / unlock near the price peak', group: 'supply', prio: true, status: 'partial', w: 0, dir: 'crash', reuse: 'lib/unlocks.js (already a composite factor with caps)', explain: 'A large block of insider/VC tokens unlocks soon while price is high. Holders who got tokens cheap often sell into strength. The live flag comes from the unlock calendar; the historical backtest is impossible with free data (historical unlock schedules are paywalled). lib/unlocks.js already adjusts and caps grades, so no extra weight here.' },
  { id: 15, name: 'Cross-token links (shared dev/VC/community wallets)', group: 'insider', status: 'built', w: 0, dir: 'crash', reuse: 'research-DB holder overlap + vcwatch', explain: 'The same wallets keep showing up as top holders or funders across many tokens: a network that launches, pumps and dumps repeatedly.' },
  { id: 16, name: 'Stablecoin depeg (macro warning)', group: 'macro', status: 'wrapped', w: -1, market: true, dir: 'crash', reuse: 'lib/stables.js / riskinfra dependencies + CoinGecko', explain: 'A major stablecoin trading below $0.997. Depegs drain liquidity from everything and historically come with sharp crypto-wide drops. Never occurred in the backtest window; -1 is a documented prior, not a measured edge.' },
  { id: 17, name: 'Gas / priority-fee spike', group: 'macro', status: 'wrapped', w: 0, market: true, dir: 'info', reuse: 'lib/fees.js', explain: 'Network fees far above normal: congestion, failed transactions, worse fills. Informational (no free history to backtest).' },
  { id: 18, name: 'Perp liquidation cascade spilling to spot', group: 'macro', status: 'wrapped', w: 0, market: true, dir: 'crash', reuse: 'lib/liquidations.js', explain: 'Leveraged positions are being force-closed in a chain reaction; spot usually follows. Already a composite factor for perps; shown here for context.' },
  { id: 19, name: 'Oracle manipulation flags', group: 'defi', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/oracles.js', explain: 'A price oracle disagrees with real markets or is stale, or a thin pool backs lending collateral. That is the setup for oracle-manipulation exploits.' },
  { id: 20, name: 'Flash-loan patterns', group: 'defi', status: 'partial', w: 0, dir: 'crash', reuse: 'riskinfra hacks feed + early-tx program scan', explain: 'A flash loan borrows huge sums inside one transaction, often to manipulate a price or exploit a bug. We scan early trades for flash-loan programs and recent hacks for flash-loan technique.' },
  { id: 21, name: 'Reentrancy / access-control heuristics (EVM)', group: 'contract', status: 'partial', w: 0, dir: 'crash', reuse: 'lib/contractscan.js analyzeCode + flags', explain: 'Code patterns that commonly lead to exploits: unguarded external calls, delegatecall/selfdestruct, tx.origin auth, owner-only switches. Heuristic, not an audit.' },
  { id: 22, name: 'Mempool front-running', group: 'tape', status: 'built', w: 0, dir: 'crash', reuse: 'tape heuristic', explain: 'Someone buys just before large buys and sells shortly after. Similar to sandwiches with a longer exit window.' },
  { id: 23, name: 'Jito bundles / block-builder games', group: 'tape', status: 'partial', w: 0, dir: 'crash', reuse: 'RPC tx parse (Jito tip accounts)', explain: 'Launch buys packed into Jito bundles (paid tips, same slot) usually mean the dev or a sniper team bought supply before anyone else could. Backtest only (needs per-tx parsing); not scanned live yet.' },
  { id: 24, name: 'TWAP manipulation', group: 'defi', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/oracles.js TWAP checks', explain: 'Spot price pulled far away from its time-weighted average in a thin pool, the trick used to fool TWAP oracles.' },
  { id: 25, name: 'Exchange halts / deposit-withdrawal suspensions', group: 'macro', status: 'wrapped', w: 0, dir: 'info', reuse: 'regradar + priority news headlines', explain: 'An exchange paused deposits or withdrawals for a token or network. Information: arbitrage breaks and prices can disconnect between venues.' },
  { id: 26, name: 'Pump-and-dump phase (accumulation → markup → distribution → markdown)', group: 'chart', status: 'built', w: 0, dir: 'both', reuse: 'GT 5-min OHLCV / tape bars', explain: 'Classifies the recent chart: quiet range with rising volume (accumulation, early-entry), strong rise (markup), stalling near the top on fading volume (distribution), or falling from the top (markdown).' },
  { id: 27, name: 'Seasonality (weekend, month-end, options expiry, CME closed, holidays)', group: 'macro', status: 'wrapped', w: 0, market: true, dir: 'info', reuse: 'lib/seasonality.js session panel + calendar features', explain: 'Calendar effects beyond the session panel: weekends (thin books, CME closed), month-end, last-Friday options expiry, US holidays.' },
  { id: 28, name: 'BTC/ETH beta regime', group: 'macro', status: 'built', w: 0, market: true, dir: 'crash', reuse: 'Binance public klines', explain: 'BTC down 5%+ in a week = risk-off; most alts and memes fall harder than BTC in that regime.' },
  { id: 29, name: 'Alt-season indicators (breadth, ETH/BTC)', group: 'macro', status: 'built', w: 0, market: true, dir: 'both', reuse: 'Binance public klines (BTC dominance history is not free; breadth used instead)', explain: 'Share of 28 large alts beating BTC over 30 days plus ETH/BTC trend. Below 25% = BTC season (alts bleed), above 75% = alt season.' },
  { id: 30, name: 'Extreme positive perp funding', group: 'perps', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/perps.js + lib/fundingdiv.js (already composite factors)', explain: 'Longs pay a lot to stay leveraged: crowded and fragile. Already weighted in the composite via the perp/funding factors, so no double counting here.' },
  { id: 31, name: 'OI spike with flat price', group: 'perps', status: 'wrapped', w: 0, dir: 'crash', reuse: 'lib/perps.js', explain: 'Open interest jumps 20%+ in a day while price barely moves: leverage is piling in on both sides, so the next move is usually violent.' },
  { id: 32, name: 'Top-10 share shrinking while price climbs (distribution)', group: 'rules', status: 'built', w: 0, dir: 'crash', reuse: 'tape-rebuilt balances', explain: 'Price goes up but the biggest wallets hold less and less: they are selling into the rally. Classic distribution.' },
  { id: 33, name: 'First 100 buyers mostly fresh wallets from one funder', group: 'rules', status: 'built', w: 0, dir: 'crash', reuse: 'RPC first-funder + pattern-detector fresh-wallet clusters', explain: 'Most early buyers are brand-new wallets paid by the same source: one team pretending to be a crowd (coordinated entry). Backtest: fired on only 1 of 30 crashes, no edge yet, so weight 0.' },
  { id: 34, name: 'Absorption (volume spike, price flat) + side', group: 'rules', status: 'built', w: 0, dir: 'both', reuse: 'tape / 5-min bars', explain: 'A burst of volume that does not move the price: someone big is soaking up the other side. If buys dominate but price is flat, sellers are absorbing (bearish). If sells dominate but price holds, buyers are absorbing (bullish).' },
  { id: 35, name: 'Liquidity / market-cap below floor (rug risk)', group: 'rules', status: 'built', w: 0, dir: 'crash', reuse: 'live feed liq/fdv; floor calibrated on calls.json', explain: 'Too little liquidity behind the market cap. A small sale crashes the price and pulling liquidity is cheap. The floor is calibrated from 3,800 past live-feed calls. Calibration result: below every candidate floor tokens rugged LESS often (8% vs 21% at 5%), so the rule is not supported and has weight 0; 5% is kept as an informational threshold.' },
  { id: 36, name: 'Same deployer, several launches the same day (bundle play)', group: 'rules', status: 'built', w: -1, dir: 'crash', reuse: 'RPC deployer tx scan', explain: 'The deployer launched other tokens within the same day. Serial launchers spray tokens and dump whichever gets traction.' },
  { id: 37, name: 'Quiet token gets a burst of new wallets (discovery)', group: 'rules', status: 'built', w: 1, dir: 'pump', reuse: 'tape unique-wallet buckets', explain: 'After a quiet hour, a sudden wave of first-time wallets: the token is being discovered. Early-interest signal, not a guarantee. Backtest: 5/20 runners vs 0/30 crashes (p=0.007), median 14.5h before breakout: the only early pump signal, so a small +1.' },
];
const STABLE_MINTS = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH']);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function createPatternLab({ DATA_DIR, root, log = () => {} }) {
  const C = {};
  const readJ = (f) => { const p = path.join(DATA_DIR, f); try { const st = fs.statSync(p); const c = C[f]; if (c && c.t === st.mtimeMs) return c.v; const v = JSON.parse(fs.readFileSync(p, 'utf8')); C[f] = { t: st.mtimeMs, v }; return v; } catch { return null; } };
  const ageMin = (f) => { try { return (Date.now() - fs.statSync(path.join(DATA_DIR, f)).mtimeMs) / 60e3; } catch { return null; } };
  let running = false;
  function refresh() { // free live scan only (never --nansen from the server)
    if (running || process.env.PATTERNLAB_LIVE === 'off' || process.env.NO_AUTO_REFRESH === '1') return;
    const a = ageMin('patternlab_live.json'); if (a != null && a < +(process.env.PATTERNLAB_LIVE_MIN || 30)) return;
    running = true;
    try { const ch = spawn('python3', ['research/patternlab/pl_live.py', '20'], { cwd: root, env: { ...process.env, DATA_DIR, NANSEN_API_KEY: '' }, stdio: 'ignore' }); ch.on('exit', () => { running = false; }); ch.on('error', () => { running = false; }); setTimeout(() => { running = false; }, 15 * 60e3).unref(); } catch { running = false; }
  }

  // ---------- live flags per pattern: [{key, sym, flag, value, dir}] ----------
  function liveFlags() {
    const L = readJ('patternlab_live.json') || {}; const out = {}; for (const p of P) out[p.id] = [];
    const add = (id, e) => out[id].push(e);
    for (const [key, t] of Object.entries(L.tokens || {})) for (const [pid, f] of Object.entries(t.flags || {})) {
      if (!out[pid]) continue; const addr = key.split(':')[1];
      if ((pid === '4' || pid === '5') && STABLE_MINTS.has(addr)) continue;
      if (f.flag || (pid === '34' && f.direction === 'pump') || (pid === '26' && f.direction === 'pump') || (pid === '2' && f.flag)) add(+pid, { key, sym: t.symbol, value: f.value, dir: f.direction || null, src: 'pl_live' });
    }
    // contract scan (EVM + Solana scanned tokens): mint / freeze / owner / code heuristics
    const cs = readJ('contractscan.json');
    for (const t of Object.values(cs?.tokens || {})) for (const f of t.flags || []) {
      const k = `${t.chain}:${t.address}`; const e = { key: k, sym: t.symbol, value: f.title, sev: f.sev, src: 'contractscan' }; const id = f.id || '';
      if (id === 'mint' && f.sev !== 'low' && !STABLE_MINTS.has(t.address)) add(4, e);
      if (id === 'freeze' && !STABLE_MINTS.has(t.address)) add(5, e);
      if (['owner', 'hidden_owner', 'mutable', 'proxy_eoa'].includes(id)) add(6, e);
      if (['selfdestruct', 'proxy', 'proxy_eoa', 'hidden_owner', 'balance_edit', 'unverified'].includes(id) || (id === 'switches' && f.sev !== 'low')) add(21, e);
    }
    // fake volume (lib/fakevolume.js live scan)
    const fv = readJ('fakevolume_live.json');
    for (const [k, t] of Object.entries(fv?.tokens || {})) { const lvl = t.level || t.score?.level; const sc = t.score?.score ?? t.fakeScore;
      if (/high/i.test(lvl || '') || sc >= 50) add(11, { key: k, sym: t.symbol, value: `fake-volume score ${sc ?? '?'} (${lvl || ''})`, src: 'fakevolume' });
      if ((t.ring_count || 0) >= 1 || (t.round_trip_wallets || 0) >= 3) add(12, { key: k, sym: t.symbol, value: `${t.ring_count || 0} ring(s), ${t.round_trip_wallets || 0} self-trading wallets`, src: 'fakevolume' }); }
    // copy-trade events (lib/copytrade.js): >=2 tracked wallets same token same side within 6h
    const ct = readJ('copytrade_events.json'); const now = Date.now(); const by = {};
    for (const e of ct?.events || []) if (now - e.t < 6 * 3600e3 && e.mint) { const k = e.mint + '|' + e.side; (by[k] = by[k] || { sym: e.symbol, side: e.side, w: new Set() }).w.add(e.wallet); }
    for (const [k, v] of Object.entries(by)) if (v.w.size >= 2) add(13, { key: 'solana:' + k.split('|')[0], sym: v.sym, value: `${v.w.size} tracked top wallets ${v.side === 'buy' ? 'entered' : 'exited'} within 6h`, src: 'copytrade' });
    // sandwich log (lib/mev.js) for the terminal's own swaps
    const sw = readJ('sandwich_log.json'); for (const t of (sw?.trades || []).slice(-50)) if (t.suspected || t.sandwiched) add(8, { key: t.mint ? 'solana:' + t.mint : null, sym: t.symbol, value: 'your swap was suspected-sandwiched', src: 'mev' });
    // unlocks (lib/unlocks.js calendar): cliff within 14d >= 1% circ
    const un = readJ('unlocks_calendar.json');
    for (const t of un?.tokens || []) { const w14 = t.windows?.['14d']; if (w14 && w14.cliffTokens > 0 && w14.pctCirc >= 1) add(14, { key: null, sym: t.sym, value: `${w14.pctCirc.toFixed(1)}% of circulating supply unlocks within 14d ($${Math.round(w14.usd || 0).toLocaleString()})`, src: 'unlocks' }); }
    // vcwatch: labelled-wallet inflows (cross-token links #15)
    const vc = readJ('vcwatch_live.json'); for (const f of vc?.flags || []) add(15, { key: `${f.chain}:${f.token}`, sym: f.symbol, value: `${f.entity || 'labelled fund/MM wallets'} accumulating`, src: 'vcwatch' });
    // stablecoins (#16) via riskinfra dependencies + pl_live market
    const dep = readJ('riskinfra_dependencies.json');
    for (const s of dep?.stablecoins || []) if (s.price != null && s.pegMechanism && !/yield|rebas/i.test(s.name || '') && s.price < 0.99 && s.mcap > 1e8) add(16, { key: null, sym: s.symbol, value: `$${s.price.toFixed(4)}`, src: 'riskinfra_dependencies' });
    const M = L.market || {}; if (M.depeg && M.depeg[0]) add(16, { key: null, sym: 'MARKET', value: `stablecoin min $${M.depeg[1]?.stable_min_now}`, src: 'pl_live' });
    for (const h of dep?.hacks30d || []) if (/flash/i.test(`${h.technique || ''} ${h.name || ''}`)) add(20, { key: null, sym: h.name, value: `flash-loan hack $${Math.round(h.amount || 0).toLocaleString()}`, src: 'riskinfra hacks' });
    // fees (#17): latest Solana p75 vs 7d median of samples; EVM base fee vs median
    const fh = readJ('fee_history.json'); const S = fh?.samples || [];
    if (S.length >= 4) { const last = S[S.length - 1]; const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
      const sm = med(S.map((s) => s.sol?.p75)); if (last.sol?.p75 && sm && last.sol.p75 >= 3 * sm) add(17, { key: null, sym: 'SOL', value: `priority fee p75 ${Math.round(last.sol.p75)} µlamports/CU = ${(last.sol.p75 / sm).toFixed(1)}x median`, src: 'fees' });
      for (const ch of ['ethereum', 'base', 'bsc', 'arbitrum']) { const m = med(S.map((s) => s.evm?.[ch]?.totalGwei)); const v = last.evm?.[ch]?.totalGwei; if (v && m && v >= 3 * m) add(17, { key: null, sym: ch, value: `gas ${v.toFixed(3)} gwei = ${(v / m).toFixed(1)}x median`, src: 'fees' }); } }
    // liquidations (#18)
    const lq = readJ('liquidations.json'); for (const s of lq?.flags || []) add(18, { key: null, sym: typeof s === 'string' ? s : s.sym, value: 'liquidation cascade flag', src: 'liquidations' });
    // oracles (#19) + TWAP (#24)
    const orc = readJ('riskinfra_oracles.json');
    for (const f of orc?.flags || []) add(19, { key: null, sym: f.asset, value: `${f.type} (${f.severity})`, src: 'oracles' });
    for (const t of orc?.twap || []) if (Math.abs(t.spotVsTwapPct || 0) >= 5) add(24, { key: null, sym: t.asset, value: `spot ${t.spotVsTwapPct.toFixed(1)}% vs 2h TWAP`, src: 'oracles' });
    // halts (#25): headline scan
    const rg = readJ('regradar.json'); const pr = readJ('priority.json');
    const titles = [...(rg?.items || []).map((x) => x.title), ...((pr?.news?.items) || []).map((x) => x.title)].filter(Boolean);
    for (const t of titles) if (/(suspend|halt|pause|freez)\w*.{0,40}(deposit|withdraw|trading)|(deposit|withdraw)\w*.{0,30}(suspend|halt|pause)/i.test(t)) add(25, { key: null, sym: 'NEWS', value: t.slice(0, 140), src: 'headlines' });
    // seasonality (#27) + regimes (#28, #29)
    const se = M.season || {}; const active = Object.entries(se).filter(([k, v]) => v === true).map(([k]) => k.replace(/_/g, ' '));
    if (active.length) add(27, { key: null, sym: 'MARKET', value: active.join(', '), src: 'calendar' });
    if (M.beta && M.beta[0]) add(28, { key: null, sym: 'BTC', value: `BTC 7d ${(M.beta[1].btc_7d_ret * 100).toFixed(1)}% (risk-off)`, src: 'binance' });
    if (M.altseason) { const a = M.altseason[1] || {}; if (a.alt_breadth_30d != null && (a.alt_breadth_30d <= 0.25 || a.alt_breadth_30d >= 0.75)) add(29, { key: null, sym: 'MARKET', value: `${Math.round(a.alt_breadth_30d * 100)}% of 28 alts beat BTC (30d) → ${a.alt_breadth_30d >= 0.75 ? 'ALT season' : 'BTC season'}; ETH/BTC 30d ${((a.ethbtc_30d || 0) * 100).toFixed(1)}%`, dir: a.alt_breadth_30d >= 0.75 ? 'pump' : 'crash', src: 'binance' }); }
    if (M.cascade && M.cascade[0]) add(18, { key: null, sym: 'BTC', value: `BTC intraday ${(M.cascade[1].btc_worst_intraday_low_vs_prev_close_3d * 100).toFixed(1)}% (3d)`, src: 'binance' });
    // perps (#30, #31)
    const ps = readJ('perps.json');
    for (const t of ps?.tokens || []) {
      if (t.fAnn != null && (t.fAnn >= 50 || (t.z != null && t.z >= 2.5 && t.fAnn > 15))) add(30, { key: null, sym: t.sym, value: `funding ${t.fAnn.toFixed(0)}%/yr${t.z != null ? `, ${t.z.toFixed(1)}σ` : ''}`, src: 'perps' });
      if (t.oiCh24 != null && t.oiCh24 >= 20 && t.ch24 != null && Math.abs(t.ch24) <= 3) add(31, { key: null, sym: t.sym, value: `OI +${t.oiCh24.toFixed(0)}% in 24h, price ${t.ch24 >= 0 ? '+' : ''}${t.ch24.toFixed(1)}%`, src: 'perps' });
    }
    const fd = readJ('fundingdiv.json'); for (const a of fd?.active || []) add(30, { key: null, sym: a.sym, value: `funding divergence episode (${a.outlier} outlier)`, src: 'fundingdiv' });
    // pattern-detector worker: fresh-wallet clusters among top holders (#33 coordination; not recomputed)
    const pw = readJ('patterns_wallets_live.json'); for (const t of pw?.items || []) if (t.flag) add(33, { key: t.key, sym: t.symbol, value: `${t.cluster_size} fresh top-holder wallets bought together (${t.cluster_pct}% supply) — pattern-detector`, src: 'patterns_wallets_live' });
    // Nansen flow-intelligence cache (free re-read, #1/#2)
    const nc = readJ('nansen_cache.json');
    for (const [k, v] of Object.entries(nc || {})) { if (!k.startsWith('tgm/flow-intelligence|')) continue; let b; try { b = JSON.parse(k.split('|')[1]); } catch { continue; } const d = v?.v?.data?.[0]; if (!d) continue;
      const net = d.smart_trader_net_flow_usd, n = d.smart_trader_wallet_count; if (net == null || !n || Date.now() - (v.t || 0) > 24 * 3600e3) continue;
      if (net < -1000 && n >= 2) add(1, { key: `${b.chain}:${b.token_address}`, sym: null, value: `${n} smart traders net ${Math.round(net).toLocaleString()} USD (1d)`, src: 'nansen_cache flow-intelligence' });
      if (net > 1000 && n >= 2) add(2, { key: `${b.chain}:${b.token_address}`, sym: null, value: `${n} smart traders net +${Math.round(net).toLocaleString()} USD (1d)`, dir: 'pump', src: 'nansen_cache flow-intelligence' }); }
    // live feed: liq/fdv floor (#35), promotion-after-pump (#9)
    const feed = readJ('live_feed.json'); const bt = readJ('patternlab_backtest.json'); const floor = bt?.patterns?.['35']?.chosen_floor?.floor || 0.05;
    for (const x of feed?.items || []) {
      const cap = x.fdv || x.mcap; if (x.liq && cap && cap > 0 && x.liq / cap < floor) add(35, { key: x.key, sym: x.symbol, value: `liquidity ${(x.liq / cap * 100).toFixed(1)}% of market cap (floor ${(floor * 100).toFixed(0)}%)`, src: 'live_feed' });
      const f = x.features || {}; if ((f.boosts || 0) > 0 && (x.ch24 || 0) >= 300) add(9, { key: x.key, sym: x.symbol, value: `${f.boosts} paid boost(s) after a +${Math.round(x.ch24)}% run`, src: 'live_feed' });
    }
    return { flags: out, liveAt: L.generatedAt || null, market: M, nansen: L.nansen || null, errors: (L.errors || []).slice(0, 10) };
  }

  function table() {
    const bt = readJ('patternlab_backtest.json'); const lf = liveFlags();
    const rows = P.map((p) => {
      const b = bt?.patterns?.[String(p.id)] || null; const s = b?.stats || null;
      const fl = lf.flags[p.id] || [];
      const extra = {};
      if (b) for (const k of Object.keys(b)) if (!['rows', 'stats'].includes(k)) extra[k] = b[k] && typeof b[k] === 'object' && b[k].rows ? { ...b[k], rows: undefined } : b[k];
      return { ...p, backtest: s ? { verdict: s.verdict, crashed: `${s.flag_crashed}/${s.n_crashed}`, runners: `${s.flag_runners}/${s.n_runners}`, hit_crashed: s.hit_crashed, hit_runners: s.hit_runners,
        p_crash: s.p_crash_one_sided, p_pump: s.p_pump_one_sided, p_two_sided: s.p_fisher, lead_crash_h: s.lead_crash_h_median, lead_pump_h: s.lead_pump_h_median,
        false_flag_crash: s.false_flag_rate_as_crash_signal, false_flag_pump: s.false_flag_rate_as_pump_signal, untestable: s.n_untestable,
        catalog: b.catalog?.stats ? { source: b.catalog.source, crash: b.catalog.stats.hit_crashed, pump: b.catalog.stats.hit_runners, n_crash: b.catalog.stats.n_crashed, n_pump: b.catalog.stats.n_runners, p_crash: b.catalog.stats.p_crash_one_sided, p_pump: b.catalog.stats.p_pump_one_sided, verdict: b.catalog.stats.verdict } : null } : null,
        details: extra, live: { count: fl.length, items: fl.slice(0, 25) } };
    });
    return { generatedAt: Date.now(), backtestAt: bt?.generatedAt || null, liveAt: lf.liveAt, testSet: bt?.test_set || null, definitions: bt?.definitions || null,
      market: lf.market, nansen: { ledger: readJ('patternlab_nansen_ledger.json') ? (({ used, balance_start, remaining }) => ({ used, balance_start, remaining }))(readJ('patternlab_nansen_ledger.json')) : null, liveRun: lf.nansen },
      errors: lf.errors, weights: Object.fromEntries(P.filter((p) => p.w || p.cap).map((p) => [p.id, { w: p.w, cap: p.cap || null }])), rows,
      nfa: 'Backtests are small (50 tokens) and descriptive; p-values are not corrected for testing 37+ patterns. Model estimates from public data, not financial advice.' };
  }

  // composite factor (adjustment): sum of small weights of patterns firing for this token; hard caps for mint/freeze authority
  function compositeFactor(chain, address) {
    if (!address) return null; const key = `${chain}:${address}`; const lf = liveFlags(); const hits = [];
    for (const p of P) { if (p.market) continue; const e = (lf.flags[p.id] || []).find((x) => x.key && (x.key === key || x.key.toLowerCase() === key.toLowerCase()) && x.dir !== 'pump'); if (e) hits.push({ p, e }); }
    if (!hits.length) return null;
    const wOf = (h) => (h.e.src === 'contractscan' ? 0 : h.p.w || 0); // contract-scan hits are already penalized by the contract factor: cap only
    const adj = hits.reduce((s, h) => s + wOf(h), 0); const caps = hits.filter((h) => h.p.cap).map((h) => h.p.cap); const cap = caps.length ? caps.sort()[caps.length - 1] : null;
    return { adj: Math.max(-15, adj), cap, value: hits.map((h) => `#${h.p.id}`).join(' '), text: 'Pattern Lab: ' + hits.map((h) => `${h.p.name} — ${h.e.value}${wOf(h) ? ` (${wOf(h)})` : h.p.cap ? ' (cap ' + h.p.cap + ')' : ' (info, 0)'}`).join(' · ') + '. Weights are small and documented in PATTERN_LAB.md.', warn: cap ? `Pattern Lab hard flag: ${hits.filter((h) => h.p.cap).map((h) => h.p.name).join(', ')}` : null };
  }

  function routes() {
    return {
      async '/api/patternlab'() { refresh(); return table(); },
      async '/api/patternlab/token'(q) { refresh(); const chain = q.get('chain') || 'solana'; const a = (q.get('address') || '').trim(); const lf = liveFlags(); const key = `${chain}:${a}`;
        return { key, factor: compositeFactor(chain, a), flags: P.map((p) => ({ id: p.id, name: p.name, hit: (lf.flags[p.id] || []).find((x) => x.key === key) || null })).filter((x) => x.hit) }; },
    };
  }
  return { table, liveFlags, compositeFactor, routes, refresh, PATTERNS: P };
}
let _inst = null;
function shared(DATA_DIR) { if (!_inst || _inst._dir !== DATA_DIR) { _inst = createPatternLab({ DATA_DIR, root: path.join(__dirname, '..') }); _inst._dir = DATA_DIR; } return _inst; }
module.exports = { createPatternLab, shared, PATTERNS: P };
