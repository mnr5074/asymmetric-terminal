// Robinhood Chain utility scanner (research/rhscan/rh_scan.py -> /api/rhscan), shown under the Breakouts tab.
// PRIORS pre-breakout pattern: 45-70% pullback -> 2-day quiet base -> volume returns with a close above the base.
// Every card shows the signal strength from the scanner's own replay and the data time; plans are mechanical, not advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (x) => (x == null ? '—' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + Math.round(x / 1e3) + 'K' : '$' + Math.round(x));
  const px = (x) => (x == null ? '—' : Number(x).toPrecision(4));
  const PT = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
  function mount() {
    const host = Q('#viewBreakouts'); if (!host || Q('#rhPanel')) return !!host;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'rhPanel'; p.style.flex = 'none'; p.dataset.provRoute = '/api/rhscan';
    p.innerHTML = `<div class="phead"><h2>Robinhood Chain: PRIORS-pattern scanner</h2><span id="rhMeta" class="muted small"></span></div>
      <div class="bkintro muted">Utility tokens on Robinhood Chain that pulled back 45-70% from their high, went quiet for 2 days, then saw volume return with a close above that quiet base, which is how PRIORS set up before its ~10x from Sep 28. <b>Trigger</b> = every check passes now · <b>Setup</b> = base intact, waiting for volume · <b>Watch</b> = pattern OK but no utility evidence · <b>Extended / Broke base</b> = too late or failed. Sources: GeckoTerminal + DexScreener (free).</div>
      <div id="rhStr" class="bkintro"></div>
      <div class="bkfilters" id="rhF"><button data-f="act" class="on">Trigger / Setup / Watch</button><button data-f="named">iNu · HOOKR · PRIORS</button><button data-f="all">All scanned</button></div>
      <div id="rhOut" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;padding:6px 14px 14px"></div>
      <details class="more" id="rhCoilBox" style="margin:0 14px 6px"><summary id="rhCoilSum">Early tier: Coiled</summary><div id="rhCoil" class="bkhow"></div></details>
      <details class="more" style="margin:0 14px 14px"><summary>Rules, replay and caveats</summary><div id="rhHow" class="bkhow"></div></details>`;
    host.appendChild(p);
    Q('#rhF').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; F = b.dataset.f; Q('#rhF').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
    return true;
  }
  let D = null, F = 'act';
  const cls = (s) => ({ Trigger: 'l-breaking', Coiled: 'l-waking', Setup: 'l-waking', Watch: 'l-coiled' }[s] || '');
  const coilPlan = (x) => { const k = x.coiled, pl = k && k.plan; if (!pl) return '';
    return `<details class="more"><summary>${k.experimental ? 'Experimental Coiled plan (did not beat random)' : 'Coiled plan'}${k.monitorOnly ? ' · monitor only' : ''}</summary><div class="small" style="line-height:1.55">${E(k.reason)}<br>
      <b>Entry:</b> ${E(pl.entry)}<br><b>Size:</b> ${E(pl.size)}<br><b>Sell:</b><ul>${pl.sells.map((s) => `<li>${E(s)}</li>`).join('')}</ul><b>Walk away:</b><ul>${pl.walkAway.map((s) => `<li>${E(s)}</li>`).join('')}</ul></div></details>`; };
  const card = (x) => {
    const pl = x.plan; const ck = Object.entries(x.checks).map(([k, v]) => `<span style="color:${v ? 'var(--grn)' : 'var(--mut)'}">${v ? '✓' : '✗'} ${E(k)}</span>`).join(' ');
    return `<div class="bk ${cls(x.state)}"><div class="h"><b>${E(x.symbol)}</b><span class="lbl">${E(x.state)}</span>${x.named ? `<span class="muted small">${E(x.named)}</span>` : ''}<span class="sc num" style="font-size:1em">${x.passed}/${x.of}</span></div>
      <div class="muted small">${E(x.name)} · price ${px(x.price)} · liq ${usd(x.liqUsd)} · FDV ${usd(x.fdvUsd)} · 24h vol ${usd(x.vol24Usd)} · ${x.ageDays}d old</div>
      <div class="f">${ck}</div>
      <ul>${x.reasons.map((r) => `<li>${E(r)}</li>`).join('')}</ul>
      ${pl ? `<details class="more" ${x.state === 'Trigger' || x.state === 'Setup' ? 'open' : ''}><summary>Plan${pl.monitorOnly ? ' (monitor only)' : ''}</summary><div class="small" style="line-height:1.55">
        <b>Entry:</b> ${E(pl.entry)}<br><b>Size:</b> ${E(pl.size)}<br>${pl.sells && pl.sells.length ? `<b>Sell:</b><ul>${pl.sells.map((s) => `<li>${E(s)}</li>`).join('')}</ul>` : ''}
        <b>Walk away:</b><ul>${pl.walkAway.map((s) => `<li>${E(s)}</li>`).join('')}</ul>${pl.backtestNote ? `<span class="muted">${E(pl.backtestNote)}</span>` : ''}</div></details>` : ''}${coilPlan(x)}
      <div class="f"><span>strength <span class="str ${E(x.strength)}">${E(x.strength)}</span></span><span>price bar ${PT(x.priceAt)}</span><span>contract: ${x.contract.clean ? 'clean (GT)' : E(x.contract.flags.join('; ') || 'unknown')}</span><a href="${E(x.dexscreener)}" target="_blank" rel="noopener">DexScreener ↗</a></div>
      <details class="more"><summary>Token &amp; utility details</summary><div class="muted small">${E(x.token)}<br>${E(x.utility.description || 'no description on GeckoTerminal')}${x.utility.manual ? '<br>Manual review: ' + E(x.utility.manual) : ''}<br>${x.utility.websites.map((w) => E(w)).join(' · ')}${x.utility.twitter ? ' · @' + E(x.utility.twitter) : ''}<br>holders ${E(x.contract.holders)} · top-10 ${x.contract.top10 == null ? '—' : x.contract.top10.toFixed(1) + '%'} · dev ${x.contract.devPct == null ? '—' : x.contract.devPct + '%'} · GT score ${x.contract.gtScore == null ? '—' : Math.round(x.contract.gtScore)}</div></details></div>`;
  };
  function render() {
    if (!D || !mount()) return;
    const it = D.items.filter((x) => (F === 'all' ? true : F === 'named' ? !!x.named : ['Trigger', 'Coiled', 'Setup', 'Watch'].includes(x.state)));
    Q('#rhOut').innerHTML = it.length ? it.map(card).join('') : '<div class="muted" style="padding:10px">No token passes right now. Nothing to buy under this pattern.</div>';
  }
  async function load() {
    if (!mount()) return setTimeout(load, 1000);
    try { const r = await fetch('/api/rhscan'); D = await r.json(); if (D.error) throw new Error(D.error); } catch (e) { Q('#rhOut').innerHTML = `<div class="muted" style="padding:10px">Robinhood scan unavailable: ${E(e.message)}</div>`; return; }
    const c = (s) => D.items.filter((x) => x.state === s).length; const bt = D.backtest, bl = D.baseline || {};
    Q('#rhMeta').textContent = `scanned ${PT(D.generatedAt)} · ${c('Trigger')} trigger · ${c('Setup')} setup · ${c('Watch')} watch · ${D.universe.withHistory} tokens with 3d+ history of ${D.universe.tokens} seen`;
    Q('#rhStr').innerHTML = `Signal strength: <span class="str ${E(D.strength)}">${E(D.strength)}</span> ${E(D.strengthWhy)}.`;
    Q('#rhHow').innerHTML = `<table><tr><th>Rule</th><th>Definition</th></tr>${Object.entries(D.rules).map(([k, v]) => `<tr><td>${E(k)}</td><td>${E(v)}</td></tr>`).join('')}</table>
      <p><b>Replay</b> (price/volume rules only, ${E(bt.forward)}; win = ${E(bt.win)}): triggers n=${bt.n} on ${bt.tokens} tokens, ${bt.hit2xBeforeStop} wins (${bt.hit2xBeforeStopPct}%), ${bt.stoppedFirst} hit -30% first (${bt.stoppedFirstPct}%), median best ${bt.medianBest7d}x, median 7-day end ${bt.medianEnd7d}x.
      Baseline (${E(bl.what)}): n=${bl.n}, ${bl.hit2xBeforeStopPct}% wins, ${bl.stoppedFirstPct}% hit -30% first, median best ${bl.medianBest7d}x.</p>
      <ul>${bt.caveats.map((c) => `<li>${E(c)}</li>`).join('')}<li>${E(D.priorsCalibration ? D.priorsCalibration.note : '')}</li></ul>
      ${D.impostors.length ? `<p><b>Ignored copies:</b> ${D.impostors.map((i) => E(i.token.slice(0, 10)) + '…: ' + E(i.why)).join('; ')}</p>` : ''}`;
    renderCoil();
    render();
  }
  function renderCoil() {
    const k = D.coiled; if (!k) { Q('#rhCoilBox').style.display = 'none'; return; }
    const row = (lbl, r) => r && r.n ? `<tr><td>${E(lbl)}</td><td>${r.n}</td><td>${r.tokens}</td><td>${r.hitPct}%</td><td>${r.dropPct}%</td><td>${r.falseAlarmPct == null ? '—' : r.falseAlarmPct + '%'}</td><td>${r.planStopFirstPct == null ? '—' : r.planStopFirstPct + '%'}</td></tr>` : `<tr><td>${E(lbl)}</td><td>0</td><td colspan="5" class="muted">no completed signals</td></tr>`;
    const hdr = '<tr><th></th><th>n</th><th>tokens</th><th>2x before -30%</th><th>-30% first</th><th>no base break in 3d</th><th>plan stop first</th></tr>';
    Q('#rhCoilSum').innerHTML = `Early tier: Coiled · <span class="str ${E(k.strength)}">${k.ship ? 'live' : 'experimental — did not beat random'}</span>`;
    const cands = D.items.filter((x) => x.coiled);
    Q('#rhCoil').innerHTML = `<p>A very tight, quiet base after a 45-70% pullback, with volume starting to rise while price is still under the base top. Plan: starter at 1/4 size, stop on a 4h close 2% under the base low, add the rest only on a confirmed break of the base top (the Trigger).</p>
      <p><b>Status:</b> ${E(k.label)}. Strength: <span class="str ${E(k.strength)}">${E(k.strength)}</span>. Earlier/later split at ${E(k.splitUtc)} UTC (median date of the random sample).</p>
      <table>${hdr}${k.grid.map((g) => row(`T<=${g.T} V>=${g.V} · earlier`, g.early) + row(`T<=${g.T} V>=${g.V} · later`, g.late)).join('')}</table>
      <p><b>Later split comparison</b></p><table>${hdr}${row('Coiled (chosen cell)', k.chosenResult && k.chosenResult.late)}${row('Trigger (existing)', k.trigger.late)}${row('Random daily entry', k.random.late)}</table>
      <p><b>Current Coiled candidates</b> (cell T<=${k.displayCell.T}, V>=${k.displayCell.V}${k.chosen ? '' : ', the pre-declared display default'}): ${cands.length ? cands.map((x) => E(x.symbol)).join(', ') + ' (plans on their cards)' : 'none right now.'}</p>
      <details class="more"><summary>Pre-declared test</summary><pre style="white-space:pre-wrap;font-size:.85em">${E(k.preDeclared)}</pre></details>`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
  setInterval(load, 15 * 60e3);
})();
