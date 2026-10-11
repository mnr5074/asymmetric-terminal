// ASYMMETRIC·TERMINAL — Derive tab: every Derive.xyz option (OI / volume / IV / greeks), defined-risk strategy scanner
// ("buy N, sell some higher to recoup premium, ride the rest"), IV rank / skew, DRV farming math, cross-flags.
// Data: /api/derive (lib/derive.js). Model estimates from public data, not financial advice. Nothing here trades.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const pc = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const vp = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d));
  const px = (x) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString() : Math.abs(x) >= 1 ? (+x).toFixed(2) : (+x).toPrecision(3));
  const usd = (x) => (x == null || isNaN(x) ? '—' : (x < 0 ? '−' : '') + (typeof fUsd === 'function' ? fUsd(Math.abs(x)) : '$' + Math.round(Math.abs(x))));
  const usd2 = (x) => (x == null || isNaN(x) ? '—' : (x < 0 ? '−$' : '$') + (Math.abs(x) >= 100 ? Math.round(Math.abs(x)).toLocaleString() : Math.abs(x) >= 1 ? Math.abs(x).toFixed(2) : Math.abs(x).toPrecision(3)));
  const ixx = (t) => (typeof ix === 'function' ? ix(t) : '');
  const LS = { b: 'st.derive.budget', r: 'st.derive.risk' };
  let D = null, loading = false, tab = 'top', openAsset = null, chainKey = null, chainRows = null, timer = null;

  Object.assign(window.EXPLAIN || {}, {
    dv_oi: ['Open interest (Derive)', 'Number of option contracts still open on Derive (1 contract = 1 unit of the underlying, e.g. 1 ETH), shown in $ as contracts × spot. Big OI at one strike can act like a magnet or a wall near expiry.', (a) => a.oiUsd != null ? `${a.cur}: ${usd(a.oiUsd)} open across all expiries; calls ${px(a.oiC)} vs puts ${px(a.oiP)} contracts.` : null, 'Derive'],
    dv_pc: ['Put/call ratio', 'Puts divided by calls, by open interest (positions held) or by 24h volume (fresh trading). High = more downside protection or bearish bets; low = call heavy. A sudden shift over 24h matters more than the level.', (a) => a.pcOi != null ? `${a.cur}: put/call OI ${a.pcOi}, 24h volume ${a.pcVol ?? '—'}.` : null, 'Derive'],
    dv_iv30: ['IV 30d (ATM)', 'The at-the-money implied volatility for a constant 30-day maturity, interpolated from Derive\'s listed expiries (mark IVs). It is the market\'s price of movement: 50% ≈ a typical ±14% move in 30 days.', (a) => a.iv30 != null ? `${a.cur}: ${pc(a.iv30)} implied, about ±${(a.iv30 * Math.sqrt(30 / 365) * 100).toFixed(1)}% one-sigma over 30 days.` : null, 'Derive'],
    dv_ivrank: ['IV rank / percentile', 'Where today\'s implied vol sits inside its range: rank 0 = at the 1-year low, 100 = at the high; percentile = share of days below today. We use our own stored Derive history once it spans ≥14 days; until then Derive\'s IV is placed inside Deribit\'s DVOL 1-year range (BTC/ETH only).', null, 'Derive'],
    dv_ivrv: ['IV / RV', 'Implied vol (price of options) divided by 30-day realized vol (how much the coin actually moved). Below ~0.9 options look cheap vs recent movement; above ~1.25 they look expensive.', null, 'Derive'],
    dv_rr25: ['25-delta risk reversal (skew)', 'IV of the 25-delta call minus IV of the 25-delta put. Negative = puts cost more (people pay up for crash protection); positive = calls cost more (people chase upside).', null, 'Derive'],
    dv_term: ['Term structure', 'ATM implied vol by expiry. Normally longer expiries carry higher IV (upward slope). Front higher than back (inverted) means near-term stress is priced in.', null, 'Derive'],
    dv_maxpain: ['Max pain', 'The settlement price at which option holders (by open interest) would collectively be paid the least. Some traders watch it as a pin level into expiry; evidence is weak.', null, 'Derive'],
    dv_recovered: ['% of principal recovered upfront', 'Premium collected from the calls/puts you sell, divided by what the calls/puts you buy cost (both after fees, at the real bid/ask). 40% means the short legs paid back 40% of your outlay on day one.', (s) => s.credit != null ? `${pc(s.recovered)}: ${usd2(s.credit)} collected per long vs ${usd2(s.longCost)} paid.` : null, 'Derive'],
    dv_debit: ['Net debit', 'What the whole structure costs you upfront per long contract: long legs at the ask + fees minus short legs at the bid − fees. Compare with the mid-price debit to see what the bid/ask spread costs you.', (s) => `${usd2(s.debit)} per long at bid/ask vs ${usd2(s.midDebit)} at mid.`, 'Derive'],
    dv_maxloss: ['Max loss', 'Worst case at expiry (or at the near expiry for calendars). Because every short is covered by a long, the loss can never exceed this.', null, 'Derive'],
    dv_maxgain: ['Max gain', 'Best case. "Unlimited" when more longs than shorts remain above the top short strike (the riders keep paying as the price keeps going). Vertical spreads are capped.', null, 'Derive'],
    dv_be: ['Breakeven(s)', 'Underlying price(s) at expiry where the structure neither makes nor loses money, after the bid/ask and fees you paid. Ladders can have two: one on the way up, and one far above where the shorts would bite if fewer longs remained.', null, 'Derive'],
    dv_pop: ['Probability of profit', 'Chance the underlying finishes in the profitable zone at expiry, from a lognormal model using that expiry\'s ATM implied vol (market-implied odds, not a forecast). Calendars use the near expiry.', null, 'Derive'],
    dv_evrv: ['EV at realized vol', 'Average profit/loss if the coin keeps moving like it did over the last 30 days (realized vol) instead of what options price in. Usually slightly negative after spreads and fees; positive only when options are cheap vs realized movement.', null, 'Derive'],
    dv_score: ['Strategy score', '40 × probability of profit + 30 × EV at realized vol (as share of max loss, clipped ±50%) + 15 × principal recovered + 15 × (1 − slippage vs mid). A way to sort trade-offs, not a prediction.', null, 'Derive'],
    dv_margin: ['Margin on Derive', 'Simulated with Derive\'s public get_margin for one long contract of the structure. Standard Margin (SM) offsets spreads only inside the SAME expiry, so a calendar\'s near short is margined as if naked; Portfolio Margin (PM2) nets it against the long. "none" = the structure needs no margin beyond paying the debit.', null, 'Derive'],
    dv_ladder: ['Principal-recovery ladder', 'Buy N options, sell a few further out-of-the-money at one strike and a few more at a higher strike. The sales pay back part of the cost now; the unsold longs ("riders") keep unlimited upside. Defined risk: you never sell more than you own.', null, 'Derive'],
    dv_calendar: ['Calendar / diagonal', 'Buy a longer-dated option and sell a nearer-dated one (same strike = calendar; short further OTM = diagonal). Time decay hurts the short faster. Best if price sits near the short strike at its expiry; you can then sell again. Needs Portfolio Margin to avoid a big margin hold.', null, 'Derive'],
    dv_farm: ['DRV trading rewards', 'Derive pays a weekly pool of stDRV to traders pro-rata on FEES paid. The pool value vs total fees decides whether farming pays: reward per $1 of fees = pool × DRV price ÷ all fees that week.', null, 'Derive'],
    dv_bep: ['Break-even DRV price', 'The DRV price at which the stDRV you would earn for $10k of volume exactly pays your fees plus spread cost. Below it, farming loses money before market risk.', null, 'Derive'],
    dv_dvol: ['Deribit DVOL', 'Deribit\'s 30-day implied volatility index for BTC and ETH (like the VIX for crypto). Used as an external benchmark and to rank Derive IV until our own history is long enough.', null, 'Derive'],
  });

  const css = document.createElement('style');
  css.textContent = `body[data-view=derive] main.grid{display:none}body[data-view=derive] #viewDerive{display:flex;flex-direction:column;overflow:auto}
  #viewDerive .dvbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 6px;border-bottom:1px solid var(--line)}#viewDerive .dvbar input{width:80px}
  #viewDerive .dvgrid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:6px;padding:6px}#viewDerive .panel{min-height:0}
  #viewDerive .pbody{overflow:auto;max-height:62vh;padding:4px 6px}#viewDerive .span2{grid-column:1/-1}
  .dvflag{border:1px solid #6a1f27;background:#1a0f12;color:#ffb3b3;padding:5px 8px;border-radius:4px;margin:4px 6px;font-size:12px}.dvflag.watch{border-color:#4a4313;background:#15140c;color:#ead98a}
  .dvchip{display:inline-block;font-size:10px;padding:0 5px;border-radius:3px;border:1px solid var(--line)}.dvchip.cheap{color:#5fe39a;border-color:#14432c}.dvchip.expensive{color:#ff8a8a;border-color:#5a1f27}.dvchip.mixed{color:#e8c64c;border-color:#4a4313}
  .dvcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:6px}.dvcard{border:1px solid var(--line);border-radius:5px;padding:6px 8px;font-size:11.5px;background:#0b1118}
  .dvcard h4{margin:0 0 3px;font-size:12px;display:flex;gap:6px;align-items:center}.dvcard .sum{color:#e6edf6;margin:3px 0 5px}.dvcard table{width:100%;font-size:11px}.dvcard td,.dvcard th{padding:1px 4px;white-space:nowrap}
  .dvm{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px 8px;margin:4px 0}.dvm div{border-bottom:1px solid #141c27}.dvm b{display:block;font-size:12px;color:#e6edf6}
  .dvsz{background:#0d1620;border:1px solid #17304a;border-radius:4px;padding:4px 6px;margin-top:4px}.dvwarn{color:#ffcf9a}.dvmut{color:var(--mut);font-size:10.5px}
  #dvTabs button{font-size:11px}.dvexp td{background:#0d131c}.dvsel{cursor:pointer}.dvsel:hover td{background:#101a26}
  .dvfarm table td,.dvfarm table th{padding:2px 6px}.dvfarm .cite a{color:#7fb6ff}.dvsvg{width:100%;height:90px;background:#0a0f15;border-radius:3px}`;
  document.head.appendChild(css);

  async function load(force) {
    if (loading) return; loading = true;
    const box = Q('#dvOut'); if (!D && box) box.innerHTML = '<div class="empty">Loading Derive chains (≈4,000 options)…</div>';
    try { D = await api('/api/derive'); render(); }
    catch (e) { if (box && !D) box.innerHTML = `<div class="empty">${esc(e.message || e)} — retrying in 15s</div>`; setTimeout(() => load(), 15000); }
    finally { loading = false; }
  }
  function ensureTimer() { if (timer) return; timer = setInterval(() => { if (document.body.dataset.view === 'derive') load(true); }, 150e3); }

  const budget = () => Math.max(50, +(localStorage.getItem(LS.b) || 10000));
  const riskPct = () => Math.min(100, Math.max(1, +(localStorage.getItem(LS.r) || 10)));

  function render() {
    const box = Q('#dvOut'); if (!box || !D) return;
    const st = D.status || {}, m = D.meta || {};
    const alerts = (D.cross?.items || []).filter((x) => x.level === 'alert');
    const watch = (D.cross?.items || []).filter((x) => x.level === 'watch' && (x.risk.length || x.signals.some((s) => /→/.test(s))));
    box.innerHTML = `
      <div class="dvbar"><b>Derive options desk</b>
        <span class="dvmut">${m.tickers || 0} options · ${(D.assets || []).length} underlyings · updated ${st.ageSec ?? '—'}s ago (polls every ${Math.round((m.pollMs || 180000) / 60000)} min) · api.derive.xyz/v3</span>
        <label class="dvmut">Budget $ <input type="number" id="dvBudget" class="mini" value="${budget()}" min="50" step="50"></label>
        <label class="dvmut">Risk % per trade <input type="number" id="dvRisk" class="mini" value="${riskPct()}" min="1" max="100" step="1"></label>
        <span class="dvmut" style="margin-left:auto">Model estimates, not advice · read-only, nothing trades</span></div>
      ${alerts.map((x) => `<div class="dvflag">⚠ ${esc(x.text)}</div>`).join('')}
      ${watch.slice(0, 4).map((x) => `<div class="dvflag watch">${esc(x.cur)}: ${esc([...x.risk, ...x.signals].slice(0, 3).join(' · '))}</div>`).join('')}
      <div class="dvgrid">
        <div class="panel"><div class="phead"><h2>Underlyings</h2><span class="dvmut">tap a row for expiries & chain</span></div><div class="pbody">${assetsTable()}</div></div>
        <div class="panel"><div class="phead"><h2>IV rank · skew · cheap/expensive</h2></div><div class="pbody">${ivPanel()}</div></div>
        <div class="panel span2"><div class="phead tabs" id="dvTabs">${[['top', 'Top 3'], ['bull', 'Bullish'], ['bear', 'Bearish'], ['ladder', 'Recovery ladders'], ['partial', 'Partial covered'], ['vertical', 'Verticals'], ['calendar', 'Calendars'], ['diagonal', 'Diagonals'], ...(D.assets || []).map((a) => ['a:' + a.cur, a.cur])].map(([k, l]) => `<button data-k="${k}" class="${tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}
          <span class="dvmut" style="margin-left:auto">${D.strategies?.valid ?? 0} defined-risk structures priced at bid/ask ${ixx('dv_score')}</span></div>
          <div class="pbody" style="max-height:none">${strategies()}</div></div>
        <div class="panel span2 dvfarm"><div class="phead"><h2>DRV farming ${ixx('dv_farm')}</h2><span class="dvmut">official sources cited · scenario table is hypothetical</span></div><div class="pbody" style="max-height:none">${farmPanel()}</div></div>
        <div class="panel span2"><div class="phead"><h2>Cross-reference: composite / crash detector / perps × Derive OI</h2></div><div class="pbody">${crossPanel()}</div></div>
      </div>
      <div class="dvmut" style="padding:4px 8px">${esc(D.strategies?.method || '')} ${esc(D.strategies?.thinRule || '')}</div>`;
  }

  function assetsTable() {
    const S = D.ivStats || {};
    return `<table class="tbl"><thead><tr><th>Asset</th><th class="r">Spot</th><th class="r">OI ${ixx('dv_oi')}</th><th class="r">Vol 24h</th><th class="r">P/C OI ${ixx('dv_pc')}</th><th class="r">P/C vol</th><th class="r">IV30 ${ixx('dv_iv30')}</th><th class="r">IV/RV ${ixx('dv_ivrv')}</th><th class="r">RR25 ${ixx('dv_rr25')}</th><th>Read</th></tr></thead><tbody>
      ${(D.assets || []).map((a) => { const s = S[a.cur] || {}; return `<tr class="dvsel" data-cur="${esc(a.cur)}"><td><b>${esc(a.cur)}</b> <span class="dvmut">${a.nQuoted}/${a.nInstruments} quoted</span></td><td class="r">${px(a.spot)}</td><td class="r">${usd(a.oiUsd)}</td><td class="r">${usd(a.vol24usd)}</td><td class="r">${a.pcOi ?? '—'}</td><td class="r">${a.pcVol ?? '—'}</td><td class="r">${pc(a.iv30)}</td><td class="r">${s.ivRv ?? '—'}</td><td class="r">${vp(a.rr25_30d)}</td><td>${s.verdict && s.verdict !== 'neutral' ? `<span class="dvchip ${s.verdict}">${s.verdict}</span>` : '<span class="dvmut">neutral</span>'}</td></tr>
        ${openAsset === a.cur ? `<tr class="dvexp"><td colspan="10">${expiryTable(a)}</td></tr>` : ''}`; }).join('')}
      </tbody></table><div class="dvmut">Totals: OI ${usd(D.totals?.oiUsd)} · 24h notional ${usd(D.totals?.vol24usd)} · 24h premium ${usd(D.totals?.prem24)}. OI $ = contracts × spot.</div>`;
  }
  function expiryTable(a) {
    const rows = a.expiries.map((e) => `<tr><td>${esc(e.date)}</td><td class="r">${e.dte}</td><td class="r">${usd(e.oiUsd)}</td><td class="r">${usd(e.vol24usd)}</td><td class="r">${pc(e.atmIv, 1)}</td><td class="r">${vp(e.rr25)}</td><td class="r">${vp(e.fly25)}</td><td class="r">${e.pcOi ?? '—'}</td><td class="r">${e.maxPain != null ? px(e.maxPain) : '—'}</td><td>${e.topStrikes.map((t) => `${px(t.K)}${t.cp} ${usd(t.oiUsd)}`).join(', ')}</td><td><button class="btn ghost dvchain" data-cur="${esc(a.cur)}" data-exp="${esc(e.date)}" style="padding:0 5px">chain</button></td></tr>
      ${chainKey === a.cur + '|' + e.date ? `<tr><td colspan="11">${chainTable()}</td></tr>` : ''}`).join('');
    return `<div class="dvmut">Term structure ${ixx('dv_term')}: front ${pc(a.term.front?.atmIv, 1)} (${esc(a.term.front?.date || '—')}) → ${pc(a.term.back?.atmIv, 1)} (${esc(a.term.back?.date || '—')}); near-dated (≤14d) share of OI ${pc(a.nearOiShare)}. Top strikes: ${a.topStrikes.map((t) => `${esc(t.name)} ${usd(t.oiUsd)}`).join(' · ')}</div>
      <table class="tbl"><thead><tr><th>Expiry</th><th class="r">DTE</th><th class="r">OI</th><th class="r">Vol 24h</th><th class="r">ATM IV</th><th class="r">RR25</th><th class="r">Fly25</th><th class="r">P/C OI</th><th class="r">Max pain ${ixx('dv_maxpain')}</th><th>Top OI strikes</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function chainTable() {
    if (!chainRows) return '<div class="dvmut">loading chain…</div>';
    const ks = [...new Set(chainRows.map((r) => r.K))].sort((a, b) => a - b);
    const by = new Map(chainRows.map((r) => [r.K + r.cp, r]));
    const cell = (r) => r ? `<td class="r">${r.bid ? px(r.bid) : '—'}<span class="dvmut">×${r.bidAmt ? px(r.bidAmt) : 0}</span></td><td class="r">${r.ask ? px(r.ask) : '—'}<span class="dvmut">×${r.askAmt ? px(r.askAmt) : 0}</span></td><td class="r">${px(r.mark)}</td><td class="r">${pc(r.iv, 1)}</td><td class="r">${r.delta != null ? r.delta.toFixed(2) : '—'}</td><td class="r">${r.gamma != null ? r.gamma.toPrecision(2) : '—'}</td><td class="r">${r.theta != null ? px(r.theta) : '—'}</td><td class="r">${r.vega != null ? px(r.vega) : '—'}</td><td class="r">${px(r.oi)}</td><td class="r">${px(r.vol24c)}</td>` : '<td colspan="10"></td>';
    return `<table class="tbl"><thead><tr><th colspan="10" style="text-align:center">CALLS (bid×size · ask×size · mark · IV · Δ · Γ · Θ/day · vega · OI · 24h contracts)</th><th>Strike</th><th colspan="10" style="text-align:center">PUTS</th></tr></thead><tbody>
      ${ks.map((k) => `<tr>${cell(by.get(k + 'C'))}<td><b>${px(k)}</b></td>${cell(by.get(k + 'P'))}</tr>`).join('')}</tbody></table>`;
  }

  function ivPanel() {
    const S = D.ivStats || {};
    return `<table class="tbl"><thead><tr><th>Asset</th><th class="r">IV30</th><th class="r">RV30</th><th class="r">IV rank ${ixx('dv_ivrank')}</th><th class="r">DVOL ${ixx('dv_dvol')}</th><th class="r">RR25</th><th>Term ${ixx('dv_term')}</th><th>Why</th></tr></thead><tbody>
      ${(D.assets || []).map((a) => { const s = S[a.cur] || {}; const own = s.own || {}; const dv = s.dvol;
        const rank = own.rank != null && own.days >= 14 ? `${own.rank.toFixed(0)} <span class="dvmut">own ${own.days.toFixed(0)}d</span>` : dv?.rankOfDeriveIv?.rank != null ? `${dv.rankOfDeriveIv.rank.toFixed(0)} <span class="dvmut">vs DVOL 1y · pctl ${dv.rankOfDeriveIv.pctile.toFixed(0)}</span>` : `<span class="dvmut">${esc(own.note ? 'building (' + own.points + ' pts)' : '—')}</span>`;
        const ts = a.expiries.filter((e) => e.atmIv != null && e.dte >= 1);
        return `<tr><td><b>${esc(a.cur)}</b></td><td class="r">${pc(a.iv30)}</td><td class="r">${pc(s.rv30)}</td><td class="r">${rank}</td><td class="r">${dv ? `${pc(dv.current)} <span class="dvmut">rank ${dv.rank?.toFixed(0)}</span>` : '—'}</td><td class="r">${vp(a.rr25_30d)}</td><td>${spark(ts.map((e) => e.atmIv))}</td><td class="dvmut" style="white-space:normal">${esc([...(s.why || []), ...(s.skew?.notes || [])].join('; ') || '—')}</td></tr>`; }).join('')}
      </tbody></table><div class="dvmut">IV30 = 30-day constant-maturity ATM IV from Derive marks. RV30 = 30-day close-to-close realized vol (${esc([...new Set(Object.values(S).map((s) => s.rvSource).filter(Boolean))].slice(0, 3).join(', '))}…). Own IV history: ${esc(Object.values(S)[0]?.own?.note || 'see ranks')}. Verdict: cheap if IV/RV &lt; 0.9 or rank &lt; 25; expensive if IV/RV &gt; 1.25 or rank &gt; 75.</div>`;
  }
  function spark(v) {
    const a = v.filter((x) => x != null); if (a.length < 2) return '—';
    const mn = Math.min(...a), mx = Math.max(...a), w = 90, h = 18;
    const pts = a.map((x, i) => `${(i / (a.length - 1) * w).toFixed(1)},${(h - (mx > mn ? (x - mn) / (mx - mn) : 0.5) * h).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline fill="none" stroke="#7fb6ff" stroke-width="1.3" points="${pts}"/></svg> <span class="dvmut">${pc(a[0])}→${pc(a[a.length - 1])}</span>`;
  }

  // ---------- strategies ----------
  function size(s) {
    const B = budget(), R = riskPct(), risk = B * R / 100;
    const L = s.legs[0], step = L.step || 0.01, legsN = s.legs.length;
    const baseFees = legsN * (L.baseFee || 0.5);
    let n = Math.floor(Math.max(0, risk - baseFees) / s.maxLoss / step) * step;
    n = +n.toFixed(6);
    const warn = [];
    if (n < (L.minAmt || 0)) warn.push(`Budget too small: minimum ${L.minAmt} contracts (≈ ${usd2(L.minAmt * s.maxLoss + baseFees)} at risk).`);
    const legs = s.legs.map((l, i) => { const q = i === 0 ? n : Math.floor(n * l.q / (l.step || step)) * (l.step || step); return { ...l, n: +q.toFixed(6) }; });
    for (const l of legs.slice(1)) if (l.n > 0 && l.n < (l.minAmt || 0)) warn.push(`${l.name}: ${l.n} is below the ${l.minAmt} minimum; scale up or skip that short.`);
    for (const l of legs) { const depth = l.side === 'buy' ? l.askAmt : l.bidAmt; if (l.n > depth) warn.push(`${l.name}: ${l.n} > ${px(depth)} resting at the ${l.side === 'buy' ? 'ask' : 'bid'} — you would walk the book or need RFQ.`); }
    const debit = n * s.debit + (n > 0 ? baseFees : 0);
    return { n, legs, debit, maxLoss: n * s.maxLoss + (n > 0 ? baseFees : 0), maxGain: s.unlimited ? null : n * s.maxGain - (n > 0 ? baseFees : 0), warn, risk };
  }
  function payoffSvg(s) {
    const c = s.curve || []; if (c.length < 2) return '';
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0), W = 400, H = 90;
    const X = (x) => ((x - x0) / (x1 - x0) * W).toFixed(1), Y = (y) => (H - 4 - (y - y0) / ((y1 - y0) || 1) * (H - 8)).toFixed(1);
    const pts = c.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ');
    return `<svg class="dvsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="#334" stroke-dasharray="3 3"/>
      ${s.spot >= x0 && s.spot <= x1 ? `<line x1="${X(s.spot)}" x2="${X(s.spot)}" y1="0" y2="${H}" stroke="#556"/><text x="${+X(s.spot) + 3}" y="10" fill="#8a96a8" font-size="9">spot ${px(s.spot)}</text>` : ''}
      ${s.breakevens.filter((b) => b >= x0 && b <= x1).map((b) => `<line x1="${X(b)}" x2="${X(b)}" y1="0" y2="${H}" stroke="#8a6d1f" stroke-dasharray="2 2"/>`).join('')}
      <polyline fill="none" stroke="#5fe39a" stroke-width="1.5" points="${pts}"/><text x="2" y="${H - 2}" fill="#8a96a8" font-size="9">${px(x0)}</text><text x="${W - 40}" y="${H - 2}" fill="#8a96a8" font-size="9">${px(x1)}</text></svg>
      <div class="dvmut">P&amp;L per long contract ${s.kind === 'calendar' || s.kind === 'diagonal' ? 'at the short expiry (' + esc(s.expiry) + ', long repriced at current IV)' : 'at expiry ' + esc(s.expiry)}, ±3σ range.</div>`;
  }
  const marginTxt = (v) => (v == null ? 'n/a' : v.im <= 0.005 ? 'none' : usd2(v.im));
  function card(s, i) {
    const z = size(s);
    const kindTerm = s.kind === 'ladder' || s.kind === 'partial' ? 'dv_ladder' : s.kind === 'calendar' || s.kind === 'diagonal' ? 'dv_calendar' : '';
    return `<div class="dvcard" data-si="${i}"><h4><span class="chip">${esc(s.cur)}</span>${esc(s.tag)} ${kindTerm ? ixx(kindTerm) : ''}<span class="dvchip ${s.cp === 'C' ? 'cheap' : 'expensive'}">${esc(s.view)}</span>${s.thin ? '<span class="dvchip mixed">thin market</span>' : ''}<span class="dvmut" style="margin-left:auto">score ${s.score} ${ixx('dv_score')}</span></h4>
      <div class="sum">${esc(s.summary)}</div>
      <table><thead><tr><th>Leg</th><th class="r">per 20</th><th class="r">Fill</th><th class="r">Bid×size</th><th class="r">Ask×size</th><th class="r">Mark</th><th class="r">IV</th><th class="r">Δ</th></tr></thead><tbody>
        ${s.legs.map((l) => `<tr><td class="${l.side === 'buy' ? 'up' : 'dn'}">${l.side.toUpperCase()} ${esc(l.name)}</td><td class="r">${l.qty20}</td><td class="r">${px(l.px)}</td><td class="r">${px(l.bid)}×${px(l.bidAmt)}</td><td class="r">${px(l.ask)}×${px(l.askAmt)}</td><td class="r">${px(l.mark)}</td><td class="r">${pc(l.iv, 1)}</td><td class="r">${l.delta != null ? l.delta.toFixed(2) : '—'}</td></tr>`).join('')}
      </tbody></table>
      <div class="dvm">
        <div>Net debit ${ixx('dv_debit')}<b>${usd2(s.debit)}</b><span class="dvmut">mid ${usd2(s.midDebit)}</span></div>
        <div>Recovered ${ixx('dv_recovered')}<b>${pc(s.recovered)}</b></div>
        <div>Max loss ${ixx('dv_maxloss')}<b class="dn">${usd2(s.maxLoss)}</b></div>
        <div>Max gain ${ixx('dv_maxgain')}<b class="up">${s.unlimited ? 'unlimited' : usd2(s.maxGain)}</b></div>
        <div>Breakeven ${ixx('dv_be')}<b>${s.breakevens.map(px).join(' / ') || '—'}</b></div>
        <div>P(profit) ${ixx('dv_pop')}<b>${pc(s.pop)}</b><span class="dvmut">IV ${pc(s.ivUsed)}</span></div>
        <div>EV @RV ${ixx('dv_evrv')}<b class="${s.evRv > 0 ? 'up' : 'dn'}">${usd2(s.evRv)}</b><span class="dvmut">RV ${pc(s.rvUsed)}</span></div>
        <div>Margin ${ixx('dv_margin')}<b>SM ${marginTxt(s.margin?.sm)} · PM2 ${marginTxt(s.margin?.pm2)}</b></div>
      </div><div class="dvmut">Per 1 long contract; ${esc(s.marginNote)}${s.margin?.smErr ? ' SM: ' + esc(s.margin.smErr.replace(/^get_margin: /, '')) : ''}</div>
      ${payoffSvg(s)}
      <div class="dvsz"><b>Your size</b> (budget ${usd2(budget())}, ${riskPct()}% at risk = ${usd2(z.risk)}): ${z.n > 0 ? z.legs.map((l) => `${l.side} ${l.n} × ${esc(l.name)}`).join(', ') + ` → net debit ${usd2(z.debit)}, max loss ${usd2(z.maxLoss)}, max gain ${z.maxGain == null ? 'unlimited' : usd2(z.maxGain)} (incl. $${(s.legs[0].baseFee || 0.5)} base fee per leg).` : '—'}
        ${z.warn.map((w) => `<div class="dvwarn">${esc(w)}</div>`).join('')}<div class="dvmut">Short quantities are rounded DOWN so they never exceed the longs. A 2-leg RFQ on Derive pays no fee on the second leg.</div></div></div>`;
  }
  let CARDS = [];
  function strategies() {
    const S = D.strategies || {};
    let list = tab === 'top' ? S.top : tab === 'bull' ? S.topBull : tab === 'bear' ? S.topBear : tab.startsWith('a:') ? S.byAsset?.[tab.slice(2)] : S.byKind?.[tab];
    list = list || []; CARDS = list;
    if (!list.length) return '<div class="empty">No defined-risk structure with real two-sided quotes here right now.</div>';
    return `<div class="dvcards">${list.map(card).join('')}</div>`;
  }

  // ---------- farming ----------
  function farmPanel() {
    const f = D.farming; if (!f) return '<div class="empty">Farming data not ready.</div>';
    const d = f.drv, p = f.pool, x = f.exchange24h || {};
    const facts = f.programs?.facts || [];
    const cite = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t || u)}</a>`;
    const caseRows = (f.cases || []).map((c) => `<tr><td>${esc(c.label)}</td><td class="r">${usd2(c.fees)}</td><td class="r">${c.spreadCost != null ? usd2(c.spreadCost) : '—'}</td><td class="r">${c.drvPer10k != null ? c.drvPer10k.toFixed(2) : '—'}</td><td class="r">${usd2(c.rewardUsd)}</td><td class="r ${c.net >= 0 ? 'up' : 'dn'}">${usd2(c.net)}</td><td class="r"><b>${c.breakevenPrice != null ? '$' + c.breakevenPrice.toFixed(2) : '—'}</b></td></tr>`).join('');
    const sc = (f.cases || []).filter((c) => c.scenarios?.length);
    const prices = f.scenarioPrices || [];
    const scen = `<table class="tbl"><thead><tr><th>Hypothetical DRV price →</th>${prices.map((q) => `<th class="r">${d && Math.abs(q - d.price) < 1e-9 ? '<u>$' + q.toFixed(3) + ' (now)</u>' : '$' + q.toFixed(2)}</th>`).join('')}</tr></thead><tbody>
      ${sc.map((c) => `<tr><td>${esc(c.label)} · net per $10k</td>${c.scenarios.map((s) => `<td class="r ${s.net >= 0 ? 'up' : 'dn'}">${usd2(s.net)}</td>`).join('')}</tr>`).join('')}
      ${sc.slice(0, 1).map((c) => `<tr><td class="dvmut">${esc(c.label)} · if you unstake instantly (−20%)</td>${c.scenarios.map((s) => `<td class="r dvmut">${usd2(s.netInstantUnstake)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:10px">
      <div>
        <div><b>DRV</b> ${d ? `${usd2(d.price)} <span class="${d.ch24 >= 0 ? 'up' : 'dn'}">${d.ch24 != null ? (d.ch24 >= 0 ? '+' : '') + d.ch24.toFixed(1) + '% 24h' : ''}</span> · 7d ${d.ch7d != null ? d.ch7d.toFixed(1) + '%' : '—'} · mcap ${usd(d.mcap)} · FDV ${usd(d.fdv)} · ATH ${usd2(d.ath)} (${esc((d.athDate || '').slice(0, 10))})<div class="dvmut">Ethereum contract ${esc(d.contracts?.ethereum || '—')} · ${cite(d.source, 'CoinGecko')}${d.dex ? ` · DexScreener top pool ${cite(d.dex.pair, d.dex.dex + ' ' + usd2(d.dex.price))}, liq ${usd(d.dex.liq)}` : ''}</div>` : 'price unavailable'}</div>
        <div style="margin-top:6px"><b>Campaigns (official)</b><ul style="margin:3px 0 0 16px;padding:0">
          ${facts.map((ft) => `<li><b>${esc(ft.label)}</b>: ${esc([ft.allocation, ft.epoch, ft.trading_pool_table && ('Pool: ' + ft.trading_pool_table), ft.staking_weekly && ('Staking: ' + ft.staking_weekly), ft.usdc_pool && ('Up to ' + ft.usdc_pool), ft.drv_pool && (ft.drv_pool + ' per 28-day epoch to market makers'), ft.obligations && ft.obligations.replace(/\*|\\/g, ''), ft.option_taker && ('Option taker ' + ft.option_taker + ', maker ' + ft.option_maker), ft.perp_taker && ('Perp taker ' + ft.perp_taker + ', maker ' + ft.perp_maker), ft.wash, ft.audit, ft.unstake && ('stDRV: ' + ft.unstake), ft.payout].filter(Boolean).join(' · '))} <span class="dvmut cite">${cite(ft.url, 'source')}${ft.updatedAt ? ' · page updated ' + esc(ft.updatedAt.slice(0, 10)) : ''}</span></li>`).join('')}
          ${(f.programs?.maker || []).length ? `<li><b>Maker programs, current epoch</b> (${esc(f.programs.maker[0].start)} → ${esc(f.programs.maker[0].end)}): ${f.programs.maker.map((m) => `${esc(m.name)} ${Object.entries(m.rewards).map(([k, v]) => Math.round(v).toLocaleString() + ' ' + k).join('+')}`).join(' · ')} <span class="dvmut cite">${cite('https://docs.derive.xyz/api-reference/maker-scoring/publicget_maker_programs', 'get_maker_programs')} — market makers only (scored quoting, $50M+ 28d volume)</span></li>` : ''}
        </ul></div>
        <div class="dvmut" style="margin-top:4px">Exchange last 24h (Derive tickers): options ${usd(x.optionNotional)} notional / ${usd(x.optionPremium)} premium (${x.optionTrades} trades), perps ${usd(x.perpNotional)} (${x.perpTrades} trades) → est. fees ${usd(x.estFeesDay)}/day, ${usd(x.estFeesWeek)}/week. Pool ${p ? p.amount.toLocaleString() + ' ' + esc(p.token) + '/week' : '—'} × ${usd2(d?.price)} ⇒ ≈ ${f.rewardPerFeeDollar != null ? '$' + f.rewardPerFeeDollar.toFixed(2) : '—'} of stDRV per $1 of fees.</div>
      </div>
      <div>
        <table class="tbl"><thead><tr><th>Per $10k volume (one week)</th><th class="r">Fees</th><th class="r">Spread cost</th><th class="r">stDRV earned</th><th class="r">Reward $ now</th><th class="r">Net now</th><th class="r">Break-even DRV ${ixx('dv_bep')}</th></tr></thead><tbody>${caseRows}</tbody></table>
        <div style="margin-top:6px"><b>Scenario table — HYPOTHETICAL token prices</b> (same fee pool and volume as now)</div>${scen}
        <ul class="dvmut" style="margin:4px 0 0 16px;padding:0">${[...(f.assumptions || []), ...(f.caveats || [])].map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      </div></div>`;
  }

  function crossPanel() {
    const c = D.cross || {}; const items = c.items || [];
    return `<div class="dvmut">${esc(c.rule || '')} Composite ${c.compositeAvailable ? 'connected' : 'unavailable'} · perps ${c.perpsAvailable ? 'connected' : 'unavailable'}.</div>
      <table class="tbl"><thead><tr><th>Asset</th><th>Level</th><th>Composite</th><th>Risk side</th><th>Derive OI side</th><th>Signals (P/C, skew)</th></tr></thead><tbody>
      ${items.map((x) => `<tr><td><b>${esc(x.cur)}</b></td><td>${x.level === 'alert' ? '<span class="dvchip expensive">ALERT</span>' : x.level === 'watch' ? '<span class="dvchip mixed">watch</span>' : x.level === 'info' ? '<span class="dvchip">info</span>' : '<span class="dvmut">—</span>'}</td><td>${x.composite ? `<span class="grade g${esc(x.composite.grade)}">${esc(x.composite.grade)}</span> ${x.composite.score}` : '<span class="dvmut">n/a</span>'}</td><td style="white-space:normal">${esc(x.risk.join('; ') || '—')}</td><td style="white-space:normal">${esc(x.heavy.join('; ') || '—')}</td><td style="white-space:normal">${esc(x.signals.join('; ') || '—')}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('#viewDerive')) return;
    const tb = e.target.closest('#dvTabs button[data-k]'); if (tb) { tab = tb.dataset.k; render(); return; }
    const ch = e.target.closest('.dvchain'); if (ch) { e.stopPropagation(); const k = ch.dataset.cur + '|' + ch.dataset.exp; if (chainKey === k) { chainKey = null; render(); return; } chainKey = k; chainRows = null; render(); try { chainRows = (await api(`/api/derive/chain?cur=${encodeURIComponent(ch.dataset.cur)}&exp=${encodeURIComponent(ch.dataset.exp)}`)).rows; } catch { chainRows = []; } render(); return; }
    const row = e.target.closest('tr.dvsel'); if (row && !e.target.closest('.ix')) { openAsset = openAsset === row.dataset.cur ? null : row.dataset.cur; render(); }
  });
  document.addEventListener('pointerdown', (e) => { // explain popups get the strategy / asset under the finger as their example
    const c = e.target.closest('#viewDerive .dvcard'); if (c && CARDS[+c.dataset.si]) { const s = CARDS[+c.dataset.si]; window.setExplainCtx && setExplainCtx(s, `${s.cur} ${s.tag}`); return; }
    const r = e.target.closest('#viewDerive tr.dvsel'); if (r && D) { const a = D.assets.find((x) => x.cur === r.dataset.cur); if (a) window.setExplainCtx && setExplainCtx(a, a.cur); }
  }, true);
  document.addEventListener('change', (e) => {
    if (e.target.id === 'dvBudget') { localStorage.setItem(LS.b, Math.max(50, +e.target.value || 10000)); render(); }
    if (e.target.id === 'dvRisk') { localStorage.setItem(LS.r, Math.min(100, Math.max(1, +e.target.value || 10))); render(); }
  });
  const nav = Q('#viewNav');
  if (nav) nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v === 'derive') { load(); ensureTimer(); } });
  if (document.body.dataset.view === 'derive') { document.querySelectorAll('#viewNav button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'derive')); load(); ensureTimer(); }
})();
