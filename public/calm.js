// calm.js: progressive disclosure for the readability layer (calm.css). Never removes content: collapses secondary bits behind
// "More details" toggles. Desks show 2 bullets; on phones, tables become stacked cards (first 4 cells + More details).
'use strict';
(function () {
  const mobile = () => matchMedia('(max-width:700px)').matches;
  const KEEP = 5; // first cell (token) + 4 headline cells
  function desks(root) {
    for (const d of root.querySelectorAll('.desk')) {
      const n = d.querySelectorAll('li').length;
      if (n <= 2 || d.querySelector(':scope > .calm-more')) continue;
      d.classList.add('calm-c');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'calm-more'; b.textContent = `More details (${n - 2})`;
      b.onclick = (e) => { e.stopPropagation(); const x = d.classList.toggle('xp'); b.textContent = x ? 'Less' : `More details (${n - 2})`; };
      d.appendChild(b);
    }
  }
  function tables(root) {
    if (!mobile()) return;
    for (const t of root.querySelectorAll('table.tbl')) {
      if (t.closest('.optdet,.tpgrid,.tplan')) continue;
      const heads = [...t.querySelectorAll('thead th')].map((th) => (th.textContent || '').replace(/[ⓘ↑↓▲▼]/g, '').replace(/\s+i$/, '').trim());
      t.classList.add('calm-stack');
      for (const tr of t.querySelectorAll('tbody tr')) {
        if (tr.dataset.calm === String(tr.cells.length)) continue;
        const cells = [...tr.cells].filter((c) => !c.classList.contains('calm-btn'));
        if (cells.length === 1) { tr.dataset.calm = String(tr.cells.length); continue; }
        cells.forEach((td, i) => { if (heads[td.cellIndex] && i > 0) td.dataset.l = heads[td.cellIndex]; td.classList.toggle('calm-x', i >= KEEP); });
        if (cells.length > KEEP && !tr.querySelector('.calm-btn')) {
          const td = document.createElement('td'); td.className = 'calm-btn';
          const b = document.createElement('button'); b.type = 'button'; b.className = 'calm-more'; b.textContent = `More details (${cells.length - KEEP})`;
          b.onclick = (e) => { e.stopPropagation(); const x = tr.classList.toggle('xp'); b.textContent = x ? 'Less' : `More details (${cells.length - KEEP})`; };
          td.appendChild(b); tr.appendChild(td);
        }
        tr.dataset.calm = String(tr.cells.length);
      }
    }
  }
  function filters(root) {
    if (!mobile()) return;
    for (const f of root.querySelectorAll('.filters')) {
      if (f.closest('details.calm-filters')) continue;
      const d = document.createElement('details'); d.className = 'more calm-filters';
      d.innerHTML = '<summary>Filters &amp; sort</summary>'; f.before(d); d.appendChild(f); // same nodes: ids/handlers unchanged
    }
  }
  let q = false;
  const run = () => { q = false; try { desks(document); tables(document); filters(document); } catch (e) { /* layout helper only */ } };
  new MutationObserver(() => { if (!q) { q = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true });
  run();
})();
