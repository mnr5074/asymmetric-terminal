// PATTERN LAB panel (Command view): /api/patternlab. 37 patterns: status, backtest (crashed vs runners, both directions), live flags,
// tap a row for the plain-English explanation, rule, caveats and the tokens flagged right now. Additive; injects its own panel.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const pv = (p) => (p == null ? '–' : p < 0.001 ? '<.001' : (+p).toFixed(3));
  const hl = (h) => (h == null ? '–' : (h >= 0 ? '' : '−') + Math.abs(h).toFixed(1) + 'h');
  const ST = { built: '<span class="up">built</span>', wrapped: '<span class="muted">wrapped</span>', partial: '<span class="warn">partial</span>', nf: '<span class="dn">n/f</span>' };
  const VC = (v) => (!v ? '<span class="muted">–</span>' : /crash-predictive/.test(v) ? `<span class="dn">${E(v)}</span>` : /pump-predictive/.test(v) ? `<span class="up">${E(v)}</span>` : /weak/.test(v) ? `<span class="warn">${E(v)}</span>` : `<span class="muted">${E(v)}</span>`);
  const open = new Set(); let last = null; let filter = 'all';
  function mount() {
    if (document.querySelector('#ccPatternLab')) return document.querySelector('#ccPatternLab');
    const anchor = document.querySelector('#ccSeason') || document.querySelector('#ccPatterns'); const host = anchor ? anchor.closest('.panel') : null;
    const div = document.createElement('div'); div.className = 'panel';
    div.innerHTML = '<div class="phead"><span>PATTERN LAB <span class="muted small">37 crash / pump patterns · backtest on 30 crashed + 20 runners · live flags · tap a row</span></span></div><div id="ccPatternLab" class="pbody scroll"></div>';
    if (host && host.parentNode) host.parentNode.insertBefore(div, host.nextSibling); else (document.querySelector('#view-command') || document.body).appendChild(div);
    div.addEventListener('click', (ev) => {
      const f = ev.target.closest('[data-plf]'); if (f) { filter = f.dataset.plf; draw(); return; }
      const r = ev.target.closest('tr[data-pl]'); if (!r) return; const id = +r.dataset.pl; open.has(id) ? open.delete(id) : open.add(id); draw();
    });
    return div.querySelector('#ccPatternLab');
  }
  function detail(r) {
    const b = r.backtest || {}; const d = r.details || {}; let h = `<div class="small"><b>${E(r.name)}</b> — ${E(r.explain)}</div>`;
    const rule = d.rule || d.variant_labelled_wallets?.rule; if (rule) h += `<div class="small muted"><b>Rule:</b> ${E(rule)}</div>`;
    h += `<div class="small"><b>Backtest:</b> fired before the peak on ${E(b.crashed || '–')} crashed tokens and ${E(b.runners || '–')} runners. As a <b>crash</b> signal p=${pv(b.p_crash)}, false-flag rate ${pct(b.false_flag_crash)}, median lead ${hl(b.lead_crash_h)} before the dump. As a <b>pump</b> signal p=${pv(b.p_pump)}, false-flag rate ${pct(b.false_flag_pump)}, median lead ${hl(b.lead_pump_h)} before the breakout.${b.untestable ? ` ${b.untestable} token(s) had no data for it.` : ''}</div>`;
    for (const k of ['note', 'caveat', 'not_feasible_free', 'coordination', 'reuse', 'side']) if (d[k]) h += `<div class="small muted">${E(k.replace(/_/g, ' '))}: ${E(typeof d[k] === 'string' ? d[k] : JSON.stringify(d[k]))}</div>`;
    if (d.variant_labelled_wallets?.stats) { const s = d.variant_labelled_wallets.stats; h += `<div class="small">Variant (all Nansen-labelled wallets): crashed ${s.flag_crashed}/${s.n_crashed}, runners ${s.flag_runners}/${s.n_runners}, p crash ${pv(s.p_crash_one_sided)}, p pump ${pv(s.p_pump_one_sided)} — ${E(s.verdict)}</div>`; }
    for (const k of ['variant_accumulation_early_entry', 'variant_bullish_absorption']) if (d[k]?.stats) { const s = d[k].stats; h += `<div class="small">${E(k.replace(/_/g, ' '))}: crashed ${s.flag_crashed}/${s.n_crashed}, runners ${s.flag_runners}/${s.n_runners}, p pump ${pv(s.p_pump_one_sided)}, lead ${hl(s.lead_pump_h_median)} — ${E(s.verdict)}</div>`; }
    if (d.chosen_floor) h += `<div class="small"><b>Chosen floor:</b> liquidity ≥ ${Math.round(d.chosen_floor.floor * 100)}% of market cap — below it ${pct(d.chosen_floor.rug_rate_below)} rugged vs ${pct(d.chosen_floor.rug_rate_above)} above (n below=${d.chosen_floor.below_n}, p=${pv(d.chosen_floor.p_fisher)}); ran 2x: ${pct(d.chosen_floor.ran2x_rate_below)} vs ${pct(d.chosen_floor.ran2x_rate_above)}.</div>`;
    if (d.catalog?.stats) { const s = d.catalog.stats; h += `<div class="small">Full catalog (${E(d.catalog.source)}): crashes ${pct(s.hit_crashed)} vs runner breakouts ${pct(s.hit_runners)} (n=${s.n_crashed}/${s.n_runners}), p crash ${pv(s.p_crash_one_sided)}, p pump ${pv(s.p_pump_one_sided)}.</div>`; }
    if (d.features) h += '<div class="small">' + Object.entries(d.features).map(([k, v]) => `${E(k.replace(/_/g, ' '))}: catalog crash ${pct(v.catalog?.hit_crashed)} vs pump ${pct(v.catalog?.hit_runners)} (p ${pv(Math.min(v.catalog?.p_crash_one_sided ?? 1, v.catalog?.p_pump_one_sided ?? 1))})`).join(' · ') + '</div>';
    if (d.supplementary_full_db) { const s = d.supplementary_full_db; h += `<div class="small muted">Full research DB: died ${s.died.flagged}/${s.died.n}, runners ${s.mooned.flagged}/${s.mooned.n} (p=${pv(s.p_fisher)})</div>`; }
    const it = r.live?.items || []; h += `<div class="small"><b>Live now (${r.live?.count || 0}):</b> ${it.length ? it.slice(0, 12).map((x) => `${E(x.sym || (x.key || '').slice(0, 14))}${x.value ? ' — ' + E(String(x.value).slice(0, 90)) : ''}${x.dir === 'pump' ? ' <span class="up">↑</span>' : ''}`).join(' · ') : 'nothing flagged'}</div>`;
    h += `<div class="small muted">Reuses: ${E(r.reuse || '')}. Composite: ${r.cap ? `<b>hard cap ${r.cap}</b>${r.w ? ', ' : ''}` : ''}${r.w ? `${r.w} points when it fires` : r.cap ? '' : 'information only (0)'}.</div>`;
    return h;
  }
  function draw() {
    const box = mount(); const d = last; if (!box || !d) return;
    let rows = d.rows || [];
    if (filter === 'prio') rows = rows.filter((r) => r.prio); else if (filter === 'live') rows = rows.filter((r) => r.live?.count); else if (filter === 'edge') rows = rows.filter((r) => /predictive|weak/.test(r.backtest?.verdict || ''));
    const m = d.market || {}; const ab = m.altseason?.[1];
    let h = `<div class="small">${['all', 'prio', 'live', 'edge'].map((f) => `<button class="btn small${filter === f ? ' on' : ''}" data-plf="${f}">${{ all: 'All 37', prio: 'Priority', live: 'Firing now', edge: 'Has edge' }[f]}</button>`).join(' ')}
      <span class="muted"> Market: BTC 7d ${m.beta?.[1]?.btc_7d_ret != null ? (m.beta[1].btc_7d_ret * 100).toFixed(1) + '%' : '–'} · alt breadth ${ab?.alt_breadth_30d != null ? Math.round(ab.alt_breadth_30d * 100) + '%' : '–'} · stables min ${m.depeg?.[1]?.stable_min_now ?? '–'}</span></div>`;
    h += '<table class="tbl"><tr><th>#</th><th>Pattern</th><th>Status</th><th title="share of crashed tokens where it fired before the peak">Crashed</th><th title="share of runners where it fired before the peak">Runners</th><th title="Fisher one-sided p, crashed > runners">p crash</th><th title="Fisher one-sided p, runners > crashed">p pump</th><th title="median hours before the dump (crash) / breakout (pump)">Lead</th><th>Verdict</th><th>Live</th></tr>';
    for (const r of rows) {
      const b = r.backtest || {}; const lead = /pump/.test(b.verdict || '') ? b.lead_pump_h : b.lead_crash_h;
      h += `<tr data-pl="${r.id}" style="cursor:pointer"><td>${r.id}${r.prio ? '★' : ''}</td><td>${E(r.name)}${r.cap ? ` <span class="dn small">cap ${r.cap}</span>` : ''}</td><td>${ST[r.status] || E(r.status)}</td><td>${E(b.crashed || '–')}</td><td>${E(b.runners || '–')}</td><td>${pv(b.p_crash)}</td><td>${pv(b.p_pump)}</td><td>${hl(lead)}</td><td>${VC(b.verdict)}</td><td>${r.live?.count ? `<b>${r.live.count}</b>` : '<span class="muted">0</span>'}</td></tr>`;
      if (open.has(r.id)) h += `<tr><td></td><td colspan="9">${detail(r)}</td></tr>`;
    }
    h += '</table>';
    const nl = d.nansen?.ledger; h += `<div class="small muted">${E(d.nfa || '')} Backtest ${d.backtestAt ? new Date(d.backtestAt).toLocaleString() : 'n/a'} · live ${d.liveAt ? new Date(d.liveAt).toLocaleTimeString() : 'warming up'}${nl ? ` · Nansen credits used by the lab: ${nl.used}` : ''}. /api/patternlab</div>`;
    box.innerHTML = h;
  }
  async function render() {
    const box = mount(); if (!box) return;
    try { last = await api('/api/patternlab'); draw(); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; }
  }
  window.addEventListener('load', () => { render(); setInterval(render, 300e3); });
})();
