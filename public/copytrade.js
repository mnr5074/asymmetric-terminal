// Wallets to watch (copy-trade watch, ALERTS ONLY — nothing here can trade) + Non-X chatter (Reddit / Telegram / forums / GitHub).
// Data: /api/copytrade (lib/copytrade.js) and /api/socialalt (lib/socialalt.js). Panels are injected after the Narratives Desk.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const U = (x) => (x == null ? '—' : x >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + Math.round(x));
  const S = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
  const ago = (t) => { if (!t) return '—'; const m = (Date.now() - t) / 60e3; return m < 60 ? Math.round(m) + 'm' : m < 1440 ? (m / 60).toFixed(1) + 'h' : (m / 1440).toFixed(1) + 'd'; };
  const get = (u) => (typeof api === 'function' ? api(u) : fetch(u).then((r) => r.json()));
  const G = window.EXPLAIN || {};
  Object.assign(G, {
    ct_score: ['Wallet score (0–100)', 'Realized profit (35, log scale, SOL), win rate (25, shrunk toward 50% when there are few trades), number of closed trades (10), consistency (20: profits not from a single token, positive on kolscan 1d/7d/30d) and being early on several catalog runners (10). Bots, MEV, first-slot (bundle/dev) buyers and Nansen-labelled bots/deployers are excluded.', null, 'Copy-trade'],
    ct_alert: ['Copy-trade text alert', 'A text goes out only when 2+ wallets from this list buy the same token the terminal is watching within 6 hours, through the same capped alert path as A-grade calls (hourly cap, quiet hours, dry run unless ALERTS_LIVE=1). It never places a trade.', null, 'Copy-trade'],
    nx_vel: ['Mention velocity', '(mentions in the last 24h + 1) / (mentions per day over the prior 72h + 1). 2.5+ with at least 5 mentions = spike.', null, 'Non-X'],
  });
  const I = (k) => (window.ix ? window.ix(k) : '');
  const css = document.createElement('style');
  css.textContent = `.ctp .chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700}.ctp .buy{color:#3fcf7f}.ctp .sell{color:#ff6b6b}.ctp .w{background:#1f6f3f;color:#fff}.ctp .lc{background:#5a4a10;color:#ffd}
  .ctp .tabs button{margin-right:4px}.ctp td.wrap{white-space:normal}.ctp .note{white-space:normal;padding:4px 8px}.ctp .rum{background:#7a1f1f;color:#fff}`;
  document.head.appendChild(css);
  let tab = 'wallets', chain = 'solana', D = null, X = null;
  function walletRows(ws) {
    if (chain !== 'solana') return ws.map((w) => `<tr><td>${w.rank}</td><td><a href="https://${chain === 'base' ? 'basescan.org' : 'bscscan.com'}/address/${E(w.address)}" target="_blank" rel="noopener">${S(w.address)}</a> ${w.nansenLabel ? `<span class="muted small">${E(w.nansenLabel)}</span>` : ''}</td><td class="r">${w.pnlUsd24h != null ? U(w.pnlUsd24h) : '—'}</td><td class="r">${w.nansenPnlUsd != null ? U(w.nansenPnlUsd) : '—'}</td><td class="r">${w.trades ?? '—'}</td><td class="wrap small">${E(Object.keys(w.tokens || {}).slice(0, 4).join(', '))}</td><td class="small muted wrap">${E(w.confidence || '')}</td></tr>`).join('');
    return ws.map((w) => { const le = w.lastEvent; const k = w.kolscan || {};
      return `<tr><td>${w.rank}</td><td><a href="https://solscan.io/account/${E(w.address)}" target="_blank" rel="noopener">${S(w.address)}</a>${w.name ? ` <b>${E(w.name)}</b>` : ''}${w.nansenLabel ? ` <span class="muted small">${E(w.nansenLabel)}</span>` : ''}</td><td class="r"><b>${w.score}</b></td>
      <td class="r">${w.realizedSol != null ? (w.realizedSol >= 0 ? '+' : '') + Math.round(w.realizedSol) + ' SOL' : '—'}</td><td class="r">${Math.round((w.winRate || 0) * 100)}% <span class="muted small">${w.wins}/${w.closedTrades}</span></td>
      <td class="r">${w.consistency}</td><td class="r">${w.earlyRunners || 0}</td><td class="small wrap">${(w.runners || []).slice(0, 3).map((r) => `${E(r.runner)} ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(1)}`).join(', ') || (k['30'] ? `kolscan 30d ${k['30'].profitSol} SOL` : '—')}</td>
      <td class="small">${le ? `<span class="${le.side}">${le.side}</span> ${E(le.symbol || S(le.mint))} ${le.sol} SOL · ${ago(le.t)}` : '<span class="muted">—</span>'}</td></tr>`; }).join('');
  }
  function render() {
    const box = Q('#ctOut'); if (!box) return;
    if (tab === 'chatter') return renderX(box);
    if (!D) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
    if (D.error) { box.innerHTML = `<div class="empty">${E(D.error)}</div>`; return; }
    const c = (D.chains || {})[chain] || {}; const ws = c.wallets || [];
    const st = D.status || {};
    Q('#ctMeta').textContent = `${(D.chains.solana?.wallets || []).length} SOL wallets · list ${Math.round((D.ageSec || 0) / 3600)}h old · polling ${st.polling ? 'on' : 'off'} (${st.ticks || 0} ticks, ${st.swaps || 0} swaps seen)`;
    const head = chain === 'solana' ? '<tr><th>#</th><th>Wallet</th><th class="r">Score ' + I('ct_score') + '</th><th class="r">Realized</th><th class="r">Win rate</th><th class="r">Consist.</th><th class="r">Early runs</th><th>Best runners</th><th>Last move</th></tr>'
      : '<tr><th>#</th><th>Wallet</th><th class="r">P&L 24h</th><th class="r">Nansen P&L</th><th class="r">Trades</th><th>Tokens</th><th>Confidence</th></tr>';
    const cf = (D.confluence || []).filter((x) => x.n >= 2);
    const ev = (D.events || []).slice(0, 25).map((e) => `<tr><td>${ago(e.t)}</td><td>#${e.rank} ${E(e.walletName || S(e.wallet))}</td><td class="${e.side}">${e.side}</td><td><a href="https://dexscreener.com/solana/${E(e.mint)}" target="_blank" rel="noopener">${E(e.symbol || S(e.mint))}</a> ${e.watched ? '<span class="chip w">watched</span>' : ''}${e.lowCapNew ? ' <span class="chip lc">new low-cap</span>' : ''}</td><td class="r">${e.sol} SOL</td><td class="r">${U(e.mcap)}</td><td class="small muted">${e.track?.realizedSol != null ? Math.round(e.track.realizedSol) + ' SOL · ' + Math.round((e.track.winRate || 0) * 100) + '%' : ''}</td></tr>`).join('');
    box.innerHTML = `<div class="ctp"><div class="note small">Alerts only — nothing here trades. ${I('ct_alert')} ${cf.length ? '<b>2+ top wallets in:</b> ' + cf.slice(0, 5).map((x) => `${E(x.symbol || S(x.mint))} (${x.n}${x.watched ? ', watched' : ''})`).join(', ') : 'No token has 2+ top-wallet buys in the last 6h.'}</div>
      <div class="tabs small" style="padding:2px 8px">${['solana', 'base', 'bsc'].map((k) => `<button class="btn ghost mini2${k === chain ? ' on' : ''}" data-ctc="${k}">${k}</button>`).join('')}</div>
      <table class="tbl"><thead>${head}</thead><tbody>${walletRows(ws) || '<tr><td colspan=9 class="empty">no wallets</td></tr>'}</tbody></table>
      ${chain === 'solana' ? `<div class="note small"><b>Recent moves</b></div><table class="tbl"><thead><tr><th>When</th><th>Wallet</th><th>Side</th><th>Token</th><th class="r">Size</th><th class="r">Mcap</th><th>Track record</th></tr></thead><tbody>${ev || '<tr><td colspan=7 class="empty">no swaps seen yet (polling rotates through the list)</td></tr>'}</tbody></table>` : ''}
      <div class="note small muted">${E((D.limits || []).join(' · '))}</div></div>`;
  }
  function renderX(box) {
    if (!X) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
    if (X.error) { box.innerHTML = `<div class="empty">${E(X.error)}</div>`; return; }
    Q('#ctMeta').textContent = `non-X docs 24h: ${Object.entries(X.docs?.last24h || {}).map(([k, v]) => k + ' ' + v).join(' · ')} · ${Math.round((X.ageSec || 0) / 60)}m old`;
    const rum = (X.rumors || []).slice(0, 12).map((r) => `<tr><td><b>${E(r.entity)}</b></td><td><span class="chip rum">${E(r.event)}</span></td><td class="r">${r.mentions}</td><td class="r">${r.channels}</td><td class="r">${r.velocity}×${r.spike ? ' ⚡' : ''}</td><td class="wrap small">${(r.evidence || []).slice(0, 2).map((e) => `<a href="${E(e.url)}" target="_blank" rel="noopener">${E(e.src)}</a>: ${E(e.text)}`).join('<br>')}</td></tr>`).join('');
    const ent = (X.entities || []).slice(0, 20).map((e) => `<tr><td><b>${E(e.entity)}</b></td><td class="r">${e.mentions24h}</td><td class="r">${e.perDayPrior72h}</td><td class="r">${e.velocity}×${e.spike ? ' ⚡' : ''}</td><td class="r">${e.sentiment ?? '—'}</td><td class="small">${E(Object.entries(e.sources).map(([k, v]) => k + ' ' + v).join(', '))}</td><td class="small">${E(Object.keys(e.events || {}).join(', '))}</td></tr>`).join('');
    const gov = (X.governance?.hotTopics || []).slice(0, 8).map((t) => `<tr><td>${E(t.forum)}</td><td class="wrap"><a href="${E(t.url)}" target="_blank" rel="noopener">${E(t.title)}</a></td><td class="r">${t.posts}</td><td class="r">${t.postsPerDay}/d</td></tr>`).join('');
    box.innerHTML = `<div class="ctp"><div class="note small"><b>Rumor candidates</b> (entity + event word in 2+ channels, or a spike)</div><table class="tbl"><thead><tr><th>Entity</th><th>Event</th><th class="r">Mentions</th><th class="r">Channels</th><th class="r">Velocity ${I('nx_vel')}</th><th>Evidence</th></tr></thead><tbody>${rum || '<tr><td colspan=6 class="empty">none</td></tr>'}</tbody></table>
      <div class="note small"><b>Most-mentioned (24h)</b></div><table class="tbl"><thead><tr><th>Entity</th><th class="r">24h</th><th class="r">Prior/day</th><th class="r">Velocity</th><th class="r">Sent.</th><th>Sources</th><th>Events</th></tr></thead><tbody>${ent}</tbody></table>
      <div class="note small"><b>Hot governance threads</b></div><table class="tbl"><tbody>${gov}</tbody></table><div class="note small muted">${E((X.limits || []).join(' · '))}</div></div>`;
  }
  async function load() {
    try { D = await get('/api/copytrade'); } catch (e) { D = { error: e.message }; }
    if (tab === 'chatter') { try { X = await get('/api/socialalt?compact=1'); } catch (e) { X = { error: e.message }; } }
    render();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctc]'); if (b) { chain = b.dataset.ctc; render(); return; }
    const t = e.target.closest('[data-ctt]'); if (t) { tab = t.dataset.ctt; document.querySelectorAll('[data-ctt]').forEach((x) => x.classList.toggle('on', x === t)); if (tab === 'chatter' && !X) load(); else render(); }
  });
  function ensurePanel() {
    if (Q('#ctOut')) return true;
    const after = Q('#narrPanel') || Q('#ccDesks'); if (!after) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'ctPanel'; el.style.flex = 'none';
    el.innerHTML = '<div class="phead"><span>WALLETS TO WATCH <span class="muted small">top wallets by realized P&L · alerts only</span> <span class="subtabs"><button data-ctt="wallets" class="on">Wallets</button><button data-ctt="chatter">Non-X chatter</button></span></span><span id="ctMeta" class="muted small"></span></div><div id="ctOut" class="pbody scroll" style="max-height:34vh;overflow:auto"><div class="empty">Loading…</div></div>';
    after.insertAdjacentElement('afterend', el); return true;
  }
  let started = false;
  function start() { if (started || !ensurePanel()) return; started = true; load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 2 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
