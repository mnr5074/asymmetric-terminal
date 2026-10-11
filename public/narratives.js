// Narratives Desk (Command view): theme rotation from free data (CoinGecko categories, DefiLlama, DexScreener, pump.fun,
// news RSS, Google News, Wikipedia pageviews). Click a theme for its tokens. Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const U = (x) => (typeof fUsd === 'function' ? fUsd(x) : x == null ? '—' : '$' + Math.round(x).toLocaleString());
  const P = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const LV = (x) => (x == null ? '—' : (Math.exp(x) - 1 >= 0 ? '+' : '') + ((Math.exp(x) - 1) * 100).toFixed(0) + '%');
  const I = (k) => (window.ix ? window.ix(k) : '');
  const G = window.EXPLAIN || {};
  Object.assign(G, {
    narr_momentum: ['Narrative momentum (0–100)', 'How strongly a theme is moving compared with all other themes right now: attention speed (30%), market-cap share change this week (20%) and month (5%), TVL growth (15%), share of its tokens going up (15%), new launches, DexScreener boosts and news share (5% each). It ranks themes against each other; it is not a price forecast.', null, 'Narratives'],
    narr_emerging: ['Emerging', 'Attention to this theme is growing much faster than the money in it: attention share up at least 50% vs its own baseline AND at least 30% faster than its market-cap share, while the sector has not already doubled in 30 days. This is the "people are noticing before price catches up" pattern.', null, 'Narratives'],
    narr_heating: ['Heating', 'Momentum 65+, its share of the crypto market cap up at least 2% this week, and attention not falling: money is already rotating in. Later than "emerging".', null, 'Narratives'],
    narr_attention: ['Attention velocity', 'Change in the theme\'s share of attention vs its own baseline: Wikipedia pageviews (last 7 days vs prior 28, relative to Bitcoin/Ethereum/crypto pages), Google News article pace (last 2 days vs the earlier 5, relative to other themes) and, as history builds, share of crypto headlines, new launches and DexScreener boosts.', null, 'Narratives'],
    narr_mcap: ['Market-cap share Δ7d', 'Change this week in the theme\'s slice of the whole crypto market cap (top 500 coins as the base), from CoinGecko category lists. Up = money rotating into the theme faster than the market.', null, 'Narratives'],
    narr_breadth: ['Breadth', 'Share of the theme\'s tokens (market cap ≥ $1M) that are up over the week. A rally where only one or two leaders rise and the rest fall is fragile.', null, 'Narratives'],
    narr_tvl: ['TVL growth 7d', 'Change in money deposited in the theme\'s DeFi protocols (DefiLlama categories; for L2s the chains\' total TVL). Only some themes have TVL.', null, 'Narratives'],
    narr_launch: ['New launches', 'Brand-new tokens (under 24 hours old) seen on pump.fun, DexScreener profiles/boosts and the live feed whose name or description matches the theme. Many launches = interest, too many = a crowded trade.', null, 'Narratives'],
    narr_crowd: ['Overcrowding caution', 'Warning signs that a theme is late: a flood of new copycat launches relative to its news attention, new entrants losing money (median 24h return negative and worse than other new tokens, or falling), and breadth deteriorating (the sector is up but most of its tokens are now down). One sign = caution, two or more = overcrowded.', null, 'Narratives'],
    narr_boost: ['Narrative boost', 'Points added to a token\'s composite score when it is in an emerging (+6) or heating (+4) theme AND it matches the pump detector\'s early-launch / pre-graduation pattern (half without the pattern). Overcrowded themes give −3 instead. Read from data/narratives_boost.json.', null, 'Narratives'],
    narr_valid: ['Backtest on privacy / ZEC', 'The same "emerging" rule replayed day by day on Wikipedia attention for Zcash/Monero/Tornado Cash/Dash vs a ZEC+XMR+DASH market-cap basket, to see when it would have fired relative to each ZEC run.', null, 'Narratives'],
    narr_x: ['X social velocity (off)', 'Optional input from the paid X API: post counts per theme. It is switched off; the panel shows what it would cost per day so you can decide.', null, 'Narratives'],
  });
  const css = document.createElement('style');
  css.textContent = `.narr .chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase}
  .narr .c-emerging{background:#1f6f3f;color:#fff}.narr .c-heating{background:#8a5a00;color:#fff}.narr .c-cooling{background:#333;color:#aaa}.narr .c-neutral{background:#262b33;color:#9aa}
  .narr .w-overcrowded{background:#7a1f1f;color:#fff}.narr .w-caution{background:#5a4a10;color:#ffd}.narr tr.nrow{cursor:pointer}.narr tr.nrow.sub td:nth-child(2){padding-left:14px;opacity:.9}
  .narr .ndet{padding:6px 8px;background:rgba(255,255,255,.03);white-space:normal;max-width:calc(100vw - 60px)}.narr .nfoot{white-space:normal}.narr td.dwrap{white-space:normal}.narr .ndet table{width:100%}.narr .nfoot{padding:4px 8px}.narr .nplain{margin:3px 0 6px}`;
  document.head.appendChild(css);
  let D = null, open = null, started = false;
  async function load() {
    const box = Q('#narrOut'); if (!box) return;
    try { D = await (typeof api === 'function' ? api('/api/narratives') : fetch('/api/narratives').then((r) => r.json())); }
    catch (e) { box.innerHTML = `<div class="empty">${E(e.message)}</div>`; return; }
    if (D.error) { box.innerHTML = `<div class="empty">${E(D.error)}</div>`; return; }
    render();
  }
  function chip(s) { return `<span class="chip c-${E(s)}">${E(s)}</span>${s === 'emerging' ? I('narr_emerging') : s === 'heating' ? I('narr_heating') : ''}`; }
  function crowd(c) { return c === 'ok' ? '<span class="muted small">ok</span>' : `<span class="chip w-${E(c)}">${E(c)}</span>`; }
  function render() {
    const T = D.themes || [];
    const flagged = T.filter((t) => t.status === 'emerging' || t.status === 'heating');
    const crowded = T.filter((t) => t.crowdLevel !== 'ok');
    Q('#narrMeta').textContent = `${T.length} themes · updated ${Math.round((D.ageSec || 0) / 60)}m ago${D.refreshing ? ' · refreshing…' : ''}`;
    const head = `<div class="nfoot small">${flagged.length ? '<b>Flagged:</b> ' + flagged.map((t) => `${E(t.name)} (${t.status})`).join(', ') : 'No theme flagged emerging or heating right now.'}${crowded.length ? ` · <b>Caution:</b> ${crowded.map((t) => E(t.name) + ' (' + t.crowdLevel + ')').join(', ')}` : ''}</div>`;
    const rows = T.map((t, i) => `<tr class="nrow${t.parent ? ' sub' : ''}" data-n="${E(t.id)}"><td>${t.rank}</td><td><b>${E(t.name)}</b></td><td>${chip(t.status)}</td><td class="r">${t.momentum ?? '—'}</td><td class="r">${LV(t.attentionVel)} <span class="muted small">${Object.keys(t.attentionParts || {}).length}src</span></td><td class="r">${LV(t.mcapShareVel7)}</td><td class="r">${P(t.mcapGrowth7, 1)}</td><td class="r">${t.breadth7 != null ? Math.round(t.breadth7 * 100) + '%' : '—'}</td><td class="r">${P(t.tvlGrowth7, 1)}</td><td class="r">${t.launches24}</td><td class="r">${U(t.mcap)}</td><td>${crowd(t.crowdLevel)}</td></tr>${open === t.id ? `<tr><td colspan="12" class="dwrap">${detail(t)}</td></tr>` : ''}`).join('');
    Q('#narrOut').innerHTML = `<div class="narr">${head}<table class="tbl"><thead><tr><th>#</th><th>Theme</th><th>Status</th><th class="r">Mom. ${I('narr_momentum')}</th><th class="r">Attention ${I('narr_attention')}</th><th class="r">Mcap share 7d ${I('narr_mcap')}</th><th class="r">Mcap 7d</th><th class="r">Breadth ${I('narr_breadth')}</th><th class="r">TVL 7d ${I('narr_tvl')}</th><th class="r">Launch 24h ${I('narr_launch')}</th><th class="r">Mcap</th><th>Crowding ${I('narr_crowd')}</th></tr></thead><tbody>${rows}</tbody></table>${foot()}</div>`;
  }
  function detail(t) {
    const tk = (t.tokens || []).map((c) => `<tr><td><b>${E(c.symbol)}</b> <span class="muted small">${E(c.name)}</span></td><td class="r">${U(c.mcap)}</td><td class="r">${c.ch24 ?? '—'}%</td><td class="r">${c.ch7 ?? '—'}%</td><td class="r">${c.ch30 ?? '—'}%</td></tr>`).join('');
    const nt = (t.newTokens || []).map((c) => `<tr><td><b>${E(c.symbol || c.address.slice(0, 6))}</b> <span class="muted small">${E(c.chain)}${c.preGrad ? ' · pre-grad' : ''}</span></td><td class="r">${c.ageH != null ? c.ageH.toFixed(1) + 'h' : '—'}</td><td class="r">${U(c.mcap)}</td><td class="r">${c.ch24 != null ? c.ch24.toFixed(0) + '%' : '—'}</td><td>${E(c.grade || '')}</td></tr>`).join('');
    const ap = Object.entries(t.attentionParts || {}).map(([k, v]) => `${k} ${LV(v)}`).join(' · ') || 'no attention source for this theme yet';
    return `<div class="ndet small"><div class="nplain">${E(t.plain)}</div><div class="muted">${E(t.blurb)}</div>
      <div>Attention sources: ${E(ap)}${t.wiki ? ` · Wikipedia ${t.wiki.views7d.toLocaleString()} views/7d (${E(t.wiki.articles.join(', '))})` : ''}${t.googleNews?.n7d != null ? ` · Google News ${t.googleNews.n7d}${t.googleNews.saturated ? '+' : ''} articles/7d` : ''} · RSS headlines 72h: ${t.rss?.h72 ?? 0}</div>
      <div>Breadth 24h/7d/30d: ${[t.breadth24, t.breadth7, t.breadth30].map((x) => (x != null ? Math.round(x * 100) + '%' : '—')).join(' / ')} · mcap 30d ${P(t.mcapGrowth30, 0)} · ${t.nCoins} tokens (CoinGecko: ${E((t.cgCategories || []).join(', '))})${t.tvl ? ` · TVL ${U(t.tvl)} (${E((t.tvlSources || []).join(', '))})` : ''}</div>
      ${(t.crowding || []).length ? `<div class="dn">⚠ ${t.crowding.map(E).join('<br>⚠ ')}</div>` : ''}
      ${(t.headlines || []).length ? `<div class="muted">News: ${t.headlines.map(E).join(' · ')}</div>` : ''}
      <div style="display:flex;gap:10px;flex-wrap:wrap"><table class="tbl" style="flex:1;min-width:280px"><thead><tr><th>Top tokens</th><th class="r">Mcap</th><th class="r">24h</th><th class="r">7d</th><th class="r">30d</th></tr></thead><tbody>${tk || '<tr><td colspan=5 class="empty">none</td></tr>'}</tbody></table>
      <table class="tbl" style="flex:1;min-width:260px"><thead><tr><th>New launches (&lt;72h) ${I('narr_boost')}</th><th class="r">Age</th><th class="r">Mcap</th><th class="r">24h</th><th>Gr</th></tr></thead><tbody>${nt || '<tr><td colspan=5 class="empty">none seen</td></tr>'}</tbody></table></div></div>`;
  }
  function foot() {
    const v = D.validation; const x = D.xModule || {};
    let vt = 'Backtest not generated yet.';
    if (v) {
      const e = (v.episodes || []).map((e) => e.firstFlag ? `run from ${fd(e.start)} ($${e.startPx}) → peak ${fd(e.peak)} ($${e.peakPx}): flagged ${fd(e.firstFlag)} at $${e.flagPx}, ${e.daysVsStart} days after the run began, ${e.daysBeforePeak} days before the peak (+${Math.round(e.upsideLeftToPeak * 100)}% left)` : `run from ${fd(e.start)} ($${e.startPx}) → peak ${fd(e.peak)} ($${e.peakPx}): not flagged`).join('; ');
      vt = `${e}. Flags outside runs: ${v.flagsOutsideEpisodes} days.`;
    }
    const plan = (x.plans || []).find((p) => p.refresh === 'every 3h');
    return `<div class="nfoot small"><b>ZEC backtest</b> ${I('narr_valid')}: ${E(vt)}</div>
      <div class="nfoot small muted"><b>X social velocity</b> ${I('narr_x')}: OFF (no X calls). If enabled: ${plan ? `${plan.countsRequestsPerDay} count requests/day ≈ $${plan.countsUsdPerDay}/day via counts endpoint (reading 20 posts per theme instead ≈ $${plan.postsUsdPerDay_20each}/day)` : '—'}.
      · Sources: ${E(Object.entries(D.sources || {}).filter(([, s]) => typeof s === 'string' && !/^ok/.test(s)).map(([k, s]) => k + ': ' + s).join(' · ') || 'all ok')}</div>`;
  }
  const fd = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '—');
  document.addEventListener('click', (e) => { const tr = e.target.closest('#narrOut tr.nrow'); if (!tr || e.target.closest('.ix')) return; open = open === tr.dataset.n ? null : tr.dataset.n; render(); });
  function applyFold() { const c = localStorage.getItem('narrCollapsed') === '1'; const o = Q('#narrOut'), b = Q('#narrToggle'); if (o) o.style.display = c ? 'none' : ''; if (b) b.textContent = c ? '▸' : '▾'; }
  document.addEventListener('click', (e) => { if (!e.target.closest('#narrToggle')) return; localStorage.setItem('narrCollapsed', localStorage.getItem('narrCollapsed') === '1' ? '0' : '1'); applyFold(); });
  // the panel is injected here (after the desk cards) so index.html only needs the <script> tag
  function ensurePanel() {
    if (Q('#narrOut')) return true;
    const desks = Q('#ccDesks'); if (!desks) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'narrPanel'; el.style.flex = 'none';
    el.innerHTML = '<div class="phead"><span>NARRATIVES DESK <span class="muted small">theme rotation · attention vs money · click a theme</span></span><span><span id="narrMeta" class="muted small"></span> <button id="narrToggle" class="btn ghost mini2" title="collapse / expand">▾</button></span></div><div id="narrOut" class="pbody scroll" style="max-height:34vh;overflow:auto"><div class="empty">Loading…</div></div>';
    desks.insertAdjacentElement('afterend', el); return true;
  }
  function start() { if (started || !ensurePanel()) return; started = true; applyFold(); load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 5 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
