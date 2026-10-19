// layout.js: 6-tab structure (Martin, Oct 2026) — Today / Token / Breakouts / Options / Research / Guide + owner-only ⋯ menu.
// Nothing is deleted except the Derive tab and the ZEC shielded deep dive (approved). Today and Research share the old Command view
// (body[data-view=command]) so every desk keeps its refresh loop; body[data-sub] decides which panels show.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s), QA = (s) => [...document.querySelectorAll(s)];
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const nav = Q('#viewNav'); if (!nav) return;
  let LITE = false;

  // ---------- nav ----------
  const cmd = nav.querySelector('[data-v=command]'); if (cmd) cmd.textContent = 'Today';
  const term = nav.querySelector('[data-v=terminal]'); if (term) term.textContent = 'Token';
  const gl = nav.querySelector('[data-v=glossary]'); if (gl) gl.textContent = 'Guide';
  const mk = (v, txt) => { const b = document.createElement('button'); b.dataset.v = v; b.textContent = txt; return b; };
  const brk = mk('breakouts', 'Breakouts'); term ? term.after(brk) : nav.appendChild(brk);
  const res = mk('command', 'Research'); res.dataset.sub = 'research'; (nav.querySelector('[data-v=options]') || brk).after(res);
  if (cmd) cmd.dataset.sub = 'today';
  const owner = document.createElement('div'); owner.id = 'ownerMenu'; owner.className = 'ownermenu';
  owner.innerHTML = '<button type="button" class="ownerbtn" aria-label="More (owner)">⋯</button><div class="ownerlist hidden"></div>';
  nav.appendChild(owner);
  const list = owner.querySelector('.ownerlist');
  owner.querySelector('.ownerbtn').onclick = (e) => { e.stopPropagation(); list.classList.toggle('hidden'); };
  document.addEventListener('click', (e) => { if (!owner.contains(e.target)) list.classList.add('hidden'); });
  const ORDER = { command: 0, terminal: 1, breakouts: 2, options: 3, research: 4, longbook: 4.5, glossary: 5 };
  function tidyNav() {
    for (const v of ['portfolio', 'tax', 'swap', 'airdrops']) { const b = nav.querySelector(`:scope > [data-v=${v}]`); if (b) list.appendChild(b); }
    for (const v of ['derive', 'accum']) { const b = nav.querySelector(`:scope > [data-v=${v}]`); if (b) { b.classList.add('hidden'); b.dataset.hiddenNav = '1'; } }
    const hideO = !list.children.length || window.ST_ROLE === 'guest'; if (owner.classList.contains('hidden') !== hideO) owner.classList.toggle('hidden', hideO);
    const btns = [...nav.querySelectorAll(':scope > button:not(.hidden)')].sort((a, b) => (ORDER[a.dataset.sub === 'research' ? 'research' : a.dataset.v] ?? 9) - (ORDER[b.dataset.sub === 'research' ? 'research' : b.dataset.v] ?? 9));
    const cur = [...nav.querySelectorAll(':scope > button:not(.hidden)')];
    if (btns.some((b, k) => cur[k] !== b) || nav.lastElementChild !== owner && !nav.lastElementChild.classList.contains('hidden')) for (const b of btns) owner.before(b); // only reorder when needed (avoids observer loops)
  }
  // sub-view (Today vs Research) + correct "on" state; runs after views.js' own handler
  function setSub(sub) {
    document.body.dataset.sub = sub;
    nav.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === document.body.dataset.view && (b.dataset.v !== 'command' || b.dataset.sub === sub)));
    const u = new URL(location.href); if (document.body.dataset.view === 'command' && sub === 'research') u.searchParams.set('view', 'research'); history.replaceState(null, '', u);
    if (sub === 'research') classify();
  }
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; list.classList.add('hidden'); setTimeout(() => setSub(b.dataset.v === 'command' ? b.dataset.sub || 'today' : ''), 0); });
  if (new URLSearchParams(location.search).get('view') === 'research') { cmd && cmd.click(); setTimeout(() => setSub('research'), 0); } else if (document.body.dataset.view === 'command') setSub('today');

  // ---------- classify Command panels: Today (headline cards) / Research / merged elsewhere ----------
  const TITLE = (p) => (p.querySelector('.phead')?.textContent || '').trim().toUpperCase();
  const MERGED = [/^SCANNER DETAIL/, /^WATCHLIST/, /^TOP OPTIONS/, /^TOP AIRDROPS/, /^MACRO \/ FED/]; // shown in Token / Options / owner Airdrops / Today macro line
  const BOX_ONLY = [/^LIVE ALPHA FEED/, /^PRE-LAUNCH MATCHER/, /^SLOW-RUG WATCH/, /^X MENTIONS/]; // need live collectors: empty on Render
  function classify() {
    const cc = Q('#viewCommand'); if (!cc) return;
    for (const p of cc.querySelectorAll('.panel')) {
      if (p.id === 'todayBox' || p.closest('#todayBox')) continue;
      const t = TITLE(p);
      p.classList.add('rs-panel');
      if (MERGED.some((r) => r.test(t))) p.classList.add('merged-away');
      const box = BOX_ONLY.some((r) => r.test(t));
      p.classList.toggle('lite-empty', LITE && box);
      if (box && !p.querySelector('.boxonly')) { const h = p.querySelector('.phead'); if (h) h.insertAdjacentHTML('beforeend', `<span class="boxonly" title="Needs the live collectors on the box server">${LITE ? 'box only: no live data on Render' : 'live'}</span>`); }
    }
    for (const el of [Q('#ccDesks'), Q('.ccTop'), Q('#ccLow')]) if (el) el.classList.add('rs-panel');
    const acc = Q('#accStrip'); if (acc) acc.classList.add('rs-panel');
  }
  let pend = false;
  new MutationObserver(() => { if (pend) return; pend = true; requestAnimationFrame(() => { pend = false; tidyNav(); if (document.body.dataset.sub === 'research') classify(); }); }).observe(document.body, { childList: true, subtree: true });
  tidyNav();

  // ---------- Today headline cards ----------
  const cc = Q('#viewCommand');
  const box = document.createElement('div'); box.id = 'todayBox'; box.className = 'todaybox';
  box.innerHTML = `<div class="tcards">
    <div class="tcard" id="tSetups" data-prov-route="/api/fplog"><h3>Setups <span class="muted small">proven signals only</span></h3><div class="tb">loading…</div></div>
    <div class="tcard" id="tBreak" data-prov-route="/api/flatbase"><h3>Breakouts <span class="muted small">top 5 flat bases</span></h3><div class="tb">loading…</div></div>
    <div class="tcard" id="tRisk" data-prov-route="/api/fplog"><h3>Risk alerts <span class="muted small">proven rug / crash flags</span></h3><div class="tb">loading…</div></div>
    <div class="tcard" id="tMacro" data-prov-route="/api/desks"><h3>Macro</h3><div class="tb">loading…</div></div></div>
    <details class="more tmore"><summary>More: desk summaries &amp; validation</summary><div id="tMoreSlot"></div></details>
    <div class="muted small" style="padding:4px 2px">Everything else lives in <a href="#" id="tGoResearch">Research</a>.</div>`;
  if (cc) cc.prepend(box);
  Q('#tGoResearch').onclick = (e) => { e.preventDefault(); res.click(); };
  // move desk summaries + validation into the collapsed "More" (same nodes; their scripts keep updating them)
  function moveMore() {
    const slot = Q('#tMoreSlot'); if (!slot) return;
    const desks = Q('#ccDesks'); if (desks && desks.parentElement !== slot) slot.appendChild(desks);
    const val = [...(cc?.querySelectorAll('.panel') || [])].find((p) => /^VALIDATION/.test(TITLE(p)));
    if (val && val.parentElement !== slot) slot.appendChild(val);
    for (const p of [...slot.querySelectorAll(':scope > .panel')]) if (!/^VALIDATION/.test(TITLE(p))) box.after(p); // panels other scripts insert next to the desks belong to Research
  }
  new MutationObserver(moveMore).observe(cc || document.body, { childList: true, subtree: false }); new MutationObserver(moveMore).observe(Q('#tMoreSlot'), { childList: true }); moveMore(); setTimeout(moveMore, 1500);

  async function j(u) { const r = await fetch(u); const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status); return d; }
  async function loadToday() {
    try { const w = await j('/api/whoami'); LITE = !!w.lite; if (w.role === 'guest') window.ST_ROLE = 'guest'; tidyNav(); } catch {}
    // proven detectors = live-validated: >= 30 resolved flags, rolling lift >= 1.5, active
    try {
      const f = await j('/api/fplog?limit=200');
      const proven = new Set(Object.entries(f.detectors || {}).filter(([, v]) => v.n >= 30 && (v.rollingLift || 0) >= 1.5 && v.status === 'active').map(([k]) => k));
      const rec = (f.recent || []).filter((x) => proven.has(x.detector) && x.status !== 'shadow');
      const up = rec.filter((x) => !/crash|rug|dump/i.test(x.claim || '')), dn = rec.filter((x) => /crash|rug|dump/i.test(x.claim || ''));
      const det = (k) => { const v = f.detectors[k]; return `${E(k.replace(/_/g, ' '))} · hit ${Math.round(v.precision * 100)}% of ${v.n} (lift ${(v.rollingLift || 0).toFixed(1)})`; };
      const li = (x) => `<li><b>${E(x.symbol || x.key)}</b> ${E(x.reason || '')}<div class="muted small">${det(x.detector)} · ${ago(x.t)}</div>${(window.fsLine ? window.fsLine(x) : '')}</li>`;
      Q('#tSetups .tb').innerHTML = up.length ? `<ul>${up.slice(0, 5).map(li).join('')}</ul>` : `<div class="muted">No fresh setup from a proven signal right now.${LITE ? ' (Render shows the last box snapshot.)' : ''}</div><div class="muted small">Proven live: ${[...proven].map((k) => E(k.replace(/_/g, ' '))).join(', ') || 'none yet'}.</div>`;
      Q('#tRisk .tb').innerHTML = dn.length ? `<ul>${dn.slice(0, 5).map(li).join('')}</ul>` : '<div class="muted">No fresh proven rug / crash flag.</div>';
    } catch (e) { Q('#tSetups .tb').textContent = Q('#tRisk .tb').textContent = 'unavailable: ' + e.message; }
    try {
      const b = await j('/api/flatbase'); const top = b.items.filter((x) => x.label !== 'Watching').slice(0, 5);
      Q('#tBreak .tb').innerHTML = (top.length ? `<ul>${top.map((x) => `<li><b>${E(x.symbol)}</b> <span class="lbl l-${E(x.label.split(' ')[0].toLowerCase())}">${E(x.label)}</span> <span class="muted">score ${x.score}</span><div class="muted small">${E(x.reasons[0] || '')} · data as of ${new Date(x.dataAsOf).toISOString().slice(0, 10)}</div>${(window.fsLine ? window.fsLine(x) : '')}</li>`).join('')}</ul>` : '<div class="muted">No coin in a qualifying flat base.</div>')
        + `<div class="muted small">Signal strength: <b>${E(b.strength)}</b> (backtest). <a href="#" class="goBrk">All breakouts →</a></div>`;
      Q('#tBreak .goBrk').onclick = (e) => { e.preventDefault(); brk.click(); };
    } catch (e) { Q('#tBreak .tb').textContent = 'unavailable: ' + e.message; }
    try { const d = await j('/api/desks'); const m = d.macro; Q('#tMacro .tb').innerHTML = m ? `<div>${E((m.summary || [])[0] || '')}</div><div class="muted small">${E((m.summary || [])[1] || '')} · ${ago(m.updatedAt || d.generatedAt)}</div>` : '<div class="muted">No macro snapshot.</div>'; } catch (e) { Q('#tMacro .tb').textContent = 'unavailable: ' + e.message; }
    classify();
  }
  loadToday(); setInterval(() => { if (document.body.dataset.view === 'command' && document.body.dataset.sub === 'today') loadToday(); }, 120e3);

  const css = document.createElement('style');
  css.textContent = `.ownermenu{position:relative;display:inline-flex}.ownerbtn{background:none;border:0;color:var(--mut);font:inherit;font-size:1.3em;padding:4px 12px;cursor:pointer;min-height:40px}
  .ownerlist{position:absolute;right:0;top:100%;background:var(--panel2);border-radius:10px;padding:6px;z-index:60;display:flex;flex-direction:column;min-width:160px;box-shadow:0 10px 30px #000a}
  .ownerlist.hidden{display:none}.ownerlist button{text-align:left;background:none;border:0;color:var(--txt);font:inherit;padding:10px 12px;min-height:44px;cursor:pointer;border-radius:8px}.ownerlist button.on,.ownerlist button:hover{background:#1a2230}
  body[data-sub=today] #viewCommand > :not(#todayBox){display:none!important}
  body[data-sub=research] #todayBox{display:none}
  .merged-away{display:none!important}.lite-empty{display:none!important}
  .boxonly{font-size:.72em;color:var(--amb);border:1px solid #5a4313;border-radius:999px;padding:1px 8px;margin-left:8px}
  .todaybox{display:flex;flex-direction:column;gap:12px;padding:4px}
  .tcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
  .tcard{background:var(--panel);border-radius:12px;padding:14px 16px}.tcard h3{margin:0 0 8px;font-size:1em;color:#fff;letter-spacing:.5px}
  .tcard ul{margin:0;padding-left:18px;line-height:1.5}.tcard li{margin:0 0 8px}
  .lbl{font-size:.75em;border-radius:999px;padding:1px 8px;background:#1a2230}.l-breaking{color:var(--grn)}.l-waking{color:var(--amb)}.l-coiled{color:var(--blu)}
  #tMoreSlot .desks{margin-top:8px}`;
  document.head.appendChild(css);
})();
