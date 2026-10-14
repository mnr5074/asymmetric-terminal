// Priority Watch panel (Command view): NEAR + ZEC pinned priority tokens. Data: /api/priority + /api/priority/shielded
// (lib/priority.js, research/priority.py). Market, 4-venue perps, tokenomics, news, narratives, high-priority alerts and the
// ZEC shielded-pool deep dive (history chart, correlation tests, accumulation signal, scenario table). Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const U = (n) => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); return '$' + (a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(a >= 1 ? 2 : 4)); };
  const N = (n, d = 0) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const K = (n) => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); return (a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0)); };
  const PC = (n, d = 1) => (n == null || isNaN(n) ? '<span class="muted">—</span>' : `<span class="${n >= 0 ? 'up' : 'dn'}">${n >= 0 ? '+' : ''}${n.toFixed(d)}%</span>`);
  const PX = (p) => (p == null ? '—' : '$' + (p >= 100 ? N(p, 2) : p >= 1 ? p.toFixed(3) : p.toPrecision(4)));
  const PV = (p) => (p == null ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));
  const ago = (t) => { if (!t) return '—'; const m = (Date.now() - t) / 60e3; return m < 60 ? Math.round(m) + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
  const PT = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
  const css = document.createElement('style');
  css.textContent = `#prioPanel{flex:none;border-color:#6b4bff}#prioPanel .phead{background:linear-gradient(90deg,#1b1340,#111720)}
  .prio .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:6px 8px}.prio .card{border:1px solid var(--line);border-radius:5px;padding:6px 8px;background:rgba(255,255,255,.015);min-width:0}
  .prio h3{margin:0 0 4px;font-size:12px;color:#fff;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.prio h3 .big{font-size:15px}.prio .kv{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px 10px;margin:4px 0}
  .prio .kv div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prio .kv b{color:#fff;font-weight:600}.prio table.tbl td,.prio table.tbl th{padding:2px 4px}.prio .sec{margin-top:6px;color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--line)}
  .prio .al{padding:3px 8px;border-left:3px solid var(--amb);margin:2px 8px;background:rgba(255,176,32,.06);white-space:normal}.prio .al.high{border-color:var(--red);background:rgba(255,77,94,.09)}
  .prio .chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase}.prio .c-heating{background:#8a5a00;color:#fff}.prio .c-emerging{background:#1f6f3f;color:#fff}.prio .c-cooling{background:#333;color:#aaa}.prio .c-neutral{background:#262b33;color:#9aa}
  .prio .wrap{white-space:normal}.prio .news a{color:var(--txt);text-decoration:none}.prio .news a:hover{color:var(--acc)}.prio .news td{white-space:normal}
  .prio canvas{width:100%;display:block;background:#0a0e14;border:1px solid var(--line);border-radius:4px}.prio .note{white-space:normal;color:var(--mut);font-size:10.5px;margin:3px 0}
  .prio .tag{font-size:9px;border:1px solid var(--line);border-radius:2px;padding:0 3px;color:var(--mut);margin-right:2px}
  @media(max-width:900px){.prio .pgrid{grid-template-columns:1fr}.prio .kv{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
  document.head.appendChild(css);
  let D = null, Z = null, newsF = 'all', started = false;

  function ensurePanel() {
    if (Q('#prioOut')) return true;
    const desks = Q('#ccDesks'); if (!desks) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'prioPanel';
    el.innerHTML = '<div class="phead"><span>★ PRIORITY WATCH <span class="muted small">NEAR · ZEC · pinned · funding/OI · tokenomics · news · narratives</span></span><span><span id="prioMeta" class="muted small"></span> <button id="prioToggle" class="btn ghost mini2" title="collapse / expand">▾</button></span></div><div id="prioOut" class="pbody scroll prio" style="max-height:70vh;overflow:auto"><div class="empty">Loading…</div></div>';
    desks.insertAdjacentElement('afterend', el); return true;
  }
  async function get(p) { if (typeof api === 'function') return api(p); const r = await fetch(p); const j = await r.json(); if (j.error) throw new Error(j.error); return j; }
  async function load() {
    try { D = await get('/api/priority'); } catch (e) { Q('#prioOut').innerHTML = `<div class="empty">${E(e.message)}</div>`; return; }
    Z = null; // ZEC shielded-pool deep dive removed from the UI (Martin, Oct 2026); /api/priority/shielded still served
    render();
  }
  function alertsHtml() {
    const a = (D.alerts?.active || []).slice().sort((x, y) => (y.level === 'high') - (x.level === 'high'));
    const rec = (D.alerts?.recent || []).filter((r) => !a.some((x) => x.key === r.key)).slice(0, 6);
    const row = (x, old) => `<div class="al ${x.level === 'high' ? 'high' : ''}" ${old ? 'style="opacity:.6"' : ''}><b>${x.level === 'high' ? 'HIGH' : 'WATCH'}</b> <span class="tag">${E(x.sym)}</span><span class="tag">${E(x.kind)}</span> ${E(x.text)}${x.url ? ` <a href="${E(x.url)}" target="_blank" rel="noopener">↗</a>` : ''} <span class="muted small">${old ? 'raised ' : 'since '}${PT(x.since || x.t)}</span></div>`;
    return `<div class="sec" style="margin:4px 8px 2px">High-priority alerts <span class="muted">(${a.length} active · terminal only: ${E(D.alerts?.sms || '')})</span></div>` +
      (a.length ? a.map((x) => row(x)).join('') : '<div class="note" style="padding:0 8px">No active alerts. Watching: 1h/24h crash &amp; pump moves, crash-lookalike pattern, extreme funding / crowded positioning, OI surges, liquidation cascades, cross-venue price gaps, unlocks, GitHub dev activity, ETF/regulatory headlines, ZEC shielding/deshielding spikes.</div>') +
      (rec.length ? `<div class="note" style="padding:0 8px">Earlier:</div>` + rec.map((x) => row(x, true)).join('') : '');
  }
  function perpsTable(t) {
    const v = t.perps?.venues || [];
    if (!v.length) return '<div class="note">No perp data (see errors).</div>';
    return `<table class="tbl"><thead><tr><th>Venue</th><th class="r">Funding/yr</th><th class="r">Rate</th><th class="r">OI</th><th class="r">OI 24h</th><th class="r">Vol 24h</th></tr></thead><tbody>` +
      v.map((x) => `<tr><td>${E(x.venue)}</td><td class="r">${PC(x.fAnnPct)}</td><td class="r muted">${x.rate != null ? (x.rate * 100).toFixed(4) + '%/' + x.intervalH + 'h' : '—'}</td><td class="r">${U(x.oiUsd)}</td><td class="r" title="${E(x.oiChSrc || '')}">${PC(x.oiCh24Pct)}</td><td class="r">${U(x.vol24Usd)}</td></tr>`).join('') +
      `<tr><td><b>All</b></td><td class="r" title="OI-weighted">${PC(t.perps.fundingAnnPctOiWeighted)}</td><td></td><td class="r"><b>${U(t.perps.oiUsdTotal)}</b></td><td class="r" title="OI-weighted, venues with history">${PC(t.perps.oiCh24PctOiWeighted)}</td><td></td></tr></tbody></table>`;
  }
  function deskLine(t) {
    const p = t.perpsDesk || {}; const bits = [];
    if (p.inUniverse) bits.push(`Perp desk: funding ${p.fAnn != null ? p.fAnn.toFixed(1) + '%/yr' : '—'}${p.z != null ? ` (z ${p.z.toFixed(1)})` : ''}, OI ${U(p.oiUsd)}${p.oiCh24 != null ? ` ${p.oiCh24 >= 0 ? '+' : ''}${p.oiCh24.toFixed(1)}% 24h` : ''}; flags: ${(p.flags || []).length ? p.flags.map((f) => E(f.kind + ' (' + f.level + ')')).join(', ') : 'none'}`);
    else bits.push('Perp desk: ' + E(p.note || ''));
    if (t.move1h != null) bits.push(`1h move ${t.move1h >= 0 ? '+' : ''}${t.move1h.toFixed(2)}%`);
    const l = t.liquidations; bits.push(l ? `Liquidations: ${l.level ? E(l.level + ' (' + l.dom + ')') : 'no cascade'} · ${U(l.w60)} 1h · ${U(l.w24?.total)} 24h (${l.w24?.n || 0} orders)` : 'Liquidations: none seen');
    bits.push(`Price gaps: ${(t.priceGaps || []).length ? t.priceGaps.map((g) => E(g.venue + ' ' + g.adjGapPct + '%')).join(', ') : 'none flagged'}`);
    const cf = t.composite?.crash; bits.push(`Composite: ${t.composite && t.composite.score != null ? E(t.composite.grade || '—') + ' (' + t.composite.score + ')' : 'n/a (too few factors yet; perps stats for NEAR/ZEC load on the next research/perps.py run)'}${cf && cf.available !== false ? ` · crash pattern ${E(cf.value)} (${cf.score}/100)` : ' · crash pattern n/a yet'}`);
    bits.push(`Unlocks: ${t.unlock ? E(t.unlock.level || 'none') + (t.unlock.pct30 != null ? ` (${t.unlock.pct30}% of circ. in 30d)` : '') : 'not in DefiLlama calendar'}`);
    bits.push(`Dev (GitHub): ${t.dev?.note ? E(t.dev.note) : t.dev ? E(t.dev.silence ? 'silence ' + t.dev.silence : t.dev.burst ? 'burst' : 'normal') : '—'}`);
    return `<div class="note">${bits.join(' · ')}</div>`;
  }
  function nearTok(k) {
    if (!k) return '';
    const w = k.supplyWindows || {}; const w30 = w['30d'] || {}; const w7 = w['7d'] || {};
    return `<div class="sec">Tokenomics</div><div class="kv">
      <div>Max inflation <b>${k.maxInflationPct != null ? k.maxInflationPct.toFixed(2) + '%/yr' : '—'}</b></div><div>Realized 30d <b>${w30.annualizedNetInflationPct != null ? w30.annualizedNetInflationPct.toFixed(2) + '%/yr' : '—'}</b></div>
      <div>Staked <b>${K(k.stakedNear)}</b> (${k.stakingRatioPct != null ? k.stakingRatioPct.toFixed(1) + '%' : '—'})</div><div>Staking APR≈ <b>${k.impliedStakingAprPct != null ? k.impliedStakingAprPct.toFixed(2) + '%' : '—'}</b></div>
      <div>Supply <b>${K(k.totalSupply)}</b></div><div>Net +/day (7d) <b>${w7.netSupplyChange != null ? N(w7.netSupplyChange / 7) : '—'}</b></div>
      <div>Fee burn/day≥ <b>${w7.burnEstPerDay != null ? N(w7.burnEstPerDay) + ' NEAR' : '—'}</b></div><div>Txns/day (7d) <b>${K(w7.txnsPerDay)}</b></div></div>
      <div class="note">${E(k.inflationGovernance)} Protocol v${E(k.protocolVersion)}; treasury share ${k.protocolTreasuryShare != null ? (k.protocolTreasuryShare * 100).toFixed(0) + '%' : '—'}. ${E(k.feeBurnNote)} Unlocks: ${k.unlocks?.locked === 0 ? 'DefiLlama shows 0 locked / no scheduled unlocks' : E(JSON.stringify(k.unlocks || {}).slice(0, 160))}.</div>`;
  }
  function zecTok(k) {
    if (!k) return '';
    return `<div class="sec">Tokenomics</div><div class="kv">
      <div>Supply <b>${K(k.supply)}</b> / 21M (${k.pctIssued != null ? k.pctIssued.toFixed(1) + '%' : '—'})</div><div>Block subsidy <b>${k.blockSubsidy ?? '—'} ZEC</b></div>
      <div>Issuance/day <b>${N(k.issuancePerDayCalc)}</b></div><div>Inflation <b>${k.inflationAnnualPctCalc != null ? k.inflationAnnualPctCalc.toFixed(2) + '%/yr' : '—'}</b></div>
      <div>Next halving <b>${E(k.nextHalvingEst)}</b></div><div>Block <b>${N(k.nextHalvingBlock)}</b> (${N(k.blocksToHalving)} to go)</div>
      <div>Shielded <b>${K(k.shieldedTotal)}</b> (${k.shieldedPct != null ? k.shieldedPct.toFixed(1) + '%' : '—'})</div><div>Lockbox <b>${N(k.lockboxBalance)} ZEC</b></div></div>
      <div class="note">${E(k.halvingNote)} ${E(k.devFund)} Ironwood migration ${k.ironwood?.migrationPct != null ? k.ironwood.migrationPct.toFixed(1) + '%' : '—'} (active since ${E(k.ironwood?.activationDate)}).</div>`;
  }
  function narr(sym) {
    const n = D.tokens[sym]?.narratives; if (!n) return '';
    return `<div class="sec">Narratives</div><div class="note">${(n.themes || []).map((r) => `<span class="chip c-${E(r.status)}">${E(r.status)}</span> <b>${E(r.name)}</b> mom ${r.momentum ?? '—'}${r.crowd && r.crowd !== 'ok' ? ' · ' + E(r.crowd) : ''}${r.counted ? '' : ' <span class="tag">tagged by CoinGecko but excluded from this theme by the desk taxonomy</span>'}`).join('<br>') || 'no theme'}</div>` +
      (sym === 'ZEC' && D.zecQuantumNote ? `<div class="note">${E(D.zecQuantumNote)}</div>` : '');
  }
  function card(sym) {
    const t = D.tokens[sym]; if (!t) return '';
    const m = t.market || {};
    return `<div class="card"><h3><span class="big">${E(sym)}</span> <span class="muted">${E(t.name)}</span> <span class="big">${PX(m.price)}</span> ${PC(m.ch24)} <span class="muted small">#${E(m.rank)}</span></h3>
      <div class="kv"><div>Mcap <b>${U(m.mcap)}</b></div><div>Vol 24h <b>${U(m.vol24)}</b></div><div>1h ${PC(m.ch1h, 2)}</div><div>7d ${PC(m.ch7d)}</div><div>30d ${PC(m.ch30d)}</div><div>24h range <b>${PX(m.low24)}–${PX(m.high24)}</b></div><div>ATH <b>${PX(m.ath)}</b> ${PC(m.athChPct, 0)}</div><div class="muted small">CoinGecko ${E((m.updated || '').slice(11, 16))}Z</div></div>
      <div class="sec">Perps (Binance · OKX · Hyperliquid · Gate)</div>${perpsTable(t)}${deskLine(t)}
      ${sym === 'NEAR' ? nearTok(t.tokenomics) : zecTok(t.tokenomics)}${narr(sym)}</div>`;
  }
  function newsHtml() {
    const it = (D.news?.items || []).filter((n) => newsF === 'all' || n.tokens.includes(newsF)).slice(0, 40);
    return `<div class="sec" style="margin:6px 8px 2px">Ecosystem / news feed <span class="subtabs" id="prioNewsF">${['all', 'NEAR', 'ZEC'].map((f) => `<button data-f="${f}" class="${f === newsF ? 'on' : ''}">${f}</button>`).join('')}</span> <span class="muted">${E(D.news?.count)} deduped items · ${E(D.news?.note || '')}</span></div>
      <div style="padding:0 8px;max-height:260px;overflow:auto"><table class="tbl news"><tbody>${it.map((n) => `<tr><td class="muted small" style="white-space:nowrap">${PT(n.t)}</td><td>${n.tokens.map((s) => `<span class="tag">${E(s)}</span>`).join('')}${n.topics.map((s) => `<span class="tag">${E(s)}</span>`).join('')}</td><td><a href="${E(n.url)}" target="_blank" rel="noopener">${E(n.title)}</a> <span class="muted small">${E(n.source)}</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  // ------------- ZEC shielded deep dive
  function shieldedHtml() {
    if (!Z) return '<div class="note" style="padding:0 8px">ZEC shielded data not generated yet.</div>';
    const c = Z.current, a = Z.analysis, s = Z.signal, sc = Z.scenarios;
    const ch = (k) => c[k] ? `${c[k].zec >= 0 ? '+' : ''}${N(c[k].zec)} ZEC (${c[k].pct >= 0 ? '+' : ''}${c[k].pct.toFixed(2)}%, ${c[k].sharePts >= 0 ? '+' : ''}${c[k].sharePts.toFixed(2)} pts)` : '—';
    const pools = ['sprout', 'sapling', 'orchard', 'ironwood'];
    const ll = a.weekly.leadLag.map((x) => `<td class="r" title="n=${x.n}, p=${PV(x.p)}" style="${x.p != null && x.p < 0.05 ? 'color:#fff;font-weight:700' : ''}">${x.r != null ? x.r.toFixed(2) : '—'}<div class="muted small">p ${PV(x.p)}</div></td>`).join('');
    const gr = (arr) => arr.map((g) => `${g.lags}: F ${g.F}, p ${PV(g.p)}`).join(' · ');
    const rowsS = sc.rows.map((r) => `<tr><td><b>${E(r.scenario)}</b></td><td class="r">${K(r.shieldedZec)}</td><td class="r">${r.sharePct.toFixed(1)}%</td>
      <td class="r">${PX(r.ratio1y.low)} / <b>${PX(r.ratio1y.base)}</b> / ${PX(r.ratio1y.high)}</td><td class="r">${PX(r.ratioSince2020.low)} / <b>${PX(r.ratioSince2020.base)}</b> / ${PX(r.ratioSince2020.high)}</td>
      <td class="r">${PX(r.loglog.low)} / <b>${PX(r.loglog.base)}</b> / ${PX(r.loglog.high)}</td><td class="r">${PX(r.ratioNow)}</td></tr>`).join('');
    const coin = a.cointegration;
    return `<div class="sec" style="margin:8px 8px 2px">ZEC shielded-pool deep dive <span class="muted">as of ${E(c.date)} · block ${N(c.height)} · sources: ${E(Z.sources.map((x) => x.name.split(' ')[0] + ' ' + x.from + '→' + x.to).join(', '))} · overlap check ${Z.sourceOverlapCheck ? `max diff ${Z.sourceOverlapCheck.maxAbsDiffPct}% over ${Z.sourceOverlapCheck.days}d` : 'n/a'}</span></div>
    <div class="pgrid"><div class="card">
      <div class="kv"><div>Shielded <b>${N(c.shielded)} ZEC</b></div><div>Share <b>${c.sharePct.toFixed(2)}%</b> of ${K(c.supply)}</div>${pools.map((p) => `<div>${p} <b>${N(c.pools[p])}</b> <span class="muted">${c.poolSharePct[p].toFixed(2)}%</span></div>`).join('')}</div>
      <div class="note">Change 7d: ${ch('ch7d')} · 30d: ${ch('ch30d')} · 90d: ${ch('ch90d')} · 1y: ${ch('ch365d')}</div>
      <canvas id="zsChart" height="230"></canvas><div class="note">Stacked shielded supply by pool (left axis, ZEC) and ZEC price (right axis, log scale), daily since 2020. Orchard→Ironwood after NU6.3 (Jul 2026) is a migration between pools, not new shielding.</div>
      <canvas id="zsFlow" height="120"></canvas><div class="note">Net shielding flow, rolling 7-day sum (green = ZEC moving into shielded pools, red = deshielding), last ~400 days.</div>
    </div><div class="card">
      <div class="sec">Accumulation signal</div>
      <div class="kv"><div>Flow 1d <b>${N(s.flow1d)}</b></div><div>7d <b>${N(s.flow7d)}</b></div><div>30d <b>${N(s.flow30d)}</b></div><div>z(7d) vs 1y <b>${s.z7d_vs1y != null ? s.z7d_vs1y.toFixed(2) : '—'}</b></div>
      <div>Rate 7d <b>${N(s.rate7dPerDay)}/d</b></div><div>Rate 30d <b>${N(s.rate30dPerDay)}/d</b></div><div>z(1d) vs 180d <b>${s.z1d_vs180d != null ? s.z1d_vs180d.toFixed(2) : '—'}</b></div><div>z(30d) <b>${s.z30d_vs1y != null ? s.z30d_vs1y.toFixed(2) : '—'}</b></div></div>
      ${(s.flags || []).map((f) => `<div class="al ${f.level === 'high' ? 'high' : ''}" style="margin:2px 0">${E(f.text)}</div>`).join('') || '<div class="note">No accumulation / deshielding flag.</div>'}
      <div class="note">${E(s.note)}</div>
      <div class="sec">Does shielding move with price? (${E(a.window.from)} → ${E(a.window.to)}, ${N(a.window.days)} days)</div>
      <table class="tbl"><tbody>
      <tr><td>Levels: log price vs log shielded</td><td class="r">r ${a.levels.logPrice_vs_logShielded.r}</td><td class="muted">n ${a.levels.logPrice_vs_logShielded.n}, p ${PV(a.levels.logPrice_vs_logShielded.p)} — trend-driven, not evidence</td></tr>
      <tr><td>Daily return vs daily shielded % change</td><td class="r">r ${a.daily.return_vs_flowPct_sameDay.r}</td><td class="muted">n ${a.daily.return_vs_flowPct_sameDay.n}, p ${PV(a.daily.return_vs_flowPct_sameDay.p)}</td></tr>
      <tr><td>Weekly return vs weekly shielded % change</td><td class="r">r ${a.weekly.return_vs_flowPct_sameWeek.r}</td><td class="muted">n ${a.weekly.return_vs_flowPct_sameWeek.n}, p ${PV(a.weekly.return_vs_flowPct_sameWeek.p)}</td></tr>
      <tr><td>Rolling 90d corr (daily changes)</td><td class="r">latest ${a.rolling90dSummary.latest ? a.rolling90dSummary.latest[1] : '—'}</td><td class="muted">${(a.rolling90dSummary.share_positive * 100).toFixed(0)}% of windows positive, ${(a.rolling90dSummary.share_p_lt_05 * 100).toFixed(0)}% with p&lt;0.05 (n=${a.rolling90dSummary.n})</td></tr>
      <tr><td>Cointegration (Engle-Granger)</td><td class="r">ADF t ${coin.adfResidualT}</td><td class="muted">5% crit ${coin.critical['5%']} → ${coin.cointegrated5pct ? 'cointegrated' : 'not cointegrated'}</td></tr>
      </tbody></table>
      <div class="note">Lead-lag, weekly (r by lag; + = flow leads price):</div>
      <table class="tbl"><thead><tr>${a.weekly.leadLag.map((x) => `<th class="r">${x.lagWeeks > 0 ? '+' : ''}${x.lagWeeks}w</th>`).join('')}</tr></thead><tbody><tr>${ll}</tr></tbody></table>
      <div class="note">Granger (p): flow→price daily ${gr(a.granger.flowLeadsPrice_daily)} | price→flow daily ${gr(a.granger.priceLeadsFlow_daily)} | flow→price weekly ${gr(a.granger.flowLeadsPrice_weekly)} | price→flow weekly ${gr(a.granger.priceLeadsFlow_weekly)}</div>
      <div class="note"><b>Plain English:</b> ${plainCorr(a)}</div>
    </div></div>
    <div style="padding:0 8px 6px"><div class="sec">Scenario table — ${E(sc.label)}</div>
      <table class="tbl"><thead><tr><th>If shielded supply…</th><th class="r">ZEC</th><th class="r">% supply</th><th class="r">Mcap/shielded ratio, last 1y (p10/p50/p90)</th><th class="r">Ratio since 2020 (p10/p50/p90)</th><th class="r">Log-log fit since 2020 (p5/fit/p95)</th><th class="r">Today's ratio held</th></tr></thead><tbody>${rowsS}</tbody></table>
      <div class="note">Price now ${PX(sc.priceNow)}; market cap per shielded ZEC now ${PX(sc.ratio.nowUsdPerShieldedZec)} vs last-year p10/p50/p90 ${PX(sc.ratio.last365d.p10)} / ${PX(sc.ratio.last365d.p50)} / ${PX(sc.ratio.last365d.p90)} — i.e. the market is currently paying ${sc.ratio.nowUsdPerShieldedZec > sc.ratio.last365d.p90 ? 'MORE per shielded ZEC than on 90% of days in the last year' : sc.ratio.nowUsdPerShieldedZec > sc.ratio.last365d.p50 ? 'more than the 1-year median' : 'less than the 1-year median'}. ${E(sc.ratio.explain)}</div>
      <div class="note">Log-log model: ${E(sc.loglog.explain)} Fit quality: R² ${sc.loglog.inSample.r2.toFixed(2)}, in-sample median miss ${sc.loglog.inSample.medianAbsPctError.toFixed(0)}%, walk-forward 90-day median miss ${sc.loglog.walkForward90d.medianAbsPctError != null ? sc.loglog.walkForward90d.medianAbsPctError.toFixed(0) + '%' : '—'} (90th pct ${sc.loglog.walkForward90d.p90AbsPctError != null ? sc.loglog.walkForward90d.p90AbsPctError.toFixed(0) + '%' : '—'}, n=${sc.loglog.walkForward90d.n}). The line puts "fair" at ${PX(sc.loglog.fittedNow)} today — far below the market — which mostly shows how weak this relationship is. ${E(sc.loglog1y?.explain || '')}</div>
      <div class="note">${(Z.caveats || []).map(E).join(' · ')}</div></div>`;
  }
  function plainCorr(a) {
    const d = a.daily.return_vs_flowPct_sameDay, w = a.weekly.return_vs_flowPct_sameWeek;
    const sigLead = a.weekly.leadLag.filter((x) => x.p != null && x.p < 0.05);
    const gSig = [...a.granger.flowLeadsPrice_daily, ...a.granger.flowLeadsPrice_weekly].some((g) => g.p != null && g.p < 0.05);
    const gSig2 = [...a.granger.priceLeadsFlow_daily, ...a.granger.priceLeadsFlow_weekly].some((g) => g.p != null && g.p < 0.05);
    return `Both price and shielded supply rose over the years, so their levels look correlated, but day-to-day and week-to-week changes are essentially unrelated (daily r ${d.r}, p ${PV(d.p)}; weekly r ${w.r}, p ${PV(w.p)}). ` +
      `${sigLead.length ? 'Some single lags reach p<0.05 (' + sigLead.map((x) => x.lagWeeks + 'w') .join(', ') + ') but with this many lags tested that is expected by chance. ' : 'No weekly lead or lag reaches p<0.05. '}` +
      `Granger tests ${gSig ? 'show some evidence that shielding flow helps predict price' : 'find no evidence that shielding flow predicts price'} and ${gSig2 ? 'some evidence that price predicts shielding' : 'no evidence that price predicts shielding'} at the 5% level. ` +
      `The cointegration test ${a.cointegration.cointegrated5pct ? 'supports' : 'does not support'} a stable long-run level link. Treat shielded supply as an adoption metric, not a price signal.`;
  }
  function drawCharts() {
    if (!Z) return;
    const cv = Q('#zsChart'); if (cv) {
      const H = Z.history.filter((r) => r[0] >= '2020-01-01'); const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth || 600, Ht = cv.clientHeight || 230;
      cv.width = W * dpr; cv.height = Ht * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, Ht);
      const L = 46, R = 46, T = 10, B = 18, w = W - L - R, h = Ht - T - B;
      const maxS = Math.max(...H.map((r) => r[1])) * 1.05; const pxs = H.map((r) => r[7]).filter((x) => x > 0); const lmin = Math.log(Math.min(...pxs)), lmax = Math.log(Math.max(...pxs));
      const X = (i) => L + (i / (H.length - 1)) * w, Ys = (v) => T + h - (v / maxS) * h, Yp = (p) => T + h - ((Math.log(p) - lmin) / (lmax - lmin)) * h;
      const cols = { sprout: '#888', sapling: '#4aa3ff', orchard: '#9945ff', ironwood: '#14f195' }; const idx = { sprout: 2, sapling: 3, orchard: 4, ironwood: 5 };
      let below = H.map(() => 0);
      for (const p of ['sprout', 'sapling', 'orchard', 'ironwood']) {
        const top = H.map((r, i) => below[i] + (r[idx[p]] || 0));
        g.beginPath(); H.forEach((r, i) => (i ? g.lineTo(X(i), Ys(top[i])) : g.moveTo(X(i), Ys(top[i])))); for (let i = H.length - 1; i >= 0; i--) g.lineTo(X(i), Ys(below[i])); g.closePath();
        g.fillStyle = cols[p] + '99'; g.fill(); below = top;
      }
      g.beginPath(); let st = false; H.forEach((r, i) => { if (!(r[7] > 0)) return; st ? g.lineTo(X(i), Yp(r[7])) : g.moveTo(X(i), Yp(r[7])); st = true; }); g.strokeStyle = '#ffb020'; g.lineWidth = 1.3; g.stroke();
      g.fillStyle = '#6b7889'; g.font = '10px monospace';
      for (let k = 0; k <= 4; k++) { const v = maxS * k / 4; g.fillText((v / 1e6).toFixed(1) + 'M', 2, Ys(v) + 3); const lp = lmin + (lmax - lmin) * k / 4; g.fillText('$' + Math.round(Math.exp(lp)), W - R + 4, T + h - h * k / 4 + 3); }
      for (let y = 2020; y <= 2026; y++) { const i = H.findIndex((r) => r[0] >= y + '-01-01'); if (i >= 0) { g.fillText(String(y), X(i) - 12, Ht - 4); g.strokeStyle = '#1c2430'; g.beginPath(); g.moveTo(X(i), T); g.lineTo(X(i), T + h); g.stroke(); } }
      let lx = L + 6; for (const [n, c] of [['sprout', cols.sprout], ['sapling', cols.sapling], ['orchard', cols.orchard], ['ironwood', cols.ironwood], ['price (log, right)', '#ffb020']]) { g.fillStyle = c; g.fillRect(lx, T + 2, 8, 8); g.fillStyle = '#d6dde6'; g.fillText(n, lx + 11, T + 10); lx += g.measureText(n).width + 24; }
    }
    const fv = Q('#zsFlow'); if (fv && Z.signal?.series) {
      const S = Z.signal.series.filter((r) => r[2] != null); const dpr = window.devicePixelRatio || 1; const W = fv.clientWidth || 600, Ht = fv.clientHeight || 120;
      fv.width = W * dpr; fv.height = Ht * dpr; const g = fv.getContext('2d'); g.scale(dpr, dpr);
      const L = 46, T = 6, B = 16, w = W - L - 8, h = Ht - T - B; const m = Math.max(...S.map((r) => Math.abs(r[2]))) || 1; const y0 = T + h / 2; const bw = Math.max(1, w / S.length);
      S.forEach((r, i) => { const v = r[2]; g.fillStyle = v >= 0 ? '#18d27a' : '#ff4d5e'; const y = y0 - (v / m) * (h / 2); g.fillRect(L + i * bw, Math.min(y, y0), Math.max(1, bw - 0.3), Math.abs(y - y0)); });
      g.fillStyle = '#6b7889'; g.font = '10px monospace'; g.fillText('+' + K(m), 2, T + 8); g.fillText('-' + K(m), 2, T + h); g.fillText('0', 2, y0 + 3);
      g.fillText(S[0][0], L, Ht - 3); g.fillText(S[S.length - 1][0], W - 80, Ht - 3);
    }
  }
  function render() {
    const errs = D.status?.errors || [];
    Q('#prioMeta').textContent = `data ${D.generatedAt ? ago(D.generatedAt) + ' ago' : '—'} · alerts checked ${ago(D.alerts?.evaluatedAt)} ago${errs.length ? ` · ${errs.length} source error(s)` : ''}`;
    Q('#prioOut').innerHTML = alertsHtml() + `<div class="pgrid">${card('NEAR')}${card('ZEC')}</div>` + newsHtml() +
      (errs.length ? `<div class="note" style="padding:0 8px">Source errors (fields shown as —): ${errs.map((e) => E(e.what + ': ' + e.error)).join(' · ')}</div>` : '') +
      `<div class="note" style="padding:0 8px 6px">${E(D.nfa)}</div>`;
    drawCharts();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#prioNewsF button'); if (b) { newsF = b.dataset.f; render(); return; }
    if (e.target.closest('#prioToggle')) { localStorage.setItem('prioCollapsed', localStorage.getItem('prioCollapsed') === '1' ? '0' : '1'); fold(); }
  });
  function fold() { const c = localStorage.getItem('prioCollapsed') === '1'; const o = Q('#prioOut'), b = Q('#prioToggle'); if (o) o.style.display = c ? 'none' : ''; if (b) b.textContent = c ? '▸' : '▾'; }
  window.addEventListener('resize', () => { if (D) drawCharts(); });
  function start() { if (started || !ensurePanel()) return; started = true; fold(); load(); setInterval(() => { if (!document.body.dataset.view || document.body.dataset.view === 'command') load(); }, 2 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
