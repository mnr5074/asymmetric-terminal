// ASYMMETRIC·TERMINAL Grok news layer (Command view, Perp Desk): "News pulse" strip under the Perp Desk tabs + Grok news feed panel.
// Data: /api/grok/pulse (desk signals that fired × Grok-scored headlines), /api/grok (status, budget, flags, scored feed).
// Headlines are scored once by the xAI API server-side and cached; tapping a headline only expands notes (no extra paid call).
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const I = (k) => (window.ix ? window.ix(k) : '');
  const J = (p) => (typeof api === 'function' ? api(p) : fetch(p).then((r) => r.json()));
  Object.assign(window.EXPLAIN || {}, {
    gk_pulse: ['News pulse (Grok)', 'When one of the Perp Desk detectors fires for a coin (a liquidation cascade, a cross-exchange price gap, a funding divergence or an order-book spoof/thin book), this strip shows the headlines Grok tied to that coin in the last 48 hours: "what is driving this". No matching headline usually means the move is flow-driven (positioning, liquidations, one venue) rather than news-driven.', null, 'Perps'],
    gk_urg: ['Urgency (0–100)', 'How soon and how strongly the headline can move prices. 90+ = live hack, exchange halt, surprise Fed/ETF decision. 60–89 = clear catalyst for the named coins today. Below 30 = commentary or price recaps. BREAKING = urgency 75+ and under 30 minutes old.', null, 'News'],
    gk_sent: ['Sentiment (−100 … +100)', 'Grok\'s reading of whether the headline is good (+, bullish) or bad (−, bearish) for the coins it names. It judges the headline only, not the full article, so treat it as a quick first read.', null, 'News'],
    gk_conf: ['Confidence', 'How sure the model is of its own reading (0–1). Vague, clickbait or unverified headlines get low confidence and count less in the composite grade.', null, 'News'],
    gk_cost: ['Grok cost & caps', 'Each headline is sent to the xAI API once (about 25 per call) and the answer is cached forever, so the same story is never paid for twice. A hard monthly cap and a daily cap stop all calls when reached. Live web/X search is switched off.', null, 'News'],
  });
  const css = document.createElement('style');
  css.textContent = `#gkPulse{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px 8px;font-size:11px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;max-height:30vh;overflow:auto}
  #gkPulse .gl{color:var(--mut);white-space:nowrap}.gkchip{border:1px solid #2a3442;border-radius:4px;padding:2px 6px;cursor:pointer;max-width:100%}.gkchip.on{border-color:#5a7bd8;background:#121a2a}.gkchip.hot{border-color:#6a1f27}
  .gkchip .t{color:var(--mut);font-size:10px}.gkdet{flex-basis:100%;background:#0d131c;border-radius:4px;padding:4px 8px}.gkdet div{padding:1px 0}
  .gkb{display:inline-block;font-size:9px;padding:0 4px;border-radius:2px;border:1px solid #6a1f27;color:#ff6b6b;margin-right:3px}.gks.up{color:#4ff09a}.gks.dn{color:#ff6b6b}
  #grokNews{flex:none;height:60vh;min-height:360px;margin-top:8px}#grokNews .pbody{overflow:auto;flex:1;min-height:0}#gkFilt{display:flex;flex-direction:row;gap:6px;flex-wrap:wrap;padding:4px 8px;font-size:11px;align-items:center}
  #gkFilt select,#gkFilt input{width:auto!important;display:inline-block!important;margin:0!important;background:#0d131c;color:inherit;border:1px solid var(--line);border-radius:3px;font-size:11px;padding:1px 4px}
  .gkrow{border-bottom:1px solid #141c27;padding:4px 8px;cursor:pointer}.gkrow .m{color:var(--mut);font-size:10.5px}.gkrow .x{display:none;font-size:11px;color:#c3ccd8;padding:4px 0 2px 10px}.gkrow.open .x{display:block}
  .gkbar{display:inline-block;width:34px;height:5px;background:#1a2230;border-radius:3px;vertical-align:middle}.gkbar i{display:block;height:100%;border-radius:3px}.gkbrief{white-space:pre-wrap;font-size:11px;padding:4px 8px;color:#c3ccd8;border-bottom:1px solid var(--line)}`;
  document.head.appendChild(css);

  const TABS = { liq: 'Liquidations', gaps: 'Price gaps', fdiv: 'Funding divergence', ob: 'Order book' };
  let PU = null, GD = null, sel = null, tab = 'flags', openRows = new Set(), F = { tok: '', cat: '', minurg: 0, sort: 'new' };
  const sCls = (s) => (s == null ? '' : s > 10 ? 'up' : s < -10 ? 'dn' : '');
  const ago = (m) => (m == null ? '' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd');
  const ubar = (u) => `<span class="gkbar"><i style="width:${u || 0}%;background:${u >= 75 ? '#ff6b6b' : u >= 50 ? '#f3c84a' : '#4f8af0'}"></i></span>`;
  const line = (h) => `<div>${h.breaking ? '<span class="gkb">BREAKING</span>' : ''}<b>u${h.urgency}</b> <span class="gks ${sCls(h.sentiment)}">${h.sentiment > 0 ? '+' : ''}${h.sentiment}</span> · ${E(h.categoryLabel || '')} · <a href="${E(h.url || '#')}" target="_blank" rel="noopener">${E(h.title)}</a> <span class="muted">${E(h.source)} · ${ago(h.ageMin)}</span><br><span class="muted">→ ${E(h.why || '')}</span></div>`;

  function renderPulse() {
    const el = Q('#gkPulse'); if (!el) return;
    if (!PU) { el.innerHTML = '<span class="gl">News pulse: loading…</span>'; return; }
    if (PU.status === 'waiting for key') { el.innerHTML = `<span class="gl">${I('gk_pulse')} News pulse (Grok): waiting for key — see GROK_SETUP.md. No calls are made until XAI_API_KEY is set.</span>`; return; }
    const rows = (PU.fired || []).filter((r) => !TABS[tab] || r.tab === tab);
    const chips = rows.map((r, n) => `<span class="gkchip ${sel === r.tab + r.sym ? 'on' : ''} ${r.headlines.some((h) => h.urgency >= 60) ? 'hot' : ''}" data-k="${E(r.tab + r.sym)}"><b>${E(r.sym)}</b> <span class="t">${E(TABS[r.tab])}: ${E(r.label)}</span> · ${r.headlines.length ? `${r.headlines.length} 📰 <span class="gks ${sCls(r.headlines[0].sentiment)}">${r.headlines[0].sentiment > 0 ? '+' : ''}${r.headlines[0].sentiment}</span>` : '<span class="muted">no news</span>'}</span>`).join('');
    const s = rows.find((r) => r.tab + r.sym === sel);
    const br = (PU.breaking || []).slice(0, 2).map((h) => `<span class="gkchip hot" data-bid="${E(h.id)}"><span class="gkb">BREAKING</span>${E(h.tokens.join('/'))} ${E(h.title.slice(0, 80))}</span>`).join('');
    el.innerHTML = `<span class="gl">${I('gk_pulse')} News pulse${TABS[tab] ? ' · ' + E(TABS[tab]) : ''}:</span>${br}${chips || `<span class="muted">${TABS[tab] ? 'nothing firing on this tab right now' : 'no detector firing right now'}</span>`}
      ${s ? `<div class="gkdet"><b>What's driving ${E(s.sym)}?</b> <span class="muted">${E(s.explain)}${s.xBuzz ? ` · X buzz (cached): ${s.xBuzz.postsPerHour ?? '—'} posts/h, tone ${s.xBuzz.toneAvg ?? '—'}` : ''}</span>${s.headlines.map(line).join('')}${!s.headlines.length && PU.marketWide?.length ? '<div class="muted">Market-wide headlines:</div>' + PU.marketWide.map(line).join('') : ''}</div>` : ''}`;
  }
  function feedRows() {
    let v = (GD?.items || []).filter((x) => x.scored);
    if (F.tok) v = v.filter((x) => x.tokens.includes(F.tok.toUpperCase()));
    if (F.cat) v = v.filter((x) => x.category === F.cat);
    if (F.minurg) v = v.filter((x) => x.urgency >= F.minurg);
    if (F.sort === 'urg') v = v.slice().sort((a, b) => b.urgency - a.urgency || b.ts - a.ts);
    return v.slice(0, 200);
  }
  function renderFeed() {
    const b = Q('#gkBody'), m = Q('#gkMeta'); if (!b) return;
    if (!GD) { b.innerHTML = '<div class="empty">Loading…</div>'; return; }
    const bu = GD.budget || {};
    m.innerHTML = `${I('gk_cost')} <b>${E(GD.status)}</b> · ${E(GD.model)} · $${(bu.spentTodayUsd || 0).toFixed(4)} today / $${bu.dailyCapUsd} cap · $${(bu.spentMonthUsd || 0).toFixed(4)} this month / $${bu.monthlyCapUsd} cap · ${bu.itemsScored || 0} scored, ${GD.cacheSize} cached, ${GD.unscored} waiting · search ${E(String(GD.search).split(' ')[0])}${bu.lastSkip ? ' · ' + E(bu.lastSkip) : ''}${bu.lastError ? ' · ⚠ ' + E(bu.lastError) : ''}`;
    if (GD.status === 'waiting for key') { b.innerHTML = `<div class="empty">Waiting for key. ${E(GD.note || '')}<br>${GD.total} headlines collected from the terminal's free sources are ready to score.</div>`; return; }
    const cats = GD.categories || {};
    const rows = feedRows();
    b.innerHTML = `${GD.brief?.text ? `<div class="gkbrief"><b>Desk brief ${E(GD.brief.day)}</b> <span class="muted">(${E(GD.brief.model)}, $${GD.brief.costUsd})</span>\n${E(GD.brief.text)}</div>` : ''}
      ${rows.map((x) => `<div class="gkrow ${openRows.has(x.id) ? 'open' : ''}" data-id="${E(x.id)}">${x.breaking ? '<span class="gkb">BREAKING</span>' : ''}${ubar(x.urgency)} <b>${x.urgency}</b> <span class="gks ${sCls(x.sentiment)}"><b>${x.sentiment > 0 ? '+' : ''}${x.sentiment}</b></span> ${x.tokens.map((t) => `<b>${E(t)}</b>`).join(' ')} — ${E(x.title)}
        <div class="m">${E(x.categoryLabel)} · conf ${(x.confidence ?? 0).toFixed(2)} · ${E(x.source)} · ${ago(x.ageMin)} ago · → ${E(x.why || '')}</div>
        <div class="x"><b>Why it matters:</b> ${E(x.why || '')}<br><b>Category — ${E(x.categoryLabel)}:</b> ${E(cats[x.category]?.explain || '')}<br><b>Reading:</b> urgency ${x.urgency}/100 ${I('gk_urg')} (${x.urgency >= 75 ? 'can move price now' : x.urgency >= 50 ? 'a real catalyst' : x.urgency >= 30 ? 'relevant, slow' : 'mostly noise'}), sentiment ${x.sentiment > 0 ? '+' : ''}${x.sentiment} ${I('gk_sent')} (${x.sentiment > 30 ? 'bullish' : x.sentiment < -30 ? 'bearish' : 'roughly neutral'}), confidence ${(x.confidence ?? 0).toFixed(2)} ${I('gk_conf')}. Seen in: ${E(x.origins.join(', '))}. ${x.url ? `<a href="${E(x.url)}" target="_blank" rel="noopener">open article ↗</a>` : ''}<br><span class="muted">Model reading of the headline only, not verified facts. Not financial advice.</span></div></div>`).join('') || '<div class="empty">No scored headline matches these filters.</div>'}`;
  }
  async function load() {
    const [p, g] = await Promise.allSettled([J('/api/grok/pulse'), J('/api/grok?scored=1&limit=300')]);
    if (p.status === 'fulfilled') PU = p.value; if (g.status === 'fulfilled') GD = g.value;
    renderPulse(); renderFeed();
  }
  function init() {
    const pd = Q('#perpDesk'); if (!pd || Q('#gkPulse')) return;
    const meta = Q('#pdMeta'); const strip = document.createElement('div'); strip.id = 'gkPulse'; (meta || pd.querySelector('.phead')).after(strip);
    const panel = document.createElement('div'); panel.className = 'panel'; panel.id = 'grokNews';
    panel.innerHTML = `<div class="phead"><span>GROK NEWS FEED <span class="muted small">headline urgency · sentiment · tickers (xAI, cached, capped)</span></span></div>
      <div id="gkFilt">Token <input id="gkTok" size="6" placeholder="BTC"> Category <select id="gkCat"><option value="">all</option>${['hack', 'listing', 'regulation', 'macro', 'market', 'unlock', 'partnership', 'rumor', 'other'].map((c) => `<option>${c}</option>`).join('')}</select>
      Min urgency <select id="gkUrg"><option value="0">any</option><option>30</option><option>50</option><option>75</option></select> Sort <select id="gkSort"><option value="new">newest</option><option value="urg">most urgent</option></select></div>
      <div id="gkMeta" class="muted small" style="padding:0 8px"></div><div id="gkBody" class="pbody"><div class="empty">Loading…</div></div>`;
    pd.after(panel);
    const cur = Q('#pdTabs button.on'); if (cur) tab = cur.dataset.t;
    document.addEventListener('click', (e) => {
      const t = e.target.closest('#pdTabs button'); if (t) { tab = t.dataset.t; sel = null; renderPulse(); return; }
      if (e.target.closest('a') || e.target.closest('.ix')) return;
      const c = e.target.closest('#gkPulse .gkchip[data-k]'); if (c) { sel = sel === c.dataset.k ? null : c.dataset.k; renderPulse(); return; }
      const bc = e.target.closest('#gkPulse .gkchip[data-bid]'); if (bc) { openRows.add(bc.dataset.bid); renderFeed(); Q('#grokNews')?.scrollIntoView({ behavior: 'smooth' }); return; }
      const r = e.target.closest('#gkBody .gkrow'); if (r) { const id = r.dataset.id; openRows.has(id) ? openRows.delete(id) : openRows.add(id); r.classList.toggle('open'); }
    });
    const on = (id, k, f = (v) => v) => Q(id).addEventListener('input', (e) => { F[k] = f(e.target.value); renderFeed(); });
    on('#gkTok', 'tok', (v) => v.trim()); on('#gkCat', 'cat'); on('#gkUrg', 'minurg', Number); on('#gkSort', 'sort');
    load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 90e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
