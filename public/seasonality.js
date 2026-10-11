// Session seasonality panel (Command view): /api/seasonality. Additive; injects its own panel after PATTERN DETECTORS.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const X = (x) => (x == null ? '–' : (+x).toFixed(2) + '×');
  const Q = (q) => (q == null ? '–' : q < 0.001 ? '<0.001' : (+q).toFixed(3));
  const ST = { volatile: '<span class="dn">volatile</span>', quiet: '<span class="up">quiet</span>', normal: '<span class="muted">normal</span>', unknown: '<span class="muted">n/a</span>' };
  const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`);
  function mount() {
    if (document.querySelector('#ccSeason')) return document.querySelector('#ccSeason');
    const anchor = document.querySelector('#ccPatterns'); const host = anchor ? anchor.closest('.panel') : null;
    const div = document.createElement('div'); div.className = 'panel';
    div.innerHTML = '<div class="phead"><span>SESSION TIMING <span class="muted small">Asia · London · US open/close · weekends · holidays (DST-correct)</span></span></div><div id="ccSeason" class="pbody scroll"></div>';
    if (host && host.parentNode) host.parentNode.insertBefore(div, host.nextSibling); else (document.querySelector('#view-command') || document.body).appendChild(div);
    return div.querySelector('#ccSeason');
  }
  async function render() {
    const box = mount(); if (!box) return;
    let d; try { d = await api('/api/seasonality'); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return; }
    const lv = d.live || {}; if (!lv.ok) { box.innerHTML = `<div class="empty">${E(lv.error || 'not generated yet')}</div>`; return; }
    const c = lv.clock || {}; let h = '';
    h += `<div class="small"><b>Right now:</b> ${(c.activeLabels || []).filter((l) => !/UTC day\)$/.test(l)).map(E).join(' · ') || 'no named session (off-hours)'}</div>`;
    h += `<div class="small muted"><b>Coming up:</b> ${(c.next || []).map((x) => `${E(x.label)} in ${mins(x.inMin)}`).join(' · ')}</div>`;
    const pm = lv.pooledMajors || {}, pc = lv.pooledCatalog || {};
    h += `<div class="small"><b>Majors (pooled):</b> ${ST[pm.verdict] || ''} — ${E(pm.text)}</div>`;
    h += `<div class="small"><b>New launches (pooled catalog):</b> ${ST[pc.verdict] || ''} — ${E(pc.text)}</div>`;
    const flagged = (lv.majors || []).filter((m) => m.verdict !== 'normal');
    if (flagged.length) h += `<div class="small"><b>Per-coin:</b> ${flagged.map((m) => `${E(m.sym)} ${ST[m.verdict]} ${m.top ? `(${X(m.top.vol_ratio)}${m.top.inMin != null ? ', in ' + m.top.inMin + 'm' : ''})` : ''}`).join(' · ')}</div>`;
    // history: biggest significant session effects, pooled majors
    const F = (d.findings || []).filter((f) => f.scope !== 'catalog_dex_pooled' && f.state !== 'normal' && !/^dow_/.test(f.window));
    const best = {}; for (const f of F) if (!best[f.window] || f.scope === 'majors_5m_pooled') best[f.window] = f;
    const rows = Object.values(best).sort((a, b) => Math.abs(Math.log(b.vol_ratio)) - Math.abs(Math.log(a.vol_ratio))).slice(0, 8);
    if (rows.length) {
      h += '<table class="tbl"><tr><th>Window (history, majors)</th><th>Price swings vs rest</th><th>Big-move rate vs rest</th><th>Volume share vs time share</th><th>q</th></tr>';
      for (const f of rows) h += `<tr><td>${E(f.label)}</td><td>${ST[f.state]} ${X(f.vol_ratio)}</td><td>${X(f.tail_ratio)}</td><td>${f.volume_share != null ? (f.volume_share * 100).toFixed(1) + '% vs ' + (f.time_share * 100).toFixed(1) + '%' : '–'}</td><td>${Q(f.q)}</td></tr>`;
      h += '</table>';
    }
    const ev = (d.events || {}).crash_onsets_all || {};
    const hot = Object.entries(ev).filter(([, v]) => v.q_volume != null && v.q_volume < 0.1).sort((a, b) => a[1].q_volume - b[1].q_volume).slice(0, 4);
    const evN = Object.values(ev)[0]?.n;
    h += `<div class="small"><b>Do catalog crashes start in particular sessions?</b> ${evN ? `${evN} crash onsets tested vs each crash's own exposure: ` : ''}${hot.length ? hot.map(([k, v]) => `${E(k)} ${v.observed} vs ${v.expected_volume} expected (${X(v.ratio_volume)}, q=${Q(v.q_volume)})`).join(' · ') : 'no session clusters beyond chance after multiple-test correction'}</div>`;
    h += '<div class="small muted">“Price swings vs rest” = typical move size in the window ÷ outside it (regime-adjusted). Volatile/quiet only when the difference survives false-discovery correction (q&lt;0.05). Timing/risk hint only, not a signal. /api/seasonality · /api/seasonality/full</div>';
    box.innerHTML = h;
  }
  window.addEventListener('load', () => { render(); setInterval(render, 300e3); });
})();
