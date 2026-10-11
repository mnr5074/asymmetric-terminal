// PATTERN LAB — EXPANSION rows (rules 38+, categories A-J): /api/patternlab/ext. Same columns as the Pattern Lab table, rendered in
// its own block directly under #ccPatternLab inside the same panel (so the lab's own re-render never wipes it). Additive; self-contained.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const pv = (p) => (p == null ? '–' : p < 0.001 ? '<.001' : (+p).toFixed(3));
  const hl = (h) => (h == null ? '–' : (h >= 0 ? '' : '−') + Math.abs(h).toFixed(1) + 'h');
  const ST = { built: '<span class="up">built</span>', wrapped: '<span class="muted">wrapped</span>', partial: '<span class="warn">partial</span>', nf: '<span class="dn">n/f</span>' };
  const VC = (v) => (!v ? '<span class="muted">–</span>' : /crash-predictive/.test(v) ? `<span class="dn">${E(v)}</span>` : /pump-predictive/.test(v) ? `<span class="up">${E(v)}</span>` : /weak/.test(v) ? `<span class="warn">${E(v)}</span>` : `<span class="muted">${E(v)}</span>`);
  const open = new Set(); let last = null; let filter = 'all'; let tries = 0;
  function mount() {
    let box = document.querySelector('#ccPatternLabExt'); if (box) return box;
    const lab = document.querySelector('#ccPatternLab');
    const div = document.createElement('div'); div.className = 'pbody'; div.id = 'ccPatternLabExt';
    if (lab && lab.parentNode) lab.parentNode.insertBefore(div, lab.nextSibling);
    else {
      if (tries++ < 10) return null; // wait for the Pattern Lab panel to mount
      const p = document.createElement('div'); p.className = 'panel';
      p.innerHTML = '<div class="phead"><span>PATTERN LAB — EXPANSION <span class="muted small">rules 38+ · categories A–J</span></span></div>';
      p.appendChild(div); const anchor = document.querySelector('#ccPatterns'); const host = anchor ? anchor.closest('.panel') : null;
      if (host && host.parentNode) host.parentNode.insertBefore(p, host.nextSibling); else (document.querySelector('#view-command') || document.body).appendChild(p);
    }
    div.addEventListener('click', (ev) => {
      const f = ev.target.closest('[data-plxf]'); if (f) { filter = f.dataset.plxf; draw(); return; }
      const r = ev.target.closest('tr[data-plx]'); if (!r) return; const id = r.dataset.plx; open.has(id) ? open.delete(id) : open.add(id); draw();
    });
    return div;
  }
  function detail(r) {
    const b = r.pl.backtest || {}; let h = `<div class="small"><b>${E(r.name)}</b> — ${E(r.explain)}</div>`;
    h += `<div class="small muted"><b>Status:</b> ${E(r.status)} — ${E(r.status_why)}</div>`;
    if (r.pl.backtest) {
      h += `<div class="small"><b>Backtest (${E(b.set)}):</b> fired on ${E(b.crashed)} crashed and ${E(b.runners)} runners. As a <b>crash</b> signal p=${pv(b.p_crash)}, false-flag rate ${pct(b.false_flag_crash)}, median lead ${hl(b.lead_crash_h)} before the dump. As a <b>pump</b> signal p=${pv(b.p_pump)}, false-flag rate ${pct(b.false_flag_pump)}, median lead ${hl(b.lead_pump_h)} before the peak. BH q=${pv(b.q_bh)}.${b.untestable ? ` ${b.untestable} token(s) untestable.` : ''}</div>`;
      if (b.era_matched) h += `<div class="small muted">Era-matched (created ≥ 2026-09-09): crashed ${b.era_matched.flag_crashed}/${b.era_matched.n_crashed}, runners ${b.era_matched.flag_runners}/${b.era_matched.n_runners}, p=${pv(b.era_matched.p_fisher)} — ${E(b.era_matched.verdict)}</div>`;
    }
    if (r.other_set) h += `<div class="small muted">${E(r.other_set.set)} set: crashed ${E(r.other_set.crashed)}, runners ${E(r.other_set.runners)}, p crash ${pv(r.other_set.p_crash)}, p pump ${pv(r.other_set.p_pump)} — ${E(r.other_set.verdict)}</div>`;
    const it = r.pl.live.items || []; h += `<div class="small"><b>Live now (${r.pl.live.count}):</b> ${it.length ? it.map((x) => `${E(x.sym || (x.key || '').slice(0, 14))}${x.value ? ' — ' + E(String(x.value).slice(0, 90)) : ''}`).join(' · ') : 'nothing flagged'}</div>`;
    if ((r.wraps || []).length) h += `<div class="small muted">Reuses: ${E(r.wraps.join(', '))}</div>`;
    return h;
  }
  function draw() {
    const box = mount(); const d = last; if (!box || !d) return;
    let rows = d.rows || [];
    if (filter === 'live') rows = rows.filter((r) => r.pl.live.count); else if (filter === 'edge') rows = rows.filter((r) => /predictive|weak/.test(r.pl.backtest?.verdict || '')); else if (filter === 'robust') rows = rows.filter((r) => r.robust);
    let h = `<div class="small" style="margin-top:8px"><b>EXPANSION</b> <span class="muted">rules 38+ · categories A–J · ${d.rows.length} rows</span> ${['all', 'edge', 'robust', 'live'].map((f) => `<button class="btn small${filter === f ? ' on' : ''}" data-plxf="${f}">${{ all: 'All', edge: 'Has edge', robust: 'Robust', live: 'Firing now' }[f]}</button>`).join(' ')}</div>`;
    h += '<table class="tbl"><tr><th>#</th><th>Pattern</th><th>Status</th><th title="flagged crashed / tested crashed">Crashed</th><th title="flagged runners / tested runners">Runners</th><th title="Fisher one-sided p, crashed > runners">p crash</th><th title="Fisher one-sided p, runners > crashed">p pump</th><th title="median hours before the dump (crash) / peak (pump)">Lead</th><th>Verdict</th><th>Live</th></tr>';
    for (const r of rows) {
      const b = r.pl.backtest || {}; const lead = /pump/.test(b.verdict || '') ? b.lead_pump_h : b.lead_crash_h; const id = String(r.id);
      h += `<tr data-plx="${E(id)}" style="cursor:pointer"><td>${E(id)}${r.robust ? '★' : ''}</td><td>${E(r.name)}</td><td>${ST[r.pl.status] || E(r.pl.status)}</td><td>${E(b.crashed || '–')}</td><td>${E(b.runners || '–')}</td><td>${pv(b.p_crash)}</td><td>${pv(b.p_pump)}</td><td>${hl(lead)}</td><td>${VC(b.verdict)}</td><td>${r.pl.live.count ? `<b>${r.pl.live.count}</b>` : '<span class="muted">0</span>'}</td></tr>`;
      if (open.has(id)) h += `<tr><td></td><td colspan="9">${detail(r)}</td></tr>`;
    }
    h += '</table>';
    const n = d.nansen || {}; h += `<div class="small muted">★ = robust (BH q&lt;0.10 and era-matched p&lt;0.10). Built ${d.generatedAt ? new Date(d.generatedAt).toLocaleString() : 'n/a'} · Nansen credits used by the expansion: ${n.credits_used ?? 0}. /api/patternlab/ext · PATTERN_LAB_EXT.md</div>`;
    box.innerHTML = h;
  }
  async function render() {
    const box = mount(); if (!box) { setTimeout(render, 1500); return; }
    try { last = await api('/api/patternlab/ext'); draw(); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; }
  }
  window.addEventListener('load', () => { setTimeout(render, 800); setInterval(render, 300e3); });
})();
