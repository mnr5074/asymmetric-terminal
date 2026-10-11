// Validation layer UI (additive): ranked alert strip at the top of the Command view (tap a card to explain), plus a collapsible
// VALIDATION panel with the cross-detector backtest scoreboard, the false-positive log (auto-labels, rolling precision, shadow
// mode, threshold proposals) and the PAPER trading desk. Data: /api/alerts/ranked, /api/backtest, /api/fplog, /api/paper.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const pct = (x, d = 0) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
  const num = (x, d = 2) => (x == null ? '—' : (+x).toFixed(d));
  const usd = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const ago = (t) => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
  const css = `
  #vaStrip{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;flex:none;scrollbar-width:thin}
  #vaStrip .va{flex:0 0 230px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--mut);border-radius:6px;padding:5px 7px;cursor:pointer;min-height:58px}
  #vaStrip .va:hover{border-color:var(--acc)} #vaStrip .va.on{outline:1px solid var(--acc)}
  #vaStrip .va.s-hard{border-left-color:var(--red);background:#1a0d11} #vaStrip .va.s-confluence{border-left-color:var(--acc2)} #vaStrip .va.s-high{border-left-color:#ff7a45} #vaStrip .va.s-medium{border-left-color:var(--amb)} #vaStrip .va.s-low{border-left-color:var(--blu)}
  #vaStrip .va .h{display:flex;gap:4px;align-items:center;font-size:11px} #vaStrip .va .t{font-size:10.5px;line-height:1.25;margin-top:2px;max-height:2.6em;overflow:hidden;color:var(--txt)}
  .vachip{font-size:9.5px;padding:0 4px;border-radius:3px;border:1px solid var(--line);color:var(--mut);text-transform:uppercase;white-space:nowrap}
  .vachip.proven{color:var(--grn);border-color:var(--grn)} .vachip.weak{color:var(--amb);border-color:var(--amb)} .vachip.untested{color:var(--mut)} .vachip.hard{color:#fff;background:var(--red);border-color:var(--red)} .vachip.exp{color:var(--acc);border-color:var(--acc)} .vachip.shadow{color:#aaa;border-style:dashed} .vachip.conf{color:#fff;background:var(--acc2);border-color:var(--acc2)}
  #vaExplain{flex:none;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:11px} #vaExplain.hidden{display:none} #vaExplain table td{padding:1px 6px 1px 0;vertical-align:top}
  #vaPanel .pbody{max-height:46vh;overflow:auto} .vapaper{display:inline-block;background:var(--amb);color:#000;font-weight:700;padding:0 6px;border-radius:3px;letter-spacing:1px}
  .vagrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px;margin:4px 0} .vagrid div{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:3px 6px} .vagrid b{display:block;font-size:13px}
  .vapos{color:var(--grn)} .vaneg{color:var(--red)}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const view = Q('#viewCommand'); if (!view) return;
  const top = view.querySelector('.ccTop');
  const strip = document.createElement('div'); strip.id = 'vaStrip'; strip.innerHTML = '<div class="muted small">ranking alerts…</div>';
  const exp = document.createElement('div'); exp.id = 'vaExplain'; exp.className = 'hidden';
  const panel = document.createElement('div'); panel.className = 'panel'; panel.id = 'vaPanel'; panel.style.flex = 'none';
  panel.innerHTML = `<div class="phead"><span>VALIDATION <span class="muted small">backtest scoreboard · false-positive log · <span class="vapaper">PAPER</span> trading</span></span><span><span id="vaTabs" class="subtabs" style="display:inline-flex;border:0"><button data-t="score" class="on">Scoreboard</button><button data-t="fp">FP log</button><button data-t="paper">Paper</button></span> <button id="vaToggle" class="btn ghost mini2">▸</button></span></div><div id="vaOut" class="pbody" style="display:none"></div>`;
  (top ? top.after(strip) : view.prepend(strip)); strip.after(exp); exp.after(panel);
  let R = null, sel = null, tab = 'score', open = false;

  const wl = () => (typeof watch !== 'undefined' ? watch : []).map(([c, a]) => c + ':' + a).join(',');
  async function loadRanked() {
    try { R = await api('/api/alerts/ranked?limit=30&wl=' + encodeURIComponent(wl())); } catch (e) { strip.innerHTML = `<div class="muted small">ranked alerts: ${esc(e.message)}</div>`; return; }
    renderStrip(); if (sel) renderExplain();
  }
  function card(r) {
    if (r.collapsed) return `<div class="va s-low" data-k="${esc(r.key)}"><div class="h"><b>+${r.count}</b> <span class="vachip">collapsed</span></div><div class="t muted">${esc(r.headline)}</div></div>`;
    const sev = r.severity; const chip = sev === 'hard' ? '<span class="vachip hard">HARD</span>' : sev === 'confluence' ? `<span class="vachip conf">${r.confluence}× agree</span>` : `<span class="vachip ${esc(r.tier)}">${esc(r.tier)}</span>`;
    return `<div class="va s-${esc(sev)}${sel === r.key ? ' on' : ''}" data-k="${esc(r.key)}"><div class="h"><span class="muted">#${r.rank}</span><b>${esc(r.symbol || r.key.slice(-6))}</b>${chip}${r.exposure ? `<span class="vachip exp">${esc(r.exposure)}</span>` : ''}<span class="muted" style="margin-left:auto">${esc(r.claim)} · ${ago(r.t)}</span></div><div class="t">${esc(r.headline.replace(/^[^:]+:\s*/, ''))}</div></div>`;
  }
  function renderStrip() {
    const items = R.items || []; strip.innerHTML = (items.length ? items.map(card).join('') + `<div class="va" style="flex-basis:200px;cursor:default"><div class="small muted">${R.signals} signals · ${R.shadowed} shadowed (${(R.shadowDetectors || []).map(esc).join(', ') || 'none'}) · confluence ×${R.confluenceMultiplier}</div><div class="small muted" style="margin-top:3px">Phone pumps: launch-model · A-grade paused (retrain)</div></div>` : '<div class="muted small">no ranked alerts right now</div>');
  }
  function renderExplain() {
    const r = (R?.items || []).find((x) => x.key === sel); if (!r) { exp.classList.add('hidden'); return; }
    if (r.collapsed) { exp.innerHTML = `<b>${esc(r.headline)}</b><div class="small muted">${(r.examples || []).map(esc).join(', ')}</div>`; exp.classList.remove('hidden'); return; }
    exp.innerHTML = `<div style="display:flex;justify-content:space-between"><b>#${r.rank} ${esc(r.symbol || '')} <span class="muted small">${esc(r.key)}</span></b><span class="small muted">rank score ${r.score} · ${r.price != null ? 'price ' + esc(r.price) : ''} <button class="btn ghost mini2" id="vaClose">✕</button></span></div>
      <ul class="small" style="margin:3px 0 4px 16px;padding:0">${(r.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.explain ? `<div class="small" style="margin-bottom:4px">${esc(r.explain)}</div>` : ''}
      <table class="small"><tr class="muted"><td>Detector</td><td>Status</td><td>Says</td><td>Evidence</td><td>Values vs thresholds</td></tr>${r.detectors.map((d) => `<tr><td><b>${esc(d.name)}</b></td><td><span class="vachip ${esc(d.status === 'shadow' ? 'shadow' : d.tier)}">${esc(d.status === 'shadow' ? 'shadow' : d.tier)}</span></td><td>${esc(d.claim)}</td><td>${esc(d.backtest)}<br><span class="muted">${esc(d.live)}</span></td><td class="muted">${esc(Object.entries(d.values || {}).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(3) : v}${d.thresholds?.[k] != null ? ' (≥' + d.thresholds[k] + ')' : ''}`).join(', '))}</td></tr>`).join('')}</table>
      <div class="small muted">Ranking: HARD flags always first; then confluence (3+ independent detector families); then severity × detector trust (backtest tier blended with live precision) × recency, boosted for portfolio/watchlist/paper exposure. Not financial advice.</div>`;
    exp.classList.remove('hidden'); const c = Q('#vaClose'); if (c) c.onclick = () => { sel = null; exp.classList.add('hidden'); renderStrip(); };
  }
  strip.addEventListener('click', (e) => { const c = e.target.closest('.va[data-k]'); if (!c) return; sel = sel === c.dataset.k ? null : c.dataset.k; renderStrip(); renderExplain(); if (!sel) exp.classList.add('hidden'); });

  // ---- panel ----
  const claimCell = (s) => !s ? '<td class="muted" colspan="5">—</td>' : `<td>${pct(s.precision)}</td><td>${s.lift != null ? num(s.lift) + '×' : s.auc != null ? 'AUC ' + num(s.auc) : '—'}</td><td>${s.median_lead_h != null ? (s.median_lead_h >= 48 ? Math.round(s.median_lead_h / 24) + 'd' : num(s.median_lead_h, 1) + 'h') : '—'}</td><td>${s.p != null ? (s.p < 0.001 ? '<.001' : num(s.p, 3)) : '—'}</td><td><span class="vachip ${esc(s.trust || 'untested')}">${esc((s.trust || '?')[0])}</span> <span class="muted">n${s.n_events ?? s.n_pos ?? '—'}</span></td>`;
  async function renderScore() {
    const d = await api('/api/backtest'); const u = d.universe || {};
    Q('#vaOut').innerHTML = `<div class="small">${d.detectors.length} detectors · tiers ${Object.entries(d.tiers).map(([k, v]) => `${k} ${v}`).join(' · ')} · shadow ${d.status.shadow.length} · series replay ${u.series_tokens} tokens (${u.labels?.crashed} crashed, ${u.pump_breakouts_3x} with a 3× breakout) · labelled events: ${Object.entries(u.events_labeled || {}).map(([k, v]) => `${v} ${k}`).join(', ')} · confluence (3+ independent flags) ${num(d.confluence.lift_ge3_vs_single)}× single-flag precision (n=${d.confluence.n_ge3})${d.confluence.live ? `, live ${d.confluence.live.hits}/${d.confluence.live.n}` : ''} · rebuilt ${ago(d.generatedAt)} ago</div>
      <table class="tbl small"><thead><tr><th>Detector</th><th>Claim</th><th>Status</th><th colspan="5">CRASH: precision · lift · lead · p · tier</th><th colspan="5">PUMP: precision · lift · lead · p · tier</th><th>fp/token-day</th><th>Live</th><th>Method</th></tr></thead><tbody>
      ${d.detectors.map((x) => `<tr title="${esc((x.definition || '') + ' | ' + (x.caveats || []).join(' | ') + ' | ' + (x.trust_why || ''))}"><td><b>${esc(x.name)}</b> <span class="muted">${esc(x.id)}</span></td><td>${esc(x.claim)}</td><td><span class="vachip ${x.status === 'shadow' ? 'shadow' : esc(x.trust)}">${x.status === 'shadow' ? 'shadow' : esc(x.trust)}</span>${x.rebuild ? ' <span class="muted">rebuild</span>' : ''}</td>${claimCell(x.crash)}${claimCell(x.pump)}<td>${num((x.crash || x.pump || {}).fp_per_token_day, 4)}</td><td>${x.live?.n ? `${x.live.hits}/${x.live.n} · ${num(x.live.rollingLift)}×` : '—'}</td><td class="muted">${esc(x.method)}</td></tr>`).join('')}</tbody></table>
      <div class="small muted">${esc(d.label)} Proven = leading, significant, adequate sample, real effect. Hover a row for definition and caveats.</div>`;
  }
  async function renderFp() {
    const d = await api('/api/fplog?limit=40'); const dets = Object.entries(d.detectors || {}).filter(([, v]) => v.n || v.status === 'shadow').sort((a, b) => (b[1].n || 0) - (a[1].n || 0));
    Q('#vaOut').innerHTML = `<div class="small">${d.counts.total} alerts logged · ${d.counts.pending} pending · ${d.counts.hit} hit · ${d.counts.miss} miss · auto-labels at ${d.rules.horizons.join(' / ')} (price, liquidity held, smart money via Nansen ≤${d.nansen.guardrails.dailyCap}/day & balance ≥${d.nansen.guardrails.minBalance}, CEX listing) · ingested live events ${d.ingest?.total ?? 0} (${d.ingest?.pumps ?? 0} pumps / ${d.ingest?.crashes ?? 0} rugs+crashes)</div>
      <table class="tbl small"><thead><tr><th>Detector</th><th>Status</th><th>Labelled</th><th>Precision</th><th>Rolling (7d half-life)</th><th>Lift vs live base</th><th>Smart followed</th><th>Liq held</th><th>CEX listed</th><th>Why</th></tr></thead><tbody>
      ${dets.map(([id, v]) => `<tr><td><b>${esc(id)}</b></td><td><span class="vachip ${v.status === 'shadow' ? 'shadow' : 'proven'}">${esc(v.status)}</span></td><td>${v.hits}/${v.n}</td><td>${pct(v.precision)}</td><td>${pct(v.rollingPrecision)} <span class="muted">n_eff ${num(v.ewN, 1)}</span></td><td>${num(v.rollingLift)}×</td><td>${pct(v.smartFollowRate)}</td><td>${pct(v.liqHeldRate)}</td><td>${pct(v.cexListRate)}</td><td class="muted">${esc(v.why || '')}</td></tr>`).join('')}</tbody></table>
      <div class="small"><b>Threshold proposals</b> ${d.proposals?.length ? d.proposals.map((p) => `${esc(p.detector)}.${esc(p.field)} ${esc(p.direction)} ${esc(p.proposed)} (was ${esc(p.current)}): precision ${pct(p.precisionNow)} → ${pct(p.precisionProposed)}, n=${p.n}, p=${p.p} — ${esc(p.note)}`).join('<br>') : '<span class="muted">none yet (needs ≥20 labelled alerts per detector)</span>'}</div>
      <table class="tbl small"><thead><tr><th>When</th><th>Token</th><th>Detector</th><th>Claim</th><th>Verdict</th><th>max/min since</th><th>1h</th><th>24h</th></tr></thead><tbody>${d.recent.map((a) => `<tr><td>${ago(a.t)}</td><td>${esc(a.symbol || a.key.slice(-6))}</td><td>${esc(a.detector)}${a.status === 'shadow' ? ' <span class="muted">(shadow)</span>' : ''}</td><td>${esc(a.claim)}</td><td>${esc(a.verdict)}${a.lateHit ? ' (late hit)' : ''}</td><td>${num(a.maxRetPct, 1)}% / ${num(a.minRetPct, 1)}%</td><td>${a.labels['1h'] ? `${num(a.labels['1h'].retPct, 1)}%` : '…'}</td><td>${a.labels['24h'] ? `${num(a.labels['24h'].retPct, 1)}% ${a.labels['24h'].hit ? '✓' : '✗'}` : '…'}</td></tr>`).join('')}</tbody></table>`;
  }
  async function renderPaper() {
    const d = await api('/api/paper'); const cls = (x) => (x > 0 ? 'vapos' : x < 0 ? 'vaneg' : '');
    Q('#vaOut').innerHTML = `<div><span class="vapaper">PAPER</span> <span class="small">${esc(d.nfa)}</span></div>
      <div class="vagrid"><div>Bankroll<b>${usd(d.bankroll)}</b></div><div>Equity<b class="${cls(d.pnlUsd)}">${usd(d.equity)}</b></div><div>P&amp;L<b class="${cls(d.pnlUsd)}">${usd(d.pnlUsd)} (${num(d.pnlPct, 1)}%)</b></div><div>Trades<b>${d.trades}</b></div><div>Win rate<b>${pct(d.winRate)}</b></div><div>Max drawdown<b>${num(d.maxDrawdownPct, 1)}%</b></div><div>Open<b>${d.open.length}/${d.config.maxOpen}</b></div><div>Risk / trade<b>${d.config.riskPct}%</b></div></div>
      <div class="small">Reset with bankroll: <input id="vaBank" value="${d.bankroll}" style="width:70px"> <button class="btn ghost mini2" id="vaReset">reset paper account</button> <span class="muted">skipped: ${esc(Object.entries(d.skipped || {}).map(([k, v]) => `${k} ${v}`).join(' · '))}</span></div>
      <table class="tbl small"><thead><tr><th>Open</th><th>Dir</th><th>Detector</th><th>Tier</th><th>Entry</th><th>Mark</th><th>Size</th><th>uP&amp;L</th><th>Stop</th><th>TP</th><th>Costs</th></tr></thead><tbody>${d.open.map((p) => `<tr><td><b>${esc(p.symbol)}</b> <span class="muted">${esc(p.venue)}</span></td><td>${esc(p.dir)}</td><td>${esc(p.detectorName)}</td><td>${esc(p.tier)}</td><td>${esc(p.entry.toPrecision(4))}</td><td>${esc(p.mark.toPrecision(4))}</td><td>${usd(p.notional)}</td><td class="${cls(p.uPnlUsd)}">${usd(p.uPnlUsd)}</td><td>${esc(p.stop.toPrecision(4))}</td><td>${p.tps.map((x) => x.toPrecision(3)).join(' / ')}</td><td class="muted">fee ${usd(p.costs.entryFeeUsd)} · slip ${num(p.costs.entrySlipPct, 2)}%</td></tr>`).join('') || '<tr><td colspan="11" class="muted">no open paper positions</td></tr>'}</tbody></table>
      <table class="tbl small"><thead><tr><th>By detector</th><th>Trades</th><th>Win</th><th>P&amp;L</th></tr></thead><tbody>${d.byDetector.map((x) => `<tr><td>${esc(x.detector)}</td><td>${x.trades}</td><td>${pct(x.winRate)}</td><td class="${cls(x.pnlUsd)}">${usd(x.pnlUsd)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">no closed trades yet</td></tr>'}</tbody></table>
      <table class="tbl small"><thead><tr><th>By grade</th><th>Trades</th><th>Win</th><th>P&amp;L</th></tr></thead><tbody>${d.byGrade.map((x) => `<tr><td>${esc(x.grade)}</td><td>${x.trades}</td><td>${pct(x.winRate)}</td><td class="${cls(x.pnlUsd)}">${usd(x.pnlUsd)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
      <table class="tbl small"><thead><tr><th>Closed</th><th>Dir</th><th>Detector</th><th>P&amp;L</th><th>Why</th></tr></thead><tbody>${d.closed.slice(0, 15).map((c) => `<tr><td>${esc(c.symbol)} <span class="muted">${ago(c.closed)}</span></td><td>${esc(c.dir)}</td><td>${esc(c.detectorName)}</td><td class="${cls(c.pnlUsd)}">${usd(c.pnlUsd)} (${num(c.pnlPct, 1)}%)</td><td class="muted">${esc(c.why)}</td></tr>`).join('')}</tbody></table>`;
    const b = Q('#vaReset'); if (b) b.onclick = async () => { if (!confirm('Reset the PAPER account? (hypothetical only)')) return; await api('/api/paper?reset=1&bankroll=' + encodeURIComponent(Q('#vaBank').value)); renderPaper(); };
  }
  async function renderPanel() { if (!open) return; try { await (tab === 'score' ? renderScore() : tab === 'fp' ? renderFp() : renderPaper()); } catch (e) { Q('#vaOut').innerHTML = `<div class="empty">${esc(e.message)}</div>`; } }
  Q('#vaToggle').onclick = () => { open = !open; Q('#vaOut').style.display = open ? '' : 'none'; Q('#vaToggle').textContent = open ? '▾' : '▸'; renderPanel(); };
  Q('#vaTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (!b) return; tab = b.dataset.t; Q('#vaTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); if (!open) Q('#vaToggle').click(); else renderPanel(); });
  loadRanked(); setInterval(() => { if (document.body.dataset.view === 'command') { loadRanked(); if (tab !== 'score') renderPanel(); } }, 30000);
  window.vaOpen = (t) => { tab = t || 'score'; Q('#vaTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.t === tab)); if (!open) Q('#vaToggle').click(); else renderPanel(); };
})();
