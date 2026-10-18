// Social Sentiment panel (Command view): /api/sentiment. Mention velocity, crypto-tuned tone, 0-100 oscillator, divergences.
// Data comes from the free built-in X read tools via the assistant-run collector (research/sentiment/COLLECTOR.md). Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const N = (x, d = 0) => (x == null || isNaN(x) ? '—' : (+x).toFixed(d));
  const PC = (x) => (x == null || isNaN(x) ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${(+x).toFixed(1)}%</span>`);
  const I = (k) => (window.ix ? window.ix(k) : '');
  Object.assign(window.EXPLAIN || {}, {
    sent_osc: ['Social oscillator (0–100)', '60% attention (how unusual the last 24h of X posts is vs the prior 6 days, as a z-score turned into a percentile) + 40% tone (weighted share of bullish vs bearish posts vs the norm for crypto X). Above 80 = euphoric crowd; below 20 = capitulation (negative tone) or silence (nobody talking). Used contrarian in the composite grade with a small weight.', null, 'Sentiment'],
    sent_tone: ['Bullish share', 'Of sampled posts with a clear opinion (VADER + crypto words like moon, send, ape, rug, dump, rekt, exit liquidity), the follower/engagement-weighted share that is bullish. Bots, shill lists, giveaway spam and duplicate texts are dropped. Crypto X is bullish most of the time, so ~80% is normal.', null, 'Sentiment'],
    sent_div: ['Divergence flags', '"High while cooling": price made a new 7-day high but mentions or tone are fading. "Spike, flat price": mentions jumped 2x+ (or z≥2) while price moved less than 3% in 24h.', null, 'Sentiment'],
  });
  const css = document.createElement('style');
  css.textContent = `.sent .chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase}
  .sent .z-euphoric{background:#8a1f1f;color:#fff}.sent .z-heated{background:#8a5a00;color:#fff}.sent .z-neutral{background:#262b33;color:#9aa}.sent .z-quiet{background:#1f3550;color:#cde}.sent .z-silence{background:#1f4f6f;color:#fff}.sent .z-capitulation{background:#1f6f3f;color:#fff}
  .sent .bar{display:inline-block;height:6px;background:#5a7;vertical-align:middle;margin-left:4px}.sent tr.srow{cursor:pointer}.sent .sdet{white-space:normal;padding:6px 8px;background:rgba(255,255,255,.03)}.sent .sfoot{white-space:normal;padding:4px 8px}`;
  document.head.appendChild(css);
  let D = null, open = null, detail = {}, started = false;
  async function load() {
    try { D = await (typeof api === 'function' ? api('/api/sentiment') : fetch('/api/sentiment').then((r) => r.json())); } catch (e) { const b = Q('#sentOut'); if (b) b.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return; }
    render();
  }
  function row(r) {
    const v = r.velocity, t = r.tone.last24h, p = r.price || {};
    const flags = r.divergences.map((f) => `<span class="chip z-heated" title="${E(f.text)}">${E(f.kind.replace(/_/g, ' '))}</span>`).join(' ');
    return `<tr class="srow" data-s="${E(r.sym)}"><td><b>${E(r.sym)}</b>${r.lowSample ? ' <span class="muted small">low n</span>' : ''}${r.suppressed ? ` <span class="chip z-heated" title="${E(r.suppressReason || '')}">unreliable</span>` : ''}${r.regime?.provisional ? ` <span class="muted small" title="${E(r.regime.note)}">new query</span>` : ''}</td><td class="r">${N(r.oscillator)}<span class="bar" style="width:${Math.round((r.oscillator || 0) / 2)}px"></span></td>
      <td><span class="chip z-${E(r.zone)}">${E(r.zone)}</span></td><td class="r">${v.c24.toLocaleString()}</td><td class="r">${v.ratio == null ? '—' : N(v.ratio, 2) + 'x'}</td><td class="r">${N(v.z, 1)}</td>
      <td class="r">${t.ok ? Math.round(t.bullShare * 100) + '%' : '—'} <span class="muted small">n${t.polar}</span></td><td class="r">${r.tone.delta == null ? '—' : (r.tone.delta >= 0 ? '+' : '') + Math.round(r.tone.delta * 100)}</td>
      <td class="r">${PC(p.ch24)}</td><td class="r">${PC(p.ch7d)}</td><td>${flags}</td></tr>` + (open === r.sym ? `<tr><td colspan="11" class="sdet">${det(r)}</td></tr>` : '');
  }
  function det(r) {
    const d = detail[r.sym]; const posts = d?.topPosts || [];
    const news = (r.news?.items || []).slice(0, 4).map((n) => `<li>${E(n.name)} <span class="muted small">${E((n.updated || '').slice(0, 10))}</span></li>`).join('');
    return `${r.suppressed ? `<div class="small">⚠ Unreliable, excluded from the composite: ${E(r.suppressReason || '')}</div>` : ''}${r.regime ? `<div class="small">↺ ${E(r.regime.note)}</div>` : ''}<div class="small">Query: <code>${E(r.query)}</code> · counts as of ${E(r.velocity.asOf)} · daily posts (oldest→newest): ${r.velocity.daily.join(', ')} · z vs market (BTC+ETH+SOL): ${N(r.zVsMarket, 1)}${r.weekend ? ' · weekend window' : ''}${r.grokNews ? ` · Grok headline tone ${r.grokNews.headlineTone} (n${r.grokNews.n})` : ''}</div>
      ${r.divergences.map((f) => `<div class="small">⚑ ${E(f.text)}</div>`).join('')}${news ? `<div class="small"><b>X news</b><ul>${news}</ul></div>` : ''}
      <div class="small"><b>Top weighted posts (bots removed)</b>${posts.length ? '<ul>' + posts.slice(0, 6).map((p) => `<li>${p.compound >= 0.05 ? '🟢' : p.compound <= -0.05 ? '🔴' : '⚪'} @${E(p.username)} (${(p.followers || 0).toLocaleString()} followers): ${E(p.text.slice(0, 160))}</li>`).join('') + '</ul>' : ' loading…'}</div>`;
  }
  function render() {
    const box = Q('#sentOut'); if (!box || !D) return;
    Q('#sentMeta').textContent = D.status || '';
    if (!D.tokens?.length) { box.innerHTML = `<div class="empty">${E(D.status)}</div>`; return; }
    const h = D.history; const callTxt = D.calls?.today ? `${D.calls.today.calls} collector X reads today` : '';
    box.innerHTML = `<div class="sent"><table class="tbl"><thead><tr><th>Token</th><th class="r">Osc ${I('sent_osc')}</th><th>Zone</th><th class="r">Posts 24h</th><th class="r">vs 7d</th><th class="r">z</th><th class="r">Bullish ${I('sent_tone')}</th><th class="r">Δ tone</th><th class="r">Px 24h</th><th class="r">Px 7d</th><th>Flags ${I('sent_div')}</th></tr></thead><tbody>${D.tokens.map(row).join('')}</tbody></table>
      ${D.regime ? `<div class="small" style="margin:4px 0">↺ ${E(D.regime.text)}${D.regime.provisional ? ' Provisional until ' + E(D.regime.provisionalUntil.slice(0, 10)) + '.' : ''}${D.suppressed?.length ? ' Unreliable (shown, not scored): ' + D.suppressed.map((x) => E(x.sym)).join(', ') + '.' : ''} Signal strength: unproven.</div>` : ''}<div class="sfoot small muted">${h?.summary_line ? '<b>Proxy backtest</b> (Wikipedia/Trends attention, not X): ' + E(h.summary_line) + ' · ' : ''}${E(callTxt)} · source: free X read tools via the assistant collector; lexicon ${E(D.lexicon || '')} · not financial advice</div></div>`;
  }
  document.addEventListener('click', async (e) => {
    const tr = e.target.closest('#sentOut tr.srow'); if (!tr || e.target.closest('.ix')) return;
    const s = tr.dataset.s; open = open === s ? null : s; render();
    if (open && !detail[s]) { try { detail[s] = await (typeof api === 'function' ? api('/api/sentiment?sym=' + encodeURIComponent(s)) : fetch('/api/sentiment?sym=' + encodeURIComponent(s)).then((r) => r.json())); } catch {} render(); }
  });
  function ensurePanel() {
    if (Q('#sentOut')) return true;
    const anchor = Q('#narrPanel') || (Q('#ccDesks') && Q('#ccDesks')); if (!anchor) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'sentPanel'; el.style.flex = 'none';
    el.innerHTML = '<div class="phead"><span>SOCIAL SENTIMENT <span class="muted small">X mention velocity · tone · oscillator · divergences · click a token</span></span><span id="sentMeta" class="muted small"></span></div><div id="sentOut" class="pbody scroll" style="max-height:34vh;overflow:auto"><div class="empty">Loading…</div></div>';
    anchor.insertAdjacentElement('afterend', el); return true;
  }
  function start() { if (started || !ensurePanel()) return; started = true; load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 10 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 50)); else setTimeout(start, 50);
  window.addEventListener('load', start);
})();
