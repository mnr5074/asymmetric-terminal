// Data provenance UI (lib/provenance.js): Alt-click (desktop) or long-press (touch) any number in a panel -> where it came from:
// source, endpoint (no keys), chain / pair / block, fetched-at, as-of, age, cache hit vs fresh, transform. A small "src" link in each
// mapped panel header shows panel-level provenance. Also a key-health badge in the top bar (lib/keyhealth.js, /api/keyhealth).
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; if (!isFinite(s)) return ''; return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 172800 ? (s / 3600).toFixed(1) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const local = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  const css = document.createElement('style');
  css.textContent = `.provPop{position:fixed;z-index:9999;max-width:460px;min-width:280px;background:#0f141c;border:1px solid #3b4658;border-radius:6px;box-shadow:0 8px 30px #000a;padding:10px 12px;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#d7dde8}
.provPop h4{margin:0 0 6px;font-size:11px;color:#fff;display:flex;justify-content:space-between;gap:8px}.provPop .lv{padding:1px 6px;border-radius:3px;font-size:10px}
.provPop .lv.field{background:#14532d;color:#86efac}.provPop .lv.field-embedded{background:#1e3a5f;color:#93c5fd}.provPop .lv.file{background:#4a3b12;color:#fcd34d}.provPop .lv.none{background:#4c1d1d;color:#fca5a5}
.provPop table{border-collapse:collapse;width:100%}.provPop td{vertical-align:top;padding:1px 4px}.provPop td:first-child{color:#7d889b;white-space:nowrap}.provPop .u{word-break:break-all}.provPop a{color:#a78bfa}
.provPop .x{cursor:pointer;color:#7d889b}.provSrc{cursor:pointer;color:#7d889b;font-size:10px;border:1px solid #2a3342;border-radius:3px;padding:0 4px;margin-left:6px;user-select:none}.provSrc:hover{color:#c4b5fd;border-color:#6d5bd0}
.provHint{outline:1px dashed #8b5cf6 !important}.khBadge{white-space:nowrap;font-size:10px;border:1px solid #2a3342;border-radius:3px;padding:2px 6px;margin-left:6px;cursor:pointer;color:#7d889b;background:none}
.khBadge.green{color:#86efac}.khBadge.yellow{color:#fcd34d;border-color:#7c5e10}.khBadge.red{color:#fca5a5;border-color:#7f1d1d}`;
  document.head.appendChild(css);

  // ---- map panels -> routes: server inventory + "which api() call just rendered this DOM" heuristic ----
  let PANELS = [];
  let last = { path: null, t: 0 };
  if (typeof window.api === 'function') {
    const orig = window.api;
    window.api = async function (p) { const r = await orig.apply(this, arguments); try { last = { path: String(p).split('?')[0], t: Date.now() }; } catch {} return r; };
  }
  const mo = new MutationObserver((ms) => {
    if (!last.path || Date.now() - last.t > 400 || !/^\/api\//.test(last.path) || /^\/api\/(provenance|keyhealth)/.test(last.path)) return;
    for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (el && !el.closest('.provPop') && el.id !== 'search' && !el.dataset.provRoute) el.dataset.provRouteGuess = last.path; }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  function tagPanels() {
    for (const [id, , route] of PANELS) { const el = document.getElementById(id); if (!el) continue; el.dataset.provRoute = route; const panel = el.closest('.panel') || el; const head = panel.querySelector(':scope > .phead'); if (head && !head.querySelector('.provSrc')) { const b = document.createElement('span'); b.className = 'provSrc'; b.textContent = 'src'; b.title = 'Data provenance for this panel (Alt-click / long-press any number for field-level source)'; b.dataset.route = route; (head.firstElementChild || head).appendChild(b); } }
  }
  fetch('/api/provenance/coverage').then((r) => r.json()).then((d) => { PANELS = (d.detail || []).map((p) => [p.id, p.label, p.route]); tagPanels(); }).catch(() => {});
  setInterval(tagPanels, 4000);

  // ---- popover ----
  let pop = null;
  function close() { if (pop) { pop.remove(); pop = null; } document.querySelectorAll('.provHint').forEach((e) => e.classList.remove('provHint')); }
  function show(x, y, html) {
    close(); pop = document.createElement('div'); pop.className = 'provPop'; pop.innerHTML = html; document.body.appendChild(pop);
    const w = pop.offsetWidth, h = pop.offsetHeight; pop.style.left = Math.max(4, Math.min(x + 8, innerWidth - w - 6)) + 'px'; pop.style.top = Math.max(4, Math.min(y + 8, innerHeight - h - 6)) + 'px';
    pop.querySelector('.x')?.addEventListener('click', close);
  }
  const row = (k, v) => (v == null || v === '' ? '' : `<tr><td>${esc(k)}</td><td class="u">${v}</td></tr>`);
  function render(d, label) {
    const lv = d.level || 'none';
    const cache = d.cache ? `${esc(d.cache.state)}${d.cache.detail ? ' — ' + esc(d.cache.detail) : ''}` : '';
    const ven = (d.venues || []).map((v) => `${esc(v.venue)} ${esc(v.contract || '')}: ${v.fAnn != null ? (+v.fAnn).toFixed(2) + '%/yr ' : ''}${v.oiUsd != null ? 'OI $' + Math.round(v.oiUsd / 1e6) + 'M ' : ''}<span style="color:#7d889b">· ${esc(v.endpoint)} · fetched ${local(v.fetchedAt)} (${ago(v.fetchedAt)})</span>`).join('<br>');
    const files = (d.files || []).map((f) => `${esc(f.name)} · written ${local(f.mtime)} (${ago(f.mtime)})${f.generatedAt ? ' · generatedAt ' + local(f.generatedAt) : ''}`).join('<br>');
    const emb = (d.embedded || []).filter((e) => e.where !== '(root)').slice(0, 2).map((e) => esc(Object.entries(e).filter(([k]) => k !== 'where').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(', ') : v}`).join(' · '))).join('<br>');
    const val = d.value != null && typeof d.value !== 'object' ? esc(d.value) : d.factor ? esc(`${d.factor.label}: score ${d.factor.score ?? d.factor.adj} (w ${d.factor.weight ?? '-'}) — ${d.factor.value || ''}`) : '';
    return `<h4><span>${esc(label || d.fieldKey || d.path)}</span><span><span class="lv ${esc(lv)}">${esc(lv)}</span> <span class="x" title="close">✕</span></span></h4><table>
      ${row('value', val)}${row('source', esc(d.source))}${row('endpoint', esc(d.endpoint))}${row('chain', esc(d.chain))}${row('contract', esc(d.contract))}${row('pair', esc(d.pairAddress))}
      ${row('block', d.block != null ? esc(d.block) + (d.blockRange ? ` <span style="color:#7d889b">(range ${esc(d.blockRange.from)}–${esc(d.blockRange.to)})</span>` : '') : '')}${row('tx', esc(d.tx))}
      ${row('as-of', d.asOf ? `${local(d.asOf)} <b>${ago(d.asOf)}</b>${d.asOfNote ? ' · ' + esc(d.asOfNote) : ''}` : '')}${row('fetched', d.fetchedAt ? `${local(d.fetchedAt)} (${ago(d.fetchedAt)})${d.fetch ? ' · HTTP ' + esc(d.fetch.status) + ' · ' + esc(d.fetch.ms) + 'ms' : ''}` : '')}
      ${row('cache', cache)}${row('transform', esc(d.transform))}${row('venues', ven)}${row('files', files)}${row('embedded', emb)}${row('computed', d.computedAt ? local(d.computedAt) : '')}
      ${row('note', esc(d.warning || d.note || d.routeError || ''))}</table>
      <div style="margin-top:6px;color:#7d889b">${esc(d.path || '')} · <a href="/api/provenance?path=${encodeURIComponent(d.path || '')}&field=${encodeURIComponent(d.field || '')}&row=${encodeURIComponent(d.row || '')}" target="_blank">full JSON</a> · <a href="/api/provenance/coverage" target="_blank">coverage</a></div>`;
  }
  async function lookup(x, y, route, field, rowKey, label) {
    show(x, y, `<h4><span>${esc(label || field || route)}</span><span class="x">✕</span></h4><div style="color:#7d889b">tracing source…</div>`);
    try {
      const r = await fetch(`/api/provenance?path=${encodeURIComponent(route)}&field=${encodeURIComponent(field || '')}&row=${encodeURIComponent(rowKey || '')}`);
      const d = await r.json(); if (d.error) throw new Error(d.error);
      show(x, y, render(d, label));
    } catch (e) { show(x, y, `<h4><span>${esc(route)}</span><span class="x">✕</span></h4><div>provenance unavailable: ${esc(e.message)}</div>`); }
  }
  function routeFor(el) { const a = el.closest('[data-prov-route]'); if (a) return a.dataset.provRoute; const g = el.closest('[data-prov-route-guess]'); return g ? g.dataset.provRouteGuess : null; }
  function context(target) {
    const cell = target.closest('td,th,.num,.kv,span,b,div'); if (!cell || !target.closest('.panel,.view,section')) return null;
    const route = routeFor(cell); if (!route) return null;
    let field = '', rowKey = '';
    const td = target.closest('td'); const tr = target.closest('tr');
    if (td && tr) {
      const table = td.closest('table'); const th = table?.querySelectorAll('thead th')[td.cellIndex];
      field = ((th?.firstChild?.nodeType === 3 ? th.firstChild.textContent : th?.textContent) || '').replace(/[ⓘ?↑↓▲▼]/g, '').replace(/\s+i$/, '').trim();
      const ds = tr.dataset; rowKey = ds.k || ds.key || ds.sym || ds.symbol || (ds.c && ds.a ? ds.c + ':' + ds.a : '') || ds.a || '';
      if (!rowKey) { const b = tr.querySelector('td b, td.tok'); rowKey = (b?.textContent || '').trim().split(/\s+/)[0]; }
    } else {
      field = (target.getAttribute('data-field') || target.title || '').trim() || (target.previousElementSibling?.textContent || '').trim().slice(0, 40);
      const r = target.closest('[data-k],[data-key],[data-sym]'); if (r) rowKey = r.dataset.k || r.dataset.key || r.dataset.sym;
    }
    return { route, field, rowKey, label: `${rowKey ? rowKey.split(':').pop().slice(0, 14) + ' · ' : ''}${field || 'value'}`, cell };
  }
  document.addEventListener('click', (e) => {
    if (e.target.classList?.contains('provSrc')) { e.preventDefault(); e.stopPropagation(); return lookup(e.clientX, e.clientY, e.target.dataset.route, '', '', 'panel: ' + e.target.dataset.route); }
    if (pop && !e.target.closest('.provPop')) close();
    if (!e.altKey) return;
    const c = context(e.target); if (!c) return;
    e.preventDefault(); e.stopPropagation(); c.cell.classList.add('provHint');
    lookup(e.clientX, e.clientY, c.route, c.field, c.rowKey, c.label);
  }, true);
  let lp = null;
  document.addEventListener('touchstart', (e) => { const t = e.touches[0]; lp = setTimeout(() => { const c = context(e.target); if (c) { c.cell.classList.add('provHint'); lookup(t.clientX, t.clientY, c.route, c.field, c.rowKey, c.label); } lp = null; }, 600); }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => document.addEventListener(ev, () => { if (lp) { clearTimeout(lp); lp = null; } }, { passive: true }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // ---- key health badge ----
  const bar = document.querySelector('.topbar .status') || document.querySelector('.topbar');
  if (bar) {
    const b = document.createElement('button'); b.className = 'khBadge'; b.textContent = 'keys …'; b.title = 'API key health / rotation schedule / leak scan';
    bar.after(b);
    async function refresh() {
      try {
        const d = await (await fetch('/api/keyhealth')).json(); if (d.error) throw new Error(d.error);
        const due = d.keys.filter((k) => k.present && (k.schedule.status === 'due-soon' || k.schedule.status === 'overdue'));
        const bad = d.keys.filter((k) => k.health && k.health.status === 'invalid');
        const leak = d.leakScan?.summary ? d.leakScan.summary.critical + d.leakScan.summary.high : 0;
        b.className = 'khBadge ' + d.status; b.textContent = bad.length ? `keys: ${bad.length} invalid` : leak ? `keys: leak ${leak}` : due.length ? `keys: ${due.length} due` : 'keys ok';
        b.onclick = (e) => {
          const rows = d.keys.map((k) => `<tr><td>${esc(k.name)}</td><td>${k.present ? '' : '<i>not set</i> '}${esc(k.health?.status || '')}${k.health?.http ? ' (' + k.health.http + ')' : ''} · age ${k.schedule.ageDays ?? '?'}d${k.schedule.ageIsLowerBound ? '+' : ''} · due ${esc(k.schedule.dueAt || '?')} <b>${esc(k.schedule.status)}</b>${k.pendingRestart ? ' · restart pending' : ''}<br><span style="color:#7d889b">${esc(k.autoRotation)}</span></td></tr>`).join('');
          const ls = d.leakScan?.summary ? `${d.leakScan.summary.critical} critical · ${d.leakScan.summary.high} high · ${d.leakScan.summary.medium} medium · ${d.leakScan.summary.low} low · ${d.leakScan.summary.info || 0} info — ${d.leakScan.filesScanned} files, ${local(d.leakScan.generatedAt)}` : 'not run yet';
          const lf = (d.leakScan?.findings || []).filter((f) => f.severity !== 'info').slice(0, 8).map((f) => `${esc(f.severity)} ${esc(f.pattern)} ${esc(f.path)}:${esc(f.lines.join(','))}`).join('<br>');
          show(e.clientX - 300, e.clientY, `<h4><span>API key health</span><span class="x">✕</span></h4><table>${rows}${row('leak scan', esc(ls) + (lf ? '<br>' + lf : ''))}${row('schedule', `every ${d.config.defaultDays}d · remind ${d.config.remindDays}d before · SESSION_SECRET auto-rotate ${d.config.sessionAutoRotate ? 'on' : 'off'}`)}${row('last check', d.lastHealthCheck ? local(d.lastHealthCheck) + ' (' + ago(d.lastHealthCheck) + ')' : 'not yet')}</table><div style="margin-top:6px;color:#7d889b">How to rotate: KEY_ROTATION.md · <a href="/api/keyhealth" target="_blank">JSON</a></div>`);
        };
      } catch { b.textContent = 'keys ?'; }
    }
    refresh(); setInterval(refresh, 10 * 60e3);
  }
})();
