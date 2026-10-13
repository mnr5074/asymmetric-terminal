// ASYMMETRIC·TERMINAL: Heavy Accumulation (data/accumulation.json via /api/accumulation; scorer in lib/accumulation.js).
// Shown as a compact strip at the top of Command and as its own tab (view=accum). Read-only.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const IX = (t) => (window.ix ? window.ix(t) : '');
  const FAM = { smartmoney: 'Smart money', whales: 'Whales', exchange_outflow: 'Exchange outflow', oi_flat: 'OI build / flat price', vc_wallets: 'Fund / MM wallets', copytrade: 'Top traders', holders: 'Holder growth' };
  const st = document.createElement('style');
  st.textContent = `body[data-view=accum] main.grid{display:none}body[data-view=accum] #viewAccum{display:flex;flex-direction:column;overflow:auto}
  .acc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:12px}
  .acc-card{background:var(--panel2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
  .acc-card.heavy{box-shadow:inset 3px 0 0 var(--grn)}.acc-card.accumulating{box-shadow:inset 3px 0 0 var(--amb)}
  .acc-h{display:flex;align-items:baseline;gap:10px}.acc-h b{font-size:1.15em;color:#fff}.acc-sc{margin-left:auto;font-size:1.5em;font-weight:800;color:var(--grn)}
  .acc-card.accumulating .acc-sc{color:var(--amb)}.acc-card.single .acc-sc{color:var(--mut)}
  .acc-card ul{margin:0;padding-left:18px;line-height:1.5}.acc-fams{display:flex;flex-wrap:wrap;gap:6px}.acc-fams span{font-size:.8em;color:var(--mut);background:#0a0e14;border-radius:999px;padding:2px 10px}
  .acc-foot{display:flex;gap:10px;align-items:center;font-size:.85em;color:var(--mut)}.acc-foot a{margin-left:auto}
  .acc-empty{padding:14px 16px;color:var(--mut);line-height:1.5}.acc-sec{padding:6px 12px 0;margin:0;font-size:.95em;color:#fff;text-transform:uppercase;letter-spacing:1px}
  .acc-status{padding:6px 12px 14px;color:var(--mut);font-size:.85em;line-height:1.6}.acc-status b.on{color:var(--grn)}.acc-status b.off{color:var(--red)}
  #accStrip .acc-cards{grid-auto-flow:column;grid-auto-columns:minmax(280px,1fr);grid-template-columns:none;overflow-x:auto}`;
  document.head.appendChild(st);

  // own tab
  const nav = Q('#viewNav');
  if (nav && !nav.querySelector('[data-v=accum]')) { const b = document.createElement('button'); b.dataset.v = 'accum'; b.textContent = 'Accumulation'; const after = nav.querySelector('[data-v=terminal]'); after ? after.after(b) : nav.appendChild(b); }
  const sec = document.createElement('section'); sec.id = 'viewAccum'; sec.className = 'view'; sec.dataset.provRoute = '/api/accumulation';
  sec.innerHTML = `<div class="panel" style="flex:none"><div class="phead"><h2>Heavy Accumulation ${IX('accum')}</h2><span id="accMeta" class="muted small"></span></div><div id="accFull"></div></div>`;
  (Q('#viewCommand') || document.body).after(sec);
  // strip at the top of Command
  const cc = Q('#viewCommand');
  if (cc) { const p = document.createElement('div'); p.className = 'panel'; p.id = 'accStrip'; p.style.flex = 'none'; p.dataset.provRoute = '/api/accumulation';
    p.innerHTML = `<div class="phead"><span>HEAVY ACCUMULATION ${IX('accum')} <span id="accStripMeta" class="muted small"></span></span><button class="btn ghost mini2" id="accAll">See all</button></div><div id="accStripBody"></div>`;
    const top = cc.querySelector('.ccTop'); top ? top.after(p) : cc.prepend(p);
    p.querySelector('#accAll').onclick = () => Q('#viewNav button[data-v=accum]')?.click(); }

  const card = (x) => `<div class="acc-card ${E(x.tier)}" data-k="${E(x.key)}">
    <div class="acc-h"><b>${E(x.symbol || (x.address || '').slice(0, 6) + '…')}</b><span class="muted small">${E(x.chain || 'perp')}</span><span class="acc-sc num" title="score 0-100">${x.score}</span></div>
    <ul>${x.reasons.map((r) => `<li>${E(r)}</li>`).join('')}</ul>
    <div class="acc-fams">${Object.keys(x.signals).map((f) => `<span>${E(FAM[f] || f)}</span>`).join('')}</div>
    <details class="more"><summary>More details</summary><div class="muted small">${Object.entries(x.signals).map(([f, v]) => `${E(FAM[f] || f)}: ${v.pts} pts · ${E(v.src)} · ${ago(v.at)}`).join('<br>')}</div></details>
    <div class="acc-foot"><span>oldest signal ${ago(x.oldestSignalAt)}</span>${x.planUrl ? `<a href="${E(x.planUrl)}">Trade plan →</a>` : x.perpsUrl ? `<a href="${E(x.perpsUrl)}">Perp desk →</a>` : ''}</div></div>`;
  const statusLine = (s) => Object.entries(s || {}).map(([k, v]) => `<b class="${v.live ? 'on' : 'off'}">${v.live ? '●' : '○'}</b> ${E(k.replace(/_/g, ' '))}${v.at ? ' (' + ago(v.at) + ')' : ''}${v.live ? '' : ': ' + E(v.why || v.note || 'no data')}`).join(' · ');
  let D = null;
  async function load() {
    try { const r = await fetch('/api/accumulation'); D = await r.json(); if (D.error) throw new Error(D.error); } catch (e) { const m = `<div class="acc-empty">Accumulation data unavailable: ${E(e.message)}</div>`; Q('#accFull').innerHTML = m; const sb = Q('#accStripBody'); if (sb) sb.innerHTML = m; return; }
    const meta = `updated ${ago(D.generatedAt)} · ${D.counts.heavy} heavy · ${D.counts.accumulating} accumulating · 0 credits`;
    Q('#accMeta').textContent = meta; const sm = Q('#accStripMeta'); if (sm) sm.textContent = meta;
    const none = `<div class="acc-empty">No token meets the heavy bar right now (needs 3+ independent signal types agreeing). ${D.accumulating.length ? 'Closest candidates:' : ''}</div>`;
    const top = D.heavy.length ? D.heavy : D.accumulating;
    const sb = Q('#accStripBody'); if (sb) sb.innerHTML = (D.heavy.length ? '' : none) + (top.length ? `<div class="acc-cards">${top.slice(0, 6).map(card).join('')}</div>` : '');
    Q('#accFull').innerHTML = `<h3 class="acc-sec">Heavy (3+ signal types)</h3>${D.heavy.length ? `<div class="acc-cards">${D.heavy.map(card).join('')}</div>` : '<div class="acc-empty">None right now.</div>'}
      <h3 class="acc-sec">Accumulating (2 signal types)</h3>${D.accumulating.length ? `<div class="acc-cards">${D.accumulating.map(card).join('')}</div>` : '<div class="acc-empty">None right now.</div>'}
      <details class="more" style="margin:0 12px"><summary>Single-signal watchlist (${D.single.length})</summary><div class="acc-cards">${D.single.map(card).join('')}</div></details>
      <h3 class="acc-sec">Data sources</h3><div class="acc-status">${statusLine(D.status)}<br>${E(D.rule)}. Not a buy signal on its own.</div>`;
  }
  load(); setInterval(() => { if (['command', 'accum'].includes(document.body.dataset.view)) load(); }, 5 * 60e3);
  if (nav) nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v === 'accum') load(); });
})();
