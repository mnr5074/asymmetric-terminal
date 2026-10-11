// ASYMMETRIC·TERMINAL Perp Desk panel (Command view): funding/OI flags, perp setups, composite A–F grades, unlocks, venues.
// Data: /api/perps, /api/composite, /api/unlocks. Model estimates from public data, not financial advice. Nothing here trades.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const G = (g) => (g ? `<span class="grade g${esc(g)}">${esc(g)}</span>` : '<span class="muted">—</span>');
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (+x).toFixed(d) + '%');
  const px = (x) => (x == null || isNaN(x) ? '—' : x >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 0 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
  const usd = (x) => (typeof fUsd === 'function' ? fUsd(x) : '$' + Math.round(x));
  const cls = (x) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : '');
  // glossary terms (tap ⓘ)
  Object.assign(window.EXPLAIN || {}, {
    pd_funding: ['Funding rate (annualized)', 'Perpetual futures have no expiry; instead longs and shorts pay each other every 1–8 hours to keep the price near spot. Positive = longs pay shorts (more people are long with leverage). We convert it to % per year so venues with different intervals compare fairly. About +11%/yr is the normal default.', null, 'Perps'],
    pd_z: ['Funding z-score', 'How unusual today\'s funding is for THIS coin: how many standard deviations it sits from its own average over the last 30 days. Above +2 or below −2 is rare for that coin.', null, 'Perps'],
    pd_oi: ['Open interest (OI) & 24h change', 'Total value of open perp positions across venues. Rising OI with extreme funding means new leveraged positions are piling into the crowded side — more fuel for a squeeze.', null, 'Perps'],
    pd_spread: ['Cross-venue spread', 'Difference between the highest and lowest funding across exchanges. A big gap means one venue is much more crowded than the others.', null, 'Perps'],
    pd_composite: ['Composite grade (A–F)', 'One grade that blends crash-pattern odds, launch/pump footprint, rug forecast, sleeper and moonshot scores, macro calendar, perp funding/OI and token unlocks. Each factor is scored 0–100 (50 = neutral); missing factors are skipped. A = best risk-adjusted long-side setup in our model. Tap a row for the breakdown.', null, 'Perps'],
    pd_lev: ['Suggested max leverage', 'Conservative cap so that a 1.5× ATR move (a bigger-than-normal day) does not liquidate you: 1 / (1.5 × ATR% + maintenance margin + fees), never above 5×. Lower is safer.', null, 'Perps'],
    pd_atr: ['ATR (average true range)', 'The average daily price range over the last 14 days, as % of price. It is the "normal day" size; stops closer than about 1× ATR get hit by noise.', null, 'Perps'],
    pd_liq: ['Liquidation price', 'Approximate price at which an isolated-margin position at the suggested leverage is force-closed and the margin is lost (entry × (1 ∓ 1/leverage ± maintenance)). Your stop must trigger well before it.', null, 'Perps'],
    pd_fcost: ['Funding cost per day', 'What holding the position costs (or pays you) per day at the current funding rate, as % of position size and in $ per $1,000 of margin at the suggested leverage. Negative = you receive funding.', null, 'Perps'],
    pd_unlock: ['Token unlocks', 'Tokens that were locked (team, investors, airdrop, ecosystem funds) and become sellable on a schedule. Big releases relative to circulating supply often bring selling pressure around the date. We weight team/investor unlocks more heavily and nearer dates more strongly.', null, 'Perps'],
    pd_net: ['Net supply change', 'Tokens added by unlocks minus tokens removed by buy-back-and-burn over each window. Positive = supply grows (dilution); negative = supply shrinks.', null, 'Perps'],
  });
  const css = document.createElement('style');
  css.textContent = `body[data-view=command] #viewCommand{overflow-y:auto}#viewCommand .ccGrid{min-height:calc(100vh - 240px)}
  #perpDesk{flex:none;height:72vh;min-height:420px}#perpDesk .pbody{overflow:auto;flex:1;min-height:0}
  .pdx td{white-space:normal;background:#0d131c;font-size:11px;color:#c3ccd8;padding:6px 10px}.pdx .fac{display:grid;grid-template-columns:150px 60px 46px 1fr;gap:2px 8px;align-items:start;padding:2px 0;border-bottom:1px solid #141c27;cursor:pointer}
  .pdx .fac .ex{grid-column:1/-1;display:none;color:#e6edf6;padding:2px 0 4px 8px}.pdx .fac.open .ex{display:block}.pdx .fac.na{color:#5d6878;cursor:default}
  .pdbar{display:inline-block;width:46px;height:6px;background:#1a2230;border-radius:3px;vertical-align:middle}.pdbar i{display:block;height:100%;border-radius:3px}
  .pdflag{display:inline-block;font-size:9px;padding:0 4px;border-radius:2px;margin-right:2px;border:1px solid}.pdflag.extreme{color:#ff6b6b;border-color:#6a1f27}.pdflag.high{color:#ff9f50;border-color:#5a3313}.pdflag.watch{color:#e8c64c;border-color:#4a4313}
  .pdwarn{color:#ffcf9a}.pdven{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:4px 0}.pdven div{border:1px solid var(--line);border-radius:4px;padding:4px 6px;font-size:11px}.pdven .ok{border-color:#14432c}.pdven .bad{border-color:#5a1f27}
  #pdTabs{border-bottom:0;padding:0 4px}.pdnote{color:var(--mut);font-size:10.5px;padding:3px 0}`;
  document.head.appendChild(css);

  let P = null, C = null, U = null, tab = 'flags', open = new Set(), loading = false;
  function wlParam() {
    try { return (typeof watch !== 'undefined' ? watch : []).map(([c, a]) => { const t = (typeof tokenData !== 'undefined' && tokenData[`${c}:${a}`]) || {}; return t.symbol ? `${encodeURIComponent(t.symbol)}:${t.priceUsd || ''}` : null; }).filter(Boolean).join(','); } catch { return ''; }
  }
  async function load() {
    if (loading) return; loading = true;
    try {
      const [p, c, u] = await Promise.allSettled([api('/api/perps?wl=' + wlParam()), api('/api/composite'), api('/api/unlocks')]);
      if (p.status === 'fulfilled') P = p.value; if (c.status === 'fulfilled') C = c.value; if (u.status === 'fulfilled') U = u.value;
      if (!P && p.status === 'rejected') Q('#pdBody').innerHTML = `<div class="empty">${esc(p.reason?.message || 'perp data unavailable')}</div>`;
      render();
    } finally { loading = false; }
  }
  function meta() {
    if (!P) return '';
    const ok = Object.entries(P.venues).filter(([, v]) => v.ok).map(([k]) => k), bad = Object.entries(P.venues).filter(([, v]) => !v.ok).map(([k]) => k);
    return `${P.matched} perps · venues ✓ ${ok.join(', ')}${bad.length ? ' · ✗ ' + bad.join(', ') : ''} · ${P.flaggedCount} flagged · updated ${new Date(P.generatedAt).toLocaleTimeString()}`;
  }
  function flagChips(t) { return (t.flags || []).map((f) => `<span class="pdflag ${esc(f.level)}">${esc(f.kind.replace('_', ' '))}</span>`).join(''); }
  function venueRows(t) { return `<table class="tbl"><thead><tr><th>Venue</th><th>Contract</th><th class="r">Mark</th><th class="r">Index</th><th class="r">Funding/int.</th><th class="r">Ann.</th><th class="r">z (30d)</th><th class="r">OI</th><th class="r">Vol 24h</th></tr></thead><tbody>${t.venues.map((v) => `<tr><td>${esc(v.venue)}</td><td>${esc(v.contract)}</td><td class="r">${px(v.mark)}</td><td class="r">${px(v.index)}</td><td class="r">${v.rate != null ? (v.rate * 100).toFixed(4) + '%/' + v.intervalH + 'h' : '—'}</td><td class="r ${cls(v.fAnn)}">${pct(v.fAnn, 1)}</td><td class="r">${v.z != null ? v.z.toFixed(1) : '—'}</td><td class="r">${usd(v.oiUsd)}</td><td class="r">${usd(v.vol24Usd)}</td></tr>`).join('')}</tbody></table>`; }
  function renderFlags() {
    const T = (P?.tokens || []).filter((t) => t.flags.length).sort((a, b) => Math.abs(b.fAnn) - Math.abs(a.fAnn));
    const rest = (P?.tokens || []).filter((t) => !t.flags.length).slice(0, 25);
    const cBy = new Map((C?.tokens || []).filter((t) => t.kind === 'perp').map((t) => [t.sym, t]));
    const row = (t) => `<tr data-o="f:${esc(t.sym)}"><td class="tok"><b>${esc(t.sym)}</b></td><td>${G(cBy.get(t.sym)?.grade)}</td><td class="r">${px(t.mark)}</td><td class="r ${cls(t.ch24)}">${pct(t.ch24)}</td><td class="r ${cls(t.fAnn)}"><b>${pct(t.fAnn, 0)}</b></td><td class="r">${t.z != null ? t.z.toFixed(1) : '—'}</td><td class="r">${t.spread != null ? t.spread.toFixed(0) + '%' : '—'}</td><td class="r">${usd(t.oiUsd)}</td><td class="r ${cls(t.oiCh24)}">${pct(t.oiCh24, 0)}</td><td>${t.venues.length}</td><td>${flagChips(t)}</td></tr>${open.has('f:' + t.sym) ? `<tr class="pdx"><td colspan="11">${t.flags.map((f) => `<div>• ${esc(f.text)}</div>`).join('') || '<div>No funding extremes.</div>'}${venueRows(t)}<div class="pdnote">z-score source: ${esc(t.zSrc || 'n/a')} · OI change: ${esc(t.oiChSrc || 'n/a')}${t.stats ? ` · ATR14 ${t.stats.atrPct.toFixed(1)}% (${esc(t.stats.candles)} daily candles)` : ''}</div></td></tr>` : ''}`;
    return `<table class="tbl"><thead><tr><th>Token</th><th>Gr ${ix('pd_composite')}</th><th class="r">Mark</th><th class="r">24h</th><th class="r">Funding/yr ${ix('pd_funding')}</th><th class="r">z ${ix('pd_z')}</th><th class="r">Spread ${ix('pd_spread')}</th><th class="r">OI ${ix('pd_oi')}</th><th class="r">OI 24h</th><th>#V</th><th>Flags</th></tr></thead><tbody>
      ${T.map(row).join('') || '<tr><td colspan="11" class="empty">No funding extremes right now.</td></tr>'}
      <tr><td colspan="11" class="muted small" style="padding-top:8px">Largest perp markets in the universe (no flag)</td></tr>${rest.map(row).join('')}</tbody></table>`;
  }
  function renderSetups() {
    const S = P?.setups || [];
    return `<div class="pdnote">Setups are triggered by crowded funding (squeeze / fade) or a composite A/B grade with neutral funding. Entry zone ±0.5 ATR, stop 1.2 ATR, targets 1.5 / 3 ATR. <b>Not financial advice.</b> Leverage magnifies losses; a stop is not guaranteed in a fast market.</div>
    <table class="tbl"><thead><tr><th>Token</th><th>Side</th><th>Type</th><th>Gr</th><th class="r">Entry zone</th><th class="r">Max lev ${ix('pd_lev')}</th><th class="r">Stop</th><th class="r">TP1 / TP2</th><th class="r">Liq. ${ix('pd_liq')}</th><th class="r">ATR ${ix('pd_atr')}</th><th class="r">Funding/day ${ix('pd_fcost')}</th><th>Warnings</th></tr></thead><tbody>${S.map((s) => `<tr data-o="s:${esc(s.sym)}"><td class="tok"><b>${esc(s.sym)}</b></td><td class="${s.side === 'long' ? 'up' : 'dn'}"><b>${esc(s.side.toUpperCase())}</b></td><td class="small">${esc(s.type)}</td><td>${G(s.grade)}</td><td class="r">${px(s.entryZone[0])}–${px(s.entryZone[1])}</td><td class="r"><b>${s.maxLeverage}×</b></td><td class="r">${px(s.stop)} <span class="muted">(${s.stopPct}%)</span></td><td class="r">${px(s.tp1)} / ${px(s.tp2)}</td><td class="r">${px(s.liquidation)} <span class="muted">(${s.liqDistPct}%)</span></td><td class="r">${s.atrPct}%</td><td class="r ${s.funding.perDayPctOfNotional > 0 ? 'dn' : 'up'}">${s.funding.perDayPctOfNotional.toFixed(3)}% · $${s.funding.usdPerDayPer1kMargin}</td><td class="small pdwarn">${s.warnings.length} ⚠</td></tr>${open.has('s:' + s.sym) ? `<tr class="pdx"><td colspan="12"><b>Why:</b> ${s.why.map(esc).join(' ')}<br><b>Plan (per $1,000 margin at ${s.maxLeverage}×, $${(1000 * s.maxLeverage).toLocaleString()} position):</b> ${s.side === 'long' ? 'buy' : 'sell'} between ${px(s.entryZone[0])} and ${px(s.entryZone[1])}; stop at ${px(s.stop)} (≈ $${Math.round(1000 * s.maxLeverage * Math.abs(s.stopPct) / 100)} loss); take half at ${px(s.tp1)} (+${s.tpPct[0]}%), rest at ${px(s.tp2)} (+${s.tpPct[1]}%). Liquidation ≈ ${px(s.liquidation)}. A stop-out costs ≈ ${Math.round(s.maxLeverage * Math.abs(s.stopPct))}% of the margin, so size the margin so that loss is no more than 1–2% of your account (e.g. $${Math.round(10000 * 0.015 / (s.maxLeverage * Math.abs(s.stopPct) / 100))} margin on a $10,000 account). Funding: ${esc(s.funding.note)} ${Math.abs(s.funding.perDayPctOfNotional).toFixed(3)}%/day ≈ $${Math.abs(s.funding.usdPerDayPer1kMargin)}/day.<br><span class="muted">${esc(s.leverageRule)}</span><br>${s.warnings.map((w) => `<div class="pdwarn">⚠ ${esc(w)}</div>`).join('')}<div class="muted">${esc(s.nfa)}</div></td></tr>` : ''}`).join('') || '<tr><td colspan="12" class="empty">No setup passes the filters right now (no crowded funding with usable volatility data).</td></tr>'}</tbody></table>`;
  }
  const bar = (s) => `<span class="pdbar"><i style="width:${s}%;background:${s >= 60 ? '#4ff09a' : s >= 45 ? '#f3c84a' : '#ff6b6b'}"></i></span>`;
  function renderComposite() {
    const T = (C?.tokens || []).slice(0, 120);
    return `<div class="pdnote">${ix('pd_composite')} ${esc(C?.grading || '')} · Pattern detectors: ${esc(C?.patterns?.status || 'n/a')} · Macro: ${esc(C?.macro?.near?.length ? C.macro.near.map((x) => x.label + ' ' + x.date).join(', ') : 'no event within ' + (C?.macro?.N || 3) + ' days')}</div>
    <table class="tbl"><thead><tr><th>Gr</th><th class="r">Score</th><th>Token</th><th>Kind</th><th>Factors (score)</th><th>Warnings</th></tr></thead><tbody>${T.map((t) => `<tr data-o="c:${esc(t.id)}"><td>${G(t.grade)}</td><td class="r">${t.score}</td><td class="tok"><b>${esc((t.sym || '?').slice(0, 12))}</b></td><td class="small">${esc(t.kind)}${t.chain ? ' · ' + esc(t.chain) : ''}</td><td class="small">${t.factors.filter((f) => f.available !== false && (f.adj == null || f.adj)).map((f) => f.adj != null ? `<span class="dn">${esc(f.label.split(' ')[0])} ${f.adj}</span>` : `${esc(f.label.split(' ')[0])} ${f.score}`).join(' · ')}</td><td class="small pdwarn">${esc([...(t.caps || []), ...(t.warnings || [])].join(' · '))}</td></tr>${open.has('c:' + t.id) ? `<tr class="pdx"><td colspan="6"><div><b>${esc(t.summary)}</b></div><div class="muted small">Tap a factor for the plain-English explanation.</div>${t.factors.map((f) => f.available === false ? `<div class="fac na"><span>${esc(f.label)}</span><span>—</span><span></span><span>no data for this token</span></div>` : `<div class="fac"><span>${esc(f.label)}</span>${f.adj != null ? `<span class="${f.adj < 0 ? 'dn' : ''}">${f.adj > 0 ? '+' : ''}${f.adj} pts</span><span class="muted">penalty</span>` : `<span>${bar(f.score)} ${f.score}</span><span class="muted">×${f.weight}</span>`}<span>${esc(f.value || '')}${f.cap ? ` <span class="pdflag high">caps at ${esc(f.cap)}</span>` : ''}</span><div class="ex">${esc(f.explain)}</div></div>`).join('')}<div class="muted small">${esc(C.nfa)}</div></td></tr>` : ''}`).join('') || '<tr><td colspan="6" class="empty">composite warming up…</td></tr>'}</tbody></table>`;
  }
  function renderUnlocks() {
    const T = U?.tokens || []; const N = U?.netSupply;
    const nrows = (N?.tokens || []).filter((t) => t.hasBurn || (t.windows?.['1y']?.unlockPctCirc || 0) > 0).slice(0, 40);
    return `<div class="pdnote">${ix('pd_unlock')} Next 30 days, catalog + watchlist tokens. Source: ${esc(U?.source || '—')}. Paid/blocked (not used): ${esc(Object.keys(U?.notUsed || {}).join(', '))}.</div>
    <table class="tbl"><thead><tr><th>Token</th><th>Level</th><th class="r">30d % circ</th><th class="r">30d tokens</th><th class="r">30d USD</th><th>Next cliff dates (% circ, USD)</th><th>Warning</th></tr></thead><tbody>${T.map((u) => `<tr data-o="u:${esc(u.sym)}"><td class="tok"><b>${esc(u.sym)}</b> <span class="muted small">${esc(u.name || '')}</span></td><td>${u.level ? `<span class="pdflag ${u.level === 'major' ? 'extreme' : u.level === 'notable' ? 'high' : 'watch'}">${esc(u.level)}</span>` : '<span class="muted">small</span>'}</td><td class="r">${u.pct30 != null ? u.pct30.toFixed(2) + '%' : '—'}</td><td class="r">${u.tokens30 != null ? Math.round(u.tokens30).toLocaleString() : '—'}</td><td class="r">${usd(u.usd30)}</td><td class="small">${u.dates.slice(0, 3).map((d) => `${esc(d.date)} ${d.pctCirc.toFixed(2)}% ${usd(d.usd)} (${esc(d.categories.join('/'))})`).join(' · ') || 'linear vesting only'}${u.dates.length > 3 ? ` · +${u.dates.length - 3} more` : ''}</td><td class="small pdwarn">${esc(u.warn || '')}</td></tr>${open.has('u:' + u.sym) ? `<tr class="pdx"><td colspan="7">${esc(u.text)} <a href="${esc(u.url)}" target="_blank" rel="noopener">schedule ↗</a></td></tr>` : ''}`).join('') || '<tr><td colspan="7" class="empty">No catalog/watchlist token has unlocks in the next 30 days.</td></tr>'}</tbody></table>
    <div class="pdnote" style="margin-top:8px">${ix('pd_net')} Net supply = unlocks − buy-back burns · ${esc(N?.status || '')}</div>
    <table class="tbl"><thead><tr><th>Token</th>${(N?.windows || []).map((w) => `<th class="r">${esc(w)}</th>`).join('')}<th>Summary</th></tr></thead><tbody>${nrows.map((t) => `<tr><td class="tok"><b>${esc(t.sym)}</b></td>${N.windows.map((w) => { const x = t.windows[w] || {}; const v = x.netPctCirc != null ? x.netPctCirc : x.unlockPctCirc; return `<td class="r ${v > 0 ? 'dn' : v < 0 ? 'up' : ''}">${v != null ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—'}</td>`; }).join('')}<td class="small">${esc(t.text)}</td></tr>`).join('')}</tbody></table>`;
  }
  function renderVenues() {
    if (!P) return '';
    return `<div class="pdven">${Object.entries(P.venues).map(([k, v]) => `<div class="${v.ok ? 'ok' : 'bad'}"><b>${v.ok ? '✓' : '✗'} ${esc(v.name)}</b><br>${v.ok ? `${v.n} USDT perps · via ${esc(v.route || '')}` : esc(v.error || 'unavailable')}${v.note ? `<br><span class="muted">${esc(v.note)}</span>` : ''}</div>`).join('')}</div>
    <div class="pdnote">Universe: ${P.universe} catalog/sleeper/watchlist symbols → ${P.matched} with at least one USDT perp (ticker matched and price cross-checked vs catalog price and across venues). Live snapshot every 2 min; funding baselines and ATR from research/perps.py (${P.statsAt ? 'updated ' + new Date(P.statsAt).toLocaleString() : 'pending'}). Bybit and Binance's fapi.binance.com are geo-blocked from this server (US): Binance is read through the www.binance.com/fapi mirror; Bybit is reported unavailable and Gate.io is added as an extra free venue.</div>`;
  }
  function render() {
    const b = Q('#pdBody'); if (!b) return;
    Q('#pdMeta').textContent = meta();
    b.innerHTML = tab === 'flags' ? renderFlags() : tab === 'setups' ? renderSetups() : tab === 'composite' ? renderComposite() : tab === 'unlocks' ? renderUnlocks() : renderVenues();
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('#pdTabs button'); if (t) { tab = t.dataset.t; document.querySelectorAll('#pdTabs button').forEach((x) => x.classList.toggle('on', x === t)); render(); return; }
    if (e.target.closest('#pdBody .ix') || e.target.closest('#pdBody a')) return;
    const fac = e.target.closest('#pdBody .fac'); if (fac && !fac.classList.contains('na')) { fac.classList.toggle('open'); return; }
    const r = e.target.closest('#pdBody tr[data-o]'); if (r) { const k = r.dataset.o; open.has(k) ? open.delete(k) : open.add(k); render(); }
    if (e.target.id === 'pdJump') Q('#perpDesk')?.scrollIntoView({ behavior: 'smooth' });
  });
  function init() {
    if (!Q('#perpDesk')) return;
    const top = Q('.ccTop'); if (top && !Q('#pdJump')) { const j = document.createElement('button'); j.id = 'pdJump'; j.className = 'btn ghost mini2'; j.textContent = 'Perp Desk ↓'; top.appendChild(j); }
    load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 120e3);
  }
  window.perpDeskLoad = load;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
