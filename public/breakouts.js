// Breakouts tab: flat-base scanner (lib/flatbase.js -> /api/flatbase). Coins far below their highs that went extremely flat;
// labels Coiled / Waking / Breaking out; every row shows data freshness and the backtest-based signal strength.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const pc = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const sec = document.createElement('section'); sec.id = 'viewBreakouts'; sec.className = 'view'; sec.dataset.provRoute = '/api/flatbase';
  sec.innerHTML = `<div class="panel" style="flex:none"><div class="phead"><h2>Breakouts: flat bases</h2><span id="bkMeta" class="muted small"></span></div>
    <div class="bkintro muted">Coins that crashed far from their highs, then went very flat (tight range, low volatility, quiet volume) for weeks. <b>Coiled</b> = base formed · <b>Waking</b> = volume picking up or price at the top of the range · <b>Breaking out</b> = closed above the range on volume.</div>
    <div class="bkfilters"><button data-f="all" class="on">All</button><button data-f="Breaking out">Breaking out</button><button data-f="Waking">Waking</button><button data-f="Coiled">Coiled</button></div>
    <div id="bkOut"></div>
    <details class="more" style="margin:0 14px"><summary>How it scores &amp; how well it backtested</summary><div id="bkHow" class="bkhow"></div></details></div>`;
  (Q('#viewCommand') || document.body).after(sec);
  const css = document.createElement('style');
  css.textContent = `body[data-view=breakouts] main.grid{display:none}body[data-view=breakouts] #viewBreakouts{display:flex;flex-direction:column;overflow:auto}
  .bkintro{padding:0 14px 8px;line-height:1.5}.bkfilters{display:flex;gap:8px;padding:0 14px 8px;flex-wrap:wrap}.bkfilters button{background:#0a0e14;border:0;color:var(--mut);font:inherit;padding:8px 14px;border-radius:999px;min-height:40px;cursor:pointer}.bkfilters button.on{color:#fff;background:#1a2230}
  #bkOut{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:6px 14px 14px}
  .bk{background:var(--panel2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
  .bk .h{display:flex;align-items:baseline;gap:10px}.bk .h b{font-size:1.15em;color:#fff}.bk .sc{margin-left:auto;font-size:1.4em;font-weight:800}
  .bk ul{margin:0;padding-left:18px;line-height:1.5}.bk .f{font-size:.82em;color:var(--mut);display:flex;flex-wrap:wrap;gap:4px 12px}
  .bk.l-breaking{box-shadow:inset 3px 0 0 var(--grn)}.bk.l-waking{box-shadow:inset 3px 0 0 var(--amb)}.bk.l-coiled{box-shadow:inset 3px 0 0 var(--blu)}
  .str{border-radius:999px;padding:1px 8px;font-size:.78em}.str.unproven{color:var(--amb);background:#2a1f08}.str.weak{color:var(--amb);background:#2a1f08}.str.proven{color:var(--grn);background:#0b2418}
  .bkhow{line-height:1.6;padding:6px 0 14px}.bkhow table{width:100%;border-collapse:collapse;font-size:.9em}.bkhow td,.bkhow th{padding:6px;border-bottom:1px solid #0f141b;text-align:left}`;
  document.head.appendChild(css);
  let D = null, F = 'all';
  const card = (x) => `<div class="bk l-${E(x.label.split(' ')[0].toLowerCase())}" data-sym="${E(x.symbol)}">
    <div class="h"><b>${E(x.symbol)}</b><span class="lbl l-${E(x.label.split(' ')[0].toLowerCase())}">${E(x.label)}</span><span class="sc num">${x.score}</span></div>
    <ul>${x.reasons.map((r) => `<li>${E(r)}</li>`).join('')}</ul>${(window.fsLine ? window.fsLine(x) : '')}
    <div class="f"><span>data as of ${new Date(x.dataAsOf).toISOString().slice(0, 10)} (${ago(x.fetchedAt)} fetch)</span><span>strength <span class="str ${E(x.strength)}">${E(x.strength)}</span></span>${x.onchain ? '<span>on-chain ✓</span>' : '<span>on-chain n/a</span>'}</div>
    <details class="more"><summary>More details</summary><div class="muted small">${Object.entries(x.parts).map(([k, v]) => `${E(k)} ${v}`).join(' · ')}<br>below high ${pc(x.m.ddAth)} · 6-mo high ${pc(x.m.ddLocal)} · range 4w/8w/12w ${pc(x.m.range4w)}/${pc(x.m.range8w)}/${pc(x.m.range12w)} · base ${x.m.baseDays}d · vol 20d/120d ${x.m.volDry20v120}x · 5d/20d ${x.m.volUp5v20}x · source ${E(x.src)}</div></details></div>`;
  function render() {
    if (!D) return;
    const it = D.items.filter((x) => (F === 'all' ? x.label !== 'Watching' : x.label === F));
    Q('#bkOut').innerHTML = it.length ? it.map(card).join('') : '<div class="muted" style="padding:10px">None right now.</div>';
  }
  async function load() {
    try { const r = await fetch('/api/flatbase'); D = await r.json(); if (D.error) throw new Error(D.error); } catch (e) { Q('#bkOut').innerHTML = `<div class="muted" style="padding:10px">Breakouts data unavailable: ${E(e.message)}</div>`; return; }
    Q('#bkMeta').textContent = `updated ${ago(D.generatedAt)} · ${D.counts.breaking} breaking out · ${D.counts.waking} waking · ${D.counts.coiled} coiled · ${D.universe} coins scanned`;
    const b = D.backtest;
    Q('#bkHow').innerHTML = `<div><b>Hard filters:</b> ${E(D.rules.hardFilters)}.</div><div><b>Score (0-100):</b> ${E(D.rules.weights)}.</div>
      <div><b>Signal strength: <span class="str ${E(D.strength)}">${E(D.strength)}</span></b> — ${E(D.strengthWhy)}</div>
      ${b ? `<table><thead><tr><th>Group (backtest ${new Date(b.generatedAt).toISOString().slice(0, 10)})</th><th>coin-weeks</th><th>broke out</th><th>rate</th><th>lift</th></tr></thead><tbody>${b.tiers.map((t) => `<tr><td>${E(t.name)}</td><td>${t.n}</td><td>${t.hits}</td><td>${t.hitRate != null ? (t.hitRate * 100).toFixed(1) + '%' : '—'}</td><td>${t.lift ?? '—'}</td></tr>`).join('')}</tbody></table>
      <div class="muted small">Breakout = 2x within 90 days and still ≥1.6x a week later. Not a buy signal on its own.</div>` : ''}`;
    render();
  }
  sec.querySelector('.bkfilters').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; F = b.dataset.f; sec.querySelectorAll('.bkfilters button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
  Q('#viewNav')?.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v === 'breakouts') load(); });
  if (document.body.dataset.view === 'breakouts') load();
  setInterval(() => { if (document.body.dataset.view === 'breakouts') load(); }, 10 * 60e3);
})();
