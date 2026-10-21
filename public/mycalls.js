// Martin's Calls (owner ⋯ menu; guests get 403 for this script and /api/mycalls): Martin's own gut calls scored honestly.
// Each card: called time (PT), price at call vs live now, 1d/7d/30d results vs the chain's median token, and Gibi's verdict at the
// time scored on the same call. Scorecard says 'too few calls to judge' until 20 calls have a scored 7d result. Works from the
// frozen data/martin_calls_scored.json on Render; 'Now' is always the live /api/liveprice (DexScreener first) with the scoring-run
// price as a labelled fallback. Display only: the gut-bet size is a rule shown here, nothing is traded.
'use strict';
(function () {
  const Q = (s, r = document) => r.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PT = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
  const PTs = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' PT';
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const P = (v) => (v == null ? '—' : '$' + (v >= 1 ? v.toFixed(2) : v >= 1e-6 ? String(Number(Number(v).toPrecision(4))) : Number(v).toPrecision(4)));
  const pc = (x) => { if (x == null) return '—'; const v = Math.abs(x) < 0.0005 ? 0 : x; return `<span class="${v > 0 ? 'up' : v < 0 ? 'dn' : 'muted'}">${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%</span>`; };
  const CH = { solana: 'Solana', robinhood: 'Robinhood Chain' };
  const nav = Q('#viewNav');
  if (nav && !nav.querySelector('[data-v=mycalls]')) { const b = document.createElement('button'); b.dataset.v = 'mycalls'; b.textContent = "Martin's Calls"; b.title = 'Your own gut calls, scored vs the chain median and vs Gibi'; nav.appendChild(b); }
  const sec = document.createElement('section'); sec.id = 'viewMycalls'; sec.className = 'view'; sec.dataset.provRoute = '/api/mycalls';
  sec.innerHTML = `<div class="panel" style="flex:none"><div class="phead"><h2>Martin's Calls: how good is my gut?</h2><span id="mcMeta" class="muted small"></span></div>
    <div id="mcCard" class="mcsc"></div>
    <div id="mcBet" class="mcbet"></div>
    <div id="mcOut" class="mcgrid"></div>
    <details class="more" style="margin:0 14px 14px"><summary>How calls are scored</summary><div id="mcHow" class="bkhow"></div></details></div>`;
  (Q('#viewCommand') || document.body).after(sec);
  const css = document.createElement('style');
  css.textContent = `body[data-view=mycalls] main.grid{display:none}body[data-view=mycalls] #viewMycalls{display:flex;flex-direction:column;overflow:auto}
  .mcsc{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:12px 14px 4px}.mcsc>div{background:var(--panel2);border-radius:10px;padding:10px 12px}
  .mcsc b{display:block;font-size:1.35em;color:#fff;margin-top:2px}.mcsc .note{grid-column:1/-1;background:none;padding:2px 2px;line-height:1.5}
  @media(max-width:600px){.mcsc{grid-template-columns:1fr 1fr}.mcsc b{font-size:1.15em}}
  .mcbet{margin:6px 14px 4px;border-left:3px solid var(--amb);padding:6px 10px;line-height:1.5}
  .mcgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(380px,100%),1fr));gap:14px;padding:10px 14px 10px}
  .mc{background:var(--panel2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
  .mc .h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.mc .h b{font-size:1.2em;color:#fff}.mc .h .chip{font-size:.8em;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:0 8px}
  .mc .q{font-style:italic;color:#fff}.mc .px{font-size:1.05em;line-height:1.6}.mc .px .big{font-size:1.25em;font-weight:700}
  .mc table{width:100%;border-collapse:collapse;font-size:.92em}.mc td,.mc th{padding:4px 5px;border-bottom:1px solid #0f141b;text-align:right;white-space:nowrap}.mc th{color:var(--mut);font-weight:500}.mc td:first-child,.mc th:first-child{text-align:left}
  .mc .gibi{border-left:3px solid var(--blu);padding:4px 10px;line-height:1.5}.mc .f{font-size:.82em;color:var(--mut);display:flex;flex-wrap:wrap;gap:4px 12px}
  .mcstr{border-radius:999px;padding:1px 8px;font-size:.85em}.mcstr.few,.mcstr.unproven,.mcstr.weak{color:var(--amb);background:#2a1f08}.mcstr.backtested{color:var(--grn);background:#0b2418}`;
  document.head.appendChild(css);
  let D = null; const LIVE = new Map();
  const nowOf = (x) => { const v = LIVE.get(x.lk); if (v && v.p > 0) return { usd: v.p, label: `live ${E(v.src)}, fetched ${PTs(v.at || Date.now())}` };
    if (x.nowAtScore) return { usd: x.nowAtScore.usd, label: `${E(x.nowAtScore.src)} at last scoring, ${PT(x.nowAtScore.at)} (live price unavailable)` };
    if (x.lastCandle) return { usd: x.lastCandle.usd, label: `last hourly candle ${PT(x.lastCandle.closeAt)} (live price unavailable)` }; return null; };
  function results(x) {
    const H = ['1d', '7d', '30d'], hz = x.h || {}, gb = x.gibi || {};
    const done = H.filter((k) => hz[k] && hz[k].done), open = H.filter((k) => !(hz[k] && hz[k].done));
    const flags = (r) => [r.hit2x ? '<b class="up">2x</b>' : '', r.drop50 ? '<b class="dn">−50%</b>' : ''].filter(Boolean).join(' ');
    const gcell = (g) => (!g || g.pending ? '—' : g.entered ? pc(g.ret) : '0% <span class="muted small">out</span>');
    let h = '';
    if (done.length) h += `<table><tr><th></th><th>Gut</th><th>Best / worst</th><th>Chain median</th><th>Gibi</th></tr>${done.map((k) => { const r = hz[k], b = r.baseline || {}, w = (x.h2h || {})[k];
      return `<tr><td>${k}</td><td>${pc(r.ret)}${flags(r) ? ' ' + flags(r) : ''}${w === 'gut' ? ' ✓' : ''}</td><td>${pc(r.maxGain)} / ${pc(r.maxDD)}</td>
        <td>${b.median != null ? `${pc(b.median)} <span class="muted small">n=${b.n}${r.pctile != null ? ', beat ' + r.pctile + '%' : ''}</span>` : '<span class="muted small">pending</span>'}</td><td>${gcell(gb[k])}${w === 'gibi' ? ' ✓' : ''}</td></tr>`; }).join('')}</table>`;
    const k0 = open[0], r = k0 && hz[k0];
    if (r && r.ret != null) h += `<div class="small"><b>So far</b> <span class="muted">(${PT(r.asOf * 1000)}, not scored)</span>: gut ${pc(r.ret)}${flags(r) ? ' ' + flags(r) : ''} · best ${pc(r.maxGain)} / worst ${pc(r.maxDD)} · Gibi ${gcell(gb[k0])}</div>`;
    if (open.length) h += `<div class="muted small">Results due: ${open.map((k) => `${k} ${PT(((hz[k] || {}).endAt || (x.calledAt / 1000 + { '1d': 1, '7d': 7, '30d': 30 }[k] * 86400)) * 1000)}`).join(' · ')}</div>`;
    return h;
  }
  function gibiText(x) {
    const v = x.gibiDef || {}; const t = v.entryTrigger, w = v.walkAway;
    const s30 = (x.gibi || {})['30d'] || {}, s = ['1d', '7d', '30d'].map((k) => (x.gibi || {})[k]).find((z) => z && z.entered) || s30;
    let fired = '';
    if (t) fired = s && s.entered ? ` → <b>fired</b> ${PT(s.entryAt * 1000)} at ${P(s.entryPx)} (Gibi's entry${s.exitWhy === 'walk-away' ? `, walked away ${PT(s.exitAt * 1000)} at ${P(s.exitPx)}` : ''})` : s && s.why && /walk-away/.test(s.why) ? ` → ${E(s.why)}` : ' → not fired yet';
    return `<div class="gibi"><b>Gibi at the time: ${E((v.verdict || 'not recorded').toUpperCase())}</b>${v.why ? ` · ${E(v.why)}` : ''}
      ${t ? `<br>Entry trigger: ${E(t.tf)} close above ${P(t.closeAbove)}${fired}` : ''}${w ? `<br>Walk away: ${E(w.tf === '1d' ? 'daily' : w.tf)} close below ${P(w.closeBelow)}` : ''}</div>`;
  }
  function card(x) {
    const pa = x.priceAtCall || {}, n = nowOf(x), ch = n && pa.usd ? n.usd / pa.usd - 1 : null;
    const how = { reported: 'quoted at call time', live: 'fetched at call time', backfill: 'BACKFILLED from candles' }[pa.how] || pa.how;
    const ca = x.candleAtCall;
    return `<div class="mc"><div class="h"><b>${E(x.symbol)}</b><span class="chip">${E(CH[x.chain] || x.chain)}</span><span class="muted">called ${PT(x.calledAt)}</span></div>
      <div class="q">“${E(x.thesis || x.call)}”</div>
      <div class="px">At call <span class="big">${P(pa.usd)}</span> <span class="muted small" title="${E(pa.label)}">(${E(how)})</span> → now <span class="big mcnow">${n ? P(n.usd) : '…'}</span> ${pc(ch)}
        <br><span class="muted small">${n ? n.label : 'fetching live price…'}</span></div>
      ${x.unscored ? '<div class="muted">Not scored yet: scores fill in after the next 4h scan.</div>' : results(x)}
      ${gibiText(x)}
      <details class="more"><summary>Notes &amp; data</summary><div class="muted small" style="line-height:1.55">
        ${(x.notes || []).map((s) => `• ${E(s)}`).join('<br>')}${(x.notes || []).length ? '<br>' : ''}
        Price at call: ${E(pa.label)}${ca ? `<br>Cross-check: ${E(ca.how)} ${P(ca.usd)} at ${PT(ca.closeAt)} (${ca.vsPriceAtCallPct >= 0 ? '+' : ''}${ca.vsPriceAtCallPct}% vs price at call)` : ''}
        ${x.series ? `<br>Candles: ${E(x.series.how)}; fetched ${PT(x.series.fetchedAt)}${x.series.guard && x.series.guard.gtUsdMaxDiffLast48hPct != null ? ` · GeckoTerminal's own USD candles were off by up to ${x.series.guard.gtUsdMaxDiffLast48hPct}% over the last 48h${x.series.guard.gtUsdFlatHoursLast24 >= 3 ? ` and flat ${x.series.guard.gtUsdFlatHoursLast24} of the last 24 hours` : ''} (not used)` : ''}` : ''}
        <br><span style="font-family:monospace;word-break:break-all">${E(x.contract)}</span></div></details></div>`;
  }
  function scorecard() {
    const s = D.scorecard; if (!s) { Q('#mcCard').innerHTML = '<div class="note muted">No scoring run yet.</div>'; return; }
    const d7 = s.d7, d30 = s.d30, few = s.strength === 'too few';
    const vs = (d) => (d.n ? `${pc(d.gutMedian)} <span class="muted small">vs chain ${pc(d.baselineMedian)} · Gibi ${pc(d.gibiMedian)}</span>` : '<span class="muted">—</span>');
    Q('#mcCard').innerHTML = `<div>Calls<b>${s.calls}</b><span class="muted small">${d7.n} of ${s.minScored} needed have a 7d score</span></div>
      <div>Hit rate<b>${s.hitRate != null ? Math.round(100 * s.hitRate) + '%' : '—'}</b><span class="muted small">7d beat the chain median${d7.nBaseline ? ` (${d7.beatBaseline}/${d7.nBaseline})` : ''}</span></div>
      <div>Median 7d<b>${d7.n ? pc(d7.gutMedian) : '—'}</b><span class="small">${d7.n ? vs(d7) : '<span class="muted">none scored yet</span>'}</span></div>
      <div>Median 30d<b>${d30.n ? pc(d30.gutMedian) : '—'}</b><span class="small">${d30.n ? vs(d30) : '<span class="muted">none scored yet</span>'}</span></div>
      <div>Gut vs Gibi (7d)<b>${d7.gutWins}–${d7.gibiWins}${d7.ties ? '–' + d7.ties : ''}</b><span class="muted small">gut wins – Gibi wins${d7.ties ? ' – ties' : ''}</span></div>
      <div class="note"><span class="mcstr ${few ? 'few' : E(s.strength)}">${few ? 'too few calls to judge' : E(s.strength)}</span> ${E(s.strengthNote)}</div>`;
    const g = s.gutBet || {};
    Q('#mcBet').innerHTML = `<b>Gut bet rule:</b> ${E(g.pct)}% of portfolio per call until the scorecard proves an edge. <span class="muted">${E(g.status)} Display only: nothing here places or sizes a trade.</span>`;
  }
  function render() {
    if (!D) return;
    scorecard();
    Q('#mcOut').innerHTML = D.items.length ? D.items.map(card).join('') : '<div class="muted" style="padding:10px">No calls logged yet: <code>python3 scripts/log_call.py add …</code></div>';
    const m = D.method || {};
    Q('#mcHow').innerHTML = `<ul><li><b>Gut:</b> ${E(m.gut)}.</li><li><b>Chain median:</b> ${E(m.baseline)}. "You beat N%" = share of those tokens your call did better than.</li><li><b>Gibi:</b> ${E(m.gibi)}.</li><li><b>Hit rate:</b> ${E(m.hit)}.</li><li><b>Strength:</b> ${E(m.strength)}.</li>
      <li>Max gain / DD = best and worst hourly close after the call vs the price at call. 2x / −50% use the same closes. "So far" rows are unfinished windows and never count in the scorecard.</li>
      <li>Price at call is never invented: quoted at the time, fetched at logging, or backfilled from the nearest hourly candle and labelled BACKFILLED.</li>
      <li>Pools quoted in a tokenized stock (CYPH, NVDA) are rebuilt in USD via the quote token (GeckoTerminal's own USD candles for those pools can be stale).</li>
      <li>Baseline pool: ${Object.entries(D.baselinePool || {}).map(([c, b]) => `${E(CH[c] || c)} ${b.tokens} tokens through ${E(b.lastCompleteDayUtc)} UTC`).join(' · ')}.</li>
      <li>Add a call from chat: <code>python3 scripts/log_call.py add --symbol X --chain solana --contract … --call "his words" --time "2026-10-21 01:46" --gibi "stay out" --gibi-trigger 0.001</code>. Scores refresh after each 4h scan (free data, cached).</li></ul>`;
  }
  async function live() {
    if (!D || document.body.dataset.view !== 'mycalls' || document.hidden) return;
    const ks = [...new Set(D.items.map((x) => x.lk).filter(Boolean))]; if (!ks.length) return;
    try { const r = await (await fetch('/api/liveprice?k=' + encodeURIComponent(ks.join(',')))).json(); for (const [k, v] of Object.entries(r.px || {})) LIVE.set(k, v); render(); } catch {}
  }
  async function load() {
    try { const r = await fetch('/api/mycalls'); D = await r.json(); if (!r.ok || D.error) throw new Error(D.error || 'HTTP ' + r.status); }
    catch (e) { Q('#mcOut').innerHTML = `<div class="muted" style="padding:10px">Martin's Calls unavailable: ${E(e.message)}</div>`; return; }
    Q('#mcMeta').textContent = D.generatedAt ? `scored ${PT(D.generatedAt)} (${ago(D.generatedAt)}) · refreshes after each 4h scan` : 'not scored yet';
    render(); live();
  }
  nav && nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v === 'mycalls') load(); });
  if (document.body.dataset.view === 'mycalls') load();
  setInterval(live, 60e3); setInterval(() => { if (document.body.dataset.view === 'mycalls') load(); }, 15 * 60e3);
})();
