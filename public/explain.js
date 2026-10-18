// Plain-English explanations: tappable ⓘ popups (mobile friendly), per-pick one-line summaries, option Trade Plans, Glossary page.
// Everything is a model estimate, not financial advice.
'use strict';
(function () {
  const $1 = (s) => document.querySelector(s);
  const f2 = (x) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 100 ? (+x).toFixed(1) : Math.abs(x) >= 1 ? (+x).toFixed(2) : (+x).toPrecision(3));
  const usd = (x) => (x == null || isNaN(x) ? '—' : '$' + Math.round(x).toLocaleString());
  const pc = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const dfmt = (s) => { if (!s) return '—'; const d = new Date(s + 'T12:00:00Z'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const nm = (p) => `${p.underlying} ${p.type} ${f2(p.strike)} ${p.expiry}`;
  const below = (p) => (p.type === 'call' ? 'above' : 'below');

  // ---------- glossary: [title, plain text, example(row) or null, group] ----------
  const G = {
    accum: ['Heavy accumulation', 'Tokens where several independent kinds of evidence say large holders are buying: smart-money net inflows, whale buys, coins leaving exchanges, futures open interest building while price stays flat, fund / market-maker wallet buys, tracked top traders buying. Heavy = at least 3 different kinds agree and the score is 60+. Built only from data the terminal already collects (no extra paid calls). Accumulation can precede a move but is NOT a buy signal on its own.', null],
    grade: ['Grade (A–F)', 'Our overall verdict on how lopsided the bet is: a small, known cost against a chance of a large payoff. A is the best ratio in our model, F the worst. It is a ranking, not a prediction that it will win.', (p) => p.underlying ? `${nm(p)} scores ${p.score}/100, which maps to grade ${p.grade} (options: A ≥ 75, B ≥ 60, C ≥ 45, D ≥ 30)${p.caps?.length ? '; capped because: ' + p.caps.join(', ') : ''}.` : (p.gradeModel === 'v2' ? `${p.symbol}: ${p.gradeLabel || p.grade}. ${p.gradeWhy || ''} Live-feed grade v2: letters come only from rules that beat the base rate out-of-sample (A = all, B = some); otherwise 'Unrated — safety checks only'. The old score-based A/B was retired (old A picks rugged 88%).` : `${p.symbol} scores ${p.score}/100 → grade ${p.grade} (legacy live-feed grade).`), 'Options'],
    score: ['Score', 'The number behind the grade (0–100): a weighted mix of expected value, chance of a big win, price vs fair value, cost of time decay and liquidity.', (p) => p.parts ? `Parts for this row: ${Object.entries(p.parts).map(([k, v]) => k + ' ' + v).join(', ')}.` : null, 'Options'],
    best_expiry: ['Best expiry', 'Among all expiration dates for this stock, this one gives the most expected move for the premium after time decay. It is not the best trade overall; the grade is.', (p) => `For ${p.underlying}, ${p.expiry} scored highest among its expiration dates.`, 'Options'],
    premium: ['Premium / max loss', 'What you pay for the option. For a bought option it is also the most you can lose: if it expires worthless, the premium is gone.', (p) => `One contract costs ${f2(p.mid)} × ${p.mult} = ${usd(p.max_loss)}. That is your maximum loss per contract.`, 'Options'],
    max_loss: ['Max loss', 'The most you can lose on a bought option: the full premium. You never owe more than that.', (p) => `${usd(p.max_loss)} per contract for ${nm(p)}.`, 'Options'],
    fair: ['Fair value (Black-Scholes)', 'What the option "should" cost if the stock keeps moving as much as it has recently (realized volatility). Cheaper than fair = you may be getting a discount.', (p) => `Model fair price ${f2(p.fair_rv)} vs market ${f2(p.mid)}.`, 'Options'],
    prem_vs_fair: ['Premium vs fair', 'How much more (or less) the market charges than our fair value. Negative = cheaper than fair (good for a buyer).', (p) => p.prem_vs_fair != null ? `${pc(p.prem_vs_fair)}: you pay ${p.prem_vs_fair < 0 ? 'less' : 'more'} than the model price.` : null, 'Options'],
    iv: ['IV (implied volatility)', 'How much movement the option price is "expecting", per year. High IV = expensive options.', (p) => `IV ${pc(p.iv)} means the market prices roughly a ±${pc(p.iv * Math.sqrt(p.days / 365))} move by expiry (1 standard deviation).`, 'Options'],
    rv: ['Realized volatility (RV)', 'How much the stock actually moved recently (blend of 30/90/180 days), expressed per year like IV.', (p) => `${p.underlying} has actually been moving about ${pc(p.rv30)} per year.`, 'Options'],
    iv_rv: ['IV / RV', 'Price of the option vs how much the stock really moves. Under 1 = options look cheap relative to actual movement; over 1 = you are paying up.', (p) => `${f2(p.iv_rv)}x: options are priced ${p.iv_rv < 1 ? 'below' : 'above'} the stock's real movement.`, 'Options'],
    breakeven: ['Breakeven', 'Where the stock must be at expiry for you to get your money back (strike ± premium).', (p) => `${p.underlying} must be ${below(p)} ${f2(p.breakeven)} on ${p.expiry}, a ${p.move_to_be_pct >= 0 ? '+' : ''}${p.move_to_be_pct.toFixed(1)}% move from ${f2(p.spot)}.`, 'Options'],
    sigma: ['±1σ / ±2σ range', 'The price range the market expects by expiry: about 68% of the time inside ±1σ, 95% inside ±2σ (rough; real markets have fatter tails).', (p) => `By ${p.expiry}: 1σ ${f2(p.sigma1[0])}–${f2(p.sigma1[1])}, 2σ ${f2(p.sigma2[0])}–${f2(p.sigma2[1])}.`, 'Options'],
    targets: ['Targets 3x / 5x / 10x', 'Stock price at expiry where the option is worth 3, 5 or 10 times what you paid.', (p) => `3x needs ${p.underlying} at ${f2(p.targets['3x'])}, 5x at ${f2(p.targets['5x'])}, 10x at ${f2(p.targets['10x'])}.`, 'Options'],
    exit_by: ['Exit by / needs (3x)', 'A suggested sell-by date that keeps some time value (time decay speeds up near expiry), and the stock price needed by then for a 3x.', (p) => `Sell by ${dfmt(p.exit_by)}; for 3x by then ${p.underlying} needs about ${f2(p.need_for_3x_at_exit)}.`, 'Options'],
    p_itm: ['P(ITM)', 'Chance the option finishes "in the money" (worth something) at expiry, from a simple model. Using IV = market view, RV = recent movement.', (p) => `${pc(p.p_itm_iv)} by IV, ${pc(p.p_itm_rv)} by RV. Being ITM is not the same as profitable: you still need to pass breakeven.`, 'Options'],
    p_touch: ['P(touch 3x)', 'Chance the stock reaches the 3x price at any time before expiry (you could sell then). Always higher than finishing there.', (p) => `${pc(p.p_touch3x_rv)} (RV model) that ${p.underlying} touches ${f2(p.targets['3x'])} before ${p.expiry}.`, 'Options'],
    ev: ['EV (expected value)', 'Average profit or loss if you could make this exact bet many times, using recent volatility. Positive EV does not mean this one wins; most long options still lose.', (p) => `${p.ev_pct.toFixed(0)}% of the premium (${usd(p.ev)} per contract) on average in the model.`, 'Options'],
    rr: ['Reward : risk (2σ)', 'Profit if the stock makes a 2-standard-deviation move your way, divided by what you can lose.', (p) => `${f2(p.rr_2sigma)}x: a 2σ move would make about ${f2(p.rr_2sigma)} times the premium.`, 'Options'],
    theta: ['Theta / day', 'Time decay: how much value the option loses each day if nothing else changes.', (p) => `About ${usd(-p.theta_day)} per contract per day now (${p.theta_pct_day.toFixed(1)}% of the premium).`, 'Options'],
    delta: ['Delta', 'How much the option moves for a $1 move in the stock, and a rough probability of finishing in the money.', (p) => p.delta != null ? `Delta ${p.delta.toFixed(2)}: a $1 move in ${p.underlying} changes the option by about $${Math.abs(p.delta).toFixed(2)} per share (${usd(Math.abs(p.delta) * p.mult)} per contract).` : 'Shown after the next options refresh.', 'Options'],
    gamma: ['Gamma', 'How fast delta changes as the stock moves. High gamma = the option speeds up quickly when the stock moves your way (and slows quickly when it does not).', (p) => p.gamma != null ? `Gamma ${p.gamma.toFixed(4)}: after a $1 move, delta changes by about ${p.gamma.toFixed(4)}.` : null, 'Options'],
    vega: ['Vega', 'How much the option gains or loses if implied volatility moves by 1 point. Matters around earnings (IV usually drops right after).', (p) => p.vega_1pt != null ? `A 1-point IV change moves this contract by about ${usd(p.vega_1pt)}.` : null, 'Options'],
    volume_oi: ['Vol / OI, unusual volume', 'Volume = contracts traded in the latest session; open interest (OI) = contracts still open. Volume much bigger than OI ("unusual") means fresh positioning today.', (p) => `${p.volume ?? '—'} traded vs ${p.oi} open (${f2(p.vol_oi)}x).`, 'Options'],
    oi: ['Open interest (OI)', 'How many contracts are currently open. Higher OI usually means tighter spreads and easier selling later.', (p) => `${p.oi} open contracts on this strike.`, 'Options'],
    earnings: ['Earnings flag', 'The company reports before this option expires. Options are usually pricey before a report and drop in value right after ("IV crush"), even if the stock moves.', (p) => p.earnings ? `${p.underlying} reports ${dfmt(p.earnings)}, before the ${p.expiry} expiry.` : null, 'Options'],
    p_profit: ['Chance of profit', 'Chance the stock finishes beyond breakeven at expiry (so the option is worth more than you paid), using recent volatility. Usually well under 50% for cheap out-of-the-money options.', (p) => p.p_profit_rv != null ? `${pc(p.p_profit_rv)} that ${p.underlying} is ${below(p)} ${f2(p.breakeven)} on ${p.expiry}.` : null, 'Options'],
    p_tp: ['Chance to hit take-profit', 'Chance the option reaches 2x / 3x your cost at some point before the sell-by date (the stock has to reach the price shown while there is still time value).', (p) => p.p_tp_before_stop ? `2x needs ${p.underlying} ≈ ${f2(p.tp_need?.['2x'])} (${pc(p.p_tp_before_stop['2x'])}), 3x ≈ ${f2(p.tp_need?.['3x'])} (${pc(p.p_tp_before_stop['3x'])}) before ${dfmt(p.time_stop)}.` : null, 'Options'],
    signals: ['Ticker signals', 'Extra points (max ±6) from insider buying/selling (SEC Form 4), news tone, buy vs sell volume and call/put flow. Calls gain from bullish signals, puts from bearish ones.', (p) => p.signals?.length ? `${p.signal_pts >= 0 ? '+' : ''}${p.signal_pts || 0} pts: ${p.signals.join(' ')}` : 'No signal adjustments for this ticker.', 'Options'],
    ext: ['Pre-market / after-hours', 'Price trading outside regular hours (4am–9:30am and 4pm–8pm ET). Option quotes here are from the last regular session, so a big extended-hours move means they will reprice at the open.', null, 'Options'],
    insider: ['Insider activity (Form 4)', 'Company officers and directors must report trades to the SEC within 2 business days. Open-market buys with their own cash are a meaningful bullish signal; sales are common (taxes, planned 10b5-1 programs) and weaker. "Cluster buying" = 2+ insiders buying within 30 days.', null, 'Options'],
    filing8k: ['8-K filing', 'A company report of a material event (earnings, deal, executive change, financing). A fresh 8-K is worth reading before trading.', null, 'Options'],
    updown: ['Up/down volume', 'Share of the last 10 sessions\' trading volume that happened on up days. Above 60% suggests buyers in control, below 40% sellers.', null, 'Options'],
    cpr: ['Call/put volume ratio', 'Calls traded divided by puts traded in the latest session across the whole chain. Above 1.5 leans bullish, below 0.67 bearish. True real-time order flow (sweeps, aggressor side) needs paid data (Tradier, Unusual Whales, ThetaData).', null, 'Options'],
    xsoc: ['X mentions', 'From ~20 recent X posts with the cashtag: how fast people are posting (posts per hour) and the average tone (bullish minus bearish words). Paid X API, only for alerted tokens and top picks; logged so we can measure if it predicts anything.', null, 'Crypto'],
    mark_only: ['Mark only', 'No live bid and ask right now; the price shown is the exchange "mark", so the real fill could differ. Grade is capped.', null, 'Options'],
    // crypto
    asym: ['Asymmetry score (live feed)', 'Our 0–100 score for new tokens: buy pressure and acceleration, number of real buyers, safety checks, room to grow, similarity to past 100x tokens, narrative, smart wallets and attention. Grade A ≥ 72.', (x) => x.components ? `${x.symbol}: ${Object.entries(x.components).filter(([, v]) => typeof v === 'number').map(([k, v]) => k + ' ' + Math.round(v * 100) + '%').join(', ')}.` : null, 'Crypto'],
    veto: ['Veto', 'A hard red flag (e.g. mint authority live, honeypot, liquidity pulled, fake liquidity) forces grade F regardless of score.', (x) => x.veto ? `${x.symbol}: ${x.veto}.` : null, 'Crypto'],
    rug: ['Rug Risk Forecast', '0–100 estimate of how likely a token is to be dumped on holders (hard rug, slow rug, unlock dump…). ≥45 lowers the grade, ≥70 vetoes it. ⚠ = dump risk in the next 30 days.', (x) => x.rug ? `${x.symbol}: ${x.rug.score}/100 (${x.rug.level}). ${(x.rug.top || []).slice(0, 2).join('; ')}` : null, 'Crypto'],
    fdv: ['FDV vs market cap', 'Market cap counts tokens circulating now; FDV (fully diluted) counts all tokens that will ever exist. A big gap means many tokens still to be unlocked and sold.', (x) => x.fdv && x.mcap ? `${x.symbol}: mcap ${usd(x.mcap)}, FDV ${usd(x.fdv)} (${(x.fdv / x.mcap).toFixed(1)}x).` : null, 'Crypto'],
    float: ['Float / liquid float', 'The share of supply that can actually trade. Staked, locked, vesting and team tokens are not liquid float. A small float can pump fast and dump fast.', null, 'Crypto'],
    bundle: ['Bundled launch', 'The creator bought a big share in the same block as launch using many wallets. Those tokens are often dumped on later buyers.', null, 'Crypto'],
    snipers: ['Snipers / insiders', 'Wallets that bought within seconds of launch, usually bots or insiders, who tend to sell into the first pump.', null, 'Crypto'],
    lp: ['LP burned / locked', 'The pool liquidity (the money you sell into) is burned or locked, so the creator cannot pull it. Unlocked LP = "rug pull" risk.', null, 'Crypto'],
    liq: ['Liquidity', 'Money in the trading pool. It decides how much you can sell without crashing the price. Under $3K we veto.', (x) => x.liq ? `${x.symbol} has ${usd(x.liq)} of pool liquidity.` : null, 'Crypto'],
    smart: ['Smart money (Nansen)', 'Wallets Nansen labels as consistently profitable traders/funds. Net buying = they are accumulating; net selling = distributing.', null, 'Crypto'],
    sleeper: ['Sleeper score', 'For established coins far below their all-time high: deep value + real fees/revenue + hot sector + volatility squeeze + strength vs BTC + accumulation + developer activity.', null, 'Crypto'],
    accumulation: ['Accumulation phase', 'Flat price, tight range, compressed volatility and rising volume, often seen before big moves. In our backtest it did NOT beat the base rate, so treat it as a description, not a signal.', null, 'Crypto'],
    lookalike: ['Lookalike', 'How closely a coin\'s recent chart pattern (drawdown, volatility squeeze, volume trend, strength vs BTC) matches past winners in the 30–90 days before their breakout. Our backtest showed no edge yet.', null, 'Crypto'],
    airdrop_grade: ['Airdrop grade', 'How good the expected allocation looks: early (no token yet, young points program), well funded, few participants, low dilution. Not a promise of an airdrop.', null, 'Airdrops'],
  };
  window.EXPLAIN = G;
  let ctx = null, ctxLabel = '';
  window.setExplainCtx = (row, label) => { ctx = row; ctxLabel = label || ''; };
  window.ix = (term, cls = '') => G[term] ? `<button type="button" class="ix ${cls}" data-term="${term}" aria-label="What is ${G[term][0]}?">i</button>` : '';
  const pop = document.createElement('div'); pop.id = 'ixPop'; pop.className = 'ixpop hidden'; document.body.appendChild(pop);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.ix');
    if (!b) { if (!e.target.closest('#ixPop')) pop.classList.add('hidden'); return; }
    e.stopPropagation(); e.preventDefault();
    const [title, text, ex] = G[b.dataset.term];
    let eg = null; const rowEl = b.closest('[data-i]'); const row = rowEl && window._ixRows ? window._ixRows[+rowEl.dataset.i] : ctx;
    try { eg = ex && row ? ex(row) : null; } catch { eg = null; }
    pop.innerHTML = `<b>${esc(title)}</b><button class="ixc" aria-label="close">×</button><p>${esc(text)}</p>${eg ? `<p class="eg"><span>Example${row && !rowEl && ctxLabel ? ' (' + esc(ctxLabel) + ')' : ''}:</span> ${esc(eg)}</p>` : ''}`;
    pop.classList.remove('hidden');
    if (window.innerWidth < 700) { pop.style.left = '8px'; pop.style.right = '8px'; pop.style.top = 'auto'; pop.style.bottom = '8px'; }
    else { const r = b.getBoundingClientRect(); pop.style.right = 'auto'; pop.style.bottom = 'auto'; pop.style.left = Math.min(r.left, window.innerWidth - 380) + 'px'; pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 220) + 'px'; }
  }, true);
  pop.addEventListener('click', (e) => { if (e.target.classList.contains('ixc')) pop.classList.add('hidden'); });

  // ---------- one-line plain summary per option pick ----------
  window.optPlain = (p) => `Costs ${usd(p.max_loss)} per contract. Needs ${p.underlying} ${below(p)} ${f2(p.breakeven)} by ${dfmt(p.expiry)} to break even (${p.move_to_be_pct >= 0 ? '+' : ''}${p.move_to_be_pct.toFixed(1)}%); ~${pc(p.p_touch3x_rv)} chance to triple at some point, ~${pc(p.p_itm_rv)} chance to finish in the money.`;
  window.livePlain = (x) => `${x.symbol} on ${x.chain}: ${usd(x.mcap || x.fdv)} market cap, ${usd(x.liq)} liquidity, ${x.ageH < 48 ? x.ageH.toFixed(1) + ' hours' : Math.round(x.ageH / 24) + ' days'} old. ${x.veto ? 'Vetoed: ' + x.veto + '.' : `Grade ${x.grade}${x.rug ? `, rug forecast ${x.rug.score}/100` : ''}.`}`;

  // ---------- Trade Plan ----------
  const TP = { budget: 'st.tp.budget', risk: 'st.tp.risk' };
  window.tradePlan = function (p) {
    const budget = +(localStorage.getItem(TP.budget) || 1000), riskPct = +(localStorage.getItem(TP.risk) || 5);
    const live = p.bid > 0 && p.ask > 0;
    const spread = live ? p.ask - p.bid : null;
    // limit: mid, shaded toward bid when the spread is wide; never above fair (RV) when the market is rich
    let limit = live ? p.bid + spread * (p.spread_pct > 0.15 ? 0.35 : 0.5) : p.mid;
    if (p.fair_rv && p.fair_rv < limit && p.fair_rv > (p.bid || 0)) limit = Math.max(p.bid || 0, (limit + p.fair_rv) / 2);
    limit = Math.max(0.01, +limit.toFixed(limit >= 1 ? 2 : 3));
    const cost1 = limit * p.mult;
    const riskBudget = budget * riskPct / 100;
    const n = Math.floor(riskBudget / cost1);
    const today = new Date(); const exp = new Date(p.expiry + 'T20:00:00Z'); const dte = Math.round((exp - today) / 864e5);
    const ts = p.time_stop || (dte > 35 ? new Date(exp - 21 * 864e5) : new Date(p.exit_by + 'T20:00:00Z')).toISOString().slice(0, 10);
    const entryWhy = [];
    if (p.earnings_before_expiry) {
      const ed = new Date(p.earnings + 'T12:00:00Z'); const dd = Math.round((ed - today) / 864e5);
      entryWhy.push(dd >= 0 && dd <= 10 ? `Earnings on ${dfmt(p.earnings)}: options are usually priced up right before and lose value right after (IV crush). Either buy now knowing that, or wait until the day after the report.` : `Earnings on ${dfmt(p.earnings)} falls before expiry; expect an IV drop after the report.`);
    }
    if (p.iv_rv != null) entryWhy.push(p.iv_rv < 0.9 ? `IV is low vs the stock's real movement (${f2(p.iv_rv)}x), a decent time to buy.` : p.iv_rv > 1.3 ? `IV is high vs real movement (${f2(p.iv_rv)}x): options are expensive now; a calmer day may be cheaper.` : `IV is roughly in line with real movement (${f2(p.iv_rv)}x).`);
    entryWhy.push(live ? `Bid ${f2(p.bid)} / ask ${f2(p.ask)}: use a limit order at about ${f2(limit)}${p.spread_pct > 0.15 ? ' (wide spread, so stay closer to the bid and be patient)' : ''}; never a market order.` : 'No live bid/ask right now: wait for the market to open and use a limit order.');
    entryWhy.push('We do not have data showing a reliable day-of-week effect, so ignore Monday/Friday folklore; just avoid holding through the final weeks.');
    const intrinsic = Math.max(0, p.type === 'call' ? p.spot - p.strike : p.strike - p.spot);
    const timeVal = Math.max(0, p.mid - intrinsic);
    const exCash = p.strike * p.mult;
    const deepItm = intrinsic > 0 && timeVal / p.mid < 0.05 && dte <= 7;
    const tp1 = limit * 2, tp2 = limit * 3;
    const card = n >= 1
      ? `If you have ${usd(budget)} and risk ${riskPct}% (${usd(riskBudget)}): buy ${n} contract${n > 1 ? 's' : ''} at about ${f2(limit)} (${usd(n * cost1)} total, your max loss). Sell half at ${f2(tp1)}, the rest at ${f2(tp2)}, and sell anything left by ${dfmt(ts)}.`
      : `One contract costs ${usd(cost1)}, more than ${riskPct}% of ${usd(budget)} (${usd(riskBudget)}). Skip it, pick a cheaper strike, or accept a bigger share of your budget at risk (not recommended).`;
    return { budget, riskPct, limit, n, cost1, ts, card, entryWhy, tp1, tp2, intrinsic, timeVal, exCash, deepItm, dte };
  };
  window.tradePlanHTML = function (p) {
    const t = tradePlan(p);
    return `<div class="tplan"><div class="tph">Trade plan <span class="nfa2">model estimate, not financial advice</span>
      <label>Budget $<input type="number" class="tpB" value="${t.budget}" min="50" step="50"></label><label>Risk % <input type="number" class="tpR" value="${t.riskPct}" min="1" max="100" step="1"></label></div>
      <div class="tpcard">${esc(t.card)}${p.p_profit_rv != null ? ` Chance of profit at expiry ≈ ${pc(p.p_profit_rv)}.` : ''}</div>
      <div class="tpgrid">
       <div><b>1 · Entry</b><ul>${t.entryWhy.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
       <div><b>2 · Size</b><ul><li>${t.n} × ${usd(t.cost1)} = ${usd(t.n * t.cost1)} at risk (${(t.n * t.cost1 / t.budget * 100).toFixed(1)}% of budget).</li><li>Keep any single long option to about 2–5% of your budget: most expire worthless, so you need many small bets to catch the big winners.</li></ul></div>
       <div><b>3 · Exit</b><ul><li>Take profit: sell half at ${f2(t.tp1)} (2x) to get your cost back, the rest at ${f2(t.tp2)} (3x) or trail it.${p.p_tp_before_stop ? ` Model chance of reaching 2x before ${dfmt(t.ts)}: ${pc(p.p_tp_before_stop['2x'])}; 3x: ${pc(p.p_tp_before_stop['3x'])}.` : ''}</li><li>Time stop: sell by ${dfmt(t.ts)}${t.dte > 35 ? ' (about 21 days before expiry, when time decay speeds up)' : ' (short-dated: decay is already fast)'}.</li><li>Stop loss: the position size is the real stop. Optionally sell if it loses ~50% and the reason you bought (move in ${esc(p.underlying)}) is clearly broken; options swing a lot, so tight stops get hit by noise.</li></ul></div>
       <div><b>4 · Exercise or sell?</b><ul><li>Selling is usually better: it collects the remaining time value (${f2(t.timeVal)}/share = ${usd(t.timeVal * p.mult)} per contract now); exercising throws it away.</li><li>Exercising ${p.type === 'call' ? `a call means buying 100 shares at ${f2(p.strike)}: ${usd(t.exCash)} cash per contract` : `a put means selling 100 shares at ${f2(p.strike)} (you need the shares, or your broker shorts them): you receive ${usd(t.exCash)} per contract`}.</li><li>${t.deepItm ? 'This one is deep in the money near expiry with little time value left, so exercising costs little — reasonable if you want the shares for a longer-term view.' : 'Exercise only makes sense deep in the money near expiry with almost no time value left, or if you want to own the shares long term.'}</li></ul></div>
      </div></div>`;
  };
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('tpB')) localStorage.setItem(TP.budget, Math.max(50, +e.target.value || 1000));
    else if (e.target.classList.contains('tpR')) localStorage.setItem(TP.risk, Math.min(100, Math.max(1, +e.target.value || 5)));
    else return;
    const box = e.target.closest('.tplan'); const p = box && window._tpRow?.get(box); if (p) { const nb = document.createElement('div'); nb.innerHTML = tradePlanHTML(p); const n = nb.firstElementChild; window._tpRow.set(n, p); box.replaceWith(n); }
  });
  window._tpRow = new WeakMap();

  // ---------- Glossary / how grades work page ----------
  window.renderGlossary = function () {
    const groups = {}; for (const [k, v] of Object.entries(G)) (groups[v[3]] ||= []).push([k, v]);
    $1('#glossOut').innerHTML = `<div class="gloss"><h2>How grades work</h2>
      <p><b>Options (A–F):</b> score 0–100 = 30 × expected value (recent volatility) + 25 × chance to touch the 3x price + 20 × convexity (payoff at a 2σ move) + 15 × cheapness (IV vs realized vol) + 10 × liquidity (spread, open interest), then ±6 from ticker signals (insider Form 4 buys/sells, news tone, up/down volume, call/put flow). Caps: no live quote → max C; under 3 days → max D; earnings with rich IV → max C; fast time decay → max C/B. A ≥ 75, B ≥ 60, C ≥ 45, D ≥ 30, else F. The grade ranks how lopsided the bet is, not whether it will win; most bought options expire worthless.</p>
      <p><b>Live crypto feed:</b> Asymmetry score = flow 25 + participation 20 + safety 20 + upside 15 + similarity to past moonshots 10 + narrative 5 + smart wallets 5 + attention 5 (weights recalibrated from tracked results), then Nansen smart-money ±5, rug-forecast penalty (≥45: −10 and A→B; ≥70: veto) and hard vetoes (mint/freeze authority, honeypot, fake liquidity, top-10 > 60%, liquidity pulled).</p>
      <p><b>Airdrops:</b> early-ness, funding and backers, crowding, dilution and TVL per user; projects with no disclosed funding and under $1M TVL are capped at C.</p>
      <p><b>Sleepers:</b> deep value vs ATH, real fees/revenue, sector heat, volatility compression, strength vs BTC, accumulation, developer activity, derivatives positioning. The accumulation and lookalike add-ons did not beat the base rate in our backtest.</p>
      <p class="dn">All numbers are automated estimates from public data. Not financial advice.</p>
      ${Object.entries(groups).map(([g, L]) => `<h2>${esc(g)}</h2><dl>${L.map(([k, v]) => `<dt>${esc(v[0])}</dt><dd>${esc(v[1])}</dd>`).join('')}</dl>`).join('')}</div>`;
  };
})();
