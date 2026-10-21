// Waking Up panel (Breakouts tab, top): tokens showing revival signs BEFORE a breakout (research/waking/waking.py -> /api/waking).
// Works from the frozen data/waking.json snapshot on Render. Verdict banner first: if no pool beat random out-of-sample, this is
// an experimental watch list with NO phone alerts, and it says so.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const px = (x) => (x == null ? '—' : Number(x).toPrecision(4));
  const usd = (x) => (x == null ? '—' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + Math.round(x / 1e3) + 'K' : '$' + Math.round(x));
  const PT = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const pct = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + x + '%');
  const STC = { 'cheaper than flag': 'var(--grn)', 'above flag': 'var(--amb)', 'broke out': 'var(--blu,#6af)', invalidated: 'var(--red,#e55)' };
  const NAMEP = { solana: 'Solana', robinhood: 'Robinhood Chain', majors: 'Majors (Binance)' };
  let D = null, F = 'dex', MORE = false;
  function mount() {
    const host = Q('#viewBreakouts'); if (!host) return false; if (Q('#wkPanel')) return true;
    const p = document.createElement('div'); p.className = 'panel'; p.id = 'wkPanel'; p.style.flex = 'none'; p.dataset.provRoute = '/api/waking';
    p.innerHTML = `<div class="phead"><h2>Waking Up: revival signs before a breakout</h2><span id="wkMeta" class="muted small"></span></div>
      <div id="wkVerdict" class="bkintro" style="border-left:3px solid var(--amb);padding-left:10px;margin:0 14px 8px"></div>
      <div class="bkintro muted">After a long dead stretch: volume up 3+ of the last 4 days off a low base (not one spike), a higher low, and price still at the base, so the entry is below where the breakout Trigger would buy. <b>Cheaper than flag</b> = at/below the flag price, base intact · <b>Above flag</b> = still in the buy zone · <b>Broke out</b> = past the cheap zone · <b>Invalidated</b> = walk-away hit or safety veto.</div>
      <div class="bkfilters" id="wkF"><button data-f="dex" class="on">Solana + Robinhood</button><button data-f="majors">Majors</button><button data-f="named">Named</button><button data-f="all">All</button></div>
      <div id="wkOut" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;padding:6px 14px 6px"></div>
      <div style="padding:0 14px 8px"><button id="wkMore" class="muted" style="display:none;background:#0a0e14;border:0;color:var(--mut);padding:8px 14px;border-radius:999px;cursor:pointer"></button></div>
      <details class="more" style="margin:0 14px 14px"><summary>Backtest: signal vs random, by chain and period</summary><div id="wkHow" class="bkhow"></div></details>`;
    const first = host.querySelector('.panel'); first ? host.insertBefore(p, first) : host.appendChild(p);
    Q('#wkF').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; F = b.dataset.f; MORE = false; Q('#wkF').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
    Q('#wkMore').addEventListener('click', () => { MORE = true; render(); });
    return true;
  }
  const poolOf = (x) => (x.chain === 'solana' ? 'solana' : x.chain === 'robinhood' ? 'robinhood' : 'majors');
  function card(x) {
    const L = x.flag || {}, pl = x.plan || {}, c = x.ctx || {}, col = STC[x.status] || 'var(--mut)';
    const addr = x.contract || (x.pair ? x.pair + ' (CEX pair, no contract)' : '—');
    const safety = x.grade === 'F' ? `<b style="color:var(--red,#e55)">Grade F · ${E(c.veto)}</b>` : `safety: ${E(x.grade)}${c.top10 != null ? ` · top-10 ${c.top10.toFixed(1)}%` : ''}${c.holders ? ` · ${Number(c.holders).toLocaleString()} holders` : ''}${c.liqUsd ? ` · liq ${usd(c.liqUsd)}` : ''}`;
    const live = (c.signs || []);
    return `<div class="bk" style="box-shadow:inset 3px 0 0 ${col}">
      <div class="h"><b>${E(x.symbol)}</b><span class="muted small">${E(NAMEP[poolOf(x)])}</span>${x.named ? `<span class="muted small">${E(x.named)}</span>` : ''}${x.longbook ? '<span class="muted small">long book</span>' : ''}<span class="lbl" style="margin-left:auto;color:${col};font-weight:700">${E(x.status)}</span></div>
      <div style="font-size:1.05em">Flag <b class="num">${px(L.flagPrice)}</b> → now <b class="num">${px(x.priceNow)}</b> <b style="color:${x.changePct <= 0 ? 'var(--grn)' : 'var(--amb)'}">${pct(x.changePct)}</b></div>
      <div class="muted small">${E(x.statusWhy)}</div>
      ${x.priceCheck && x.priceCheck.warn ? `<div class="small" style="color:var(--red,#e55)">⚠ ${E(x.priceCheck.warn)}</div>` : ''}${x.usdNote ? `<div class="small muted">ⓘ ${E(x.usdNote)}</div>` : ''}
      <div class="small"><b>Wake-up signs (scored):</b><ul>${(x.signs || []).map((s) => `<li>${E(s)}</li>`).join('')}</ul>
        <b>Live context (not scored):</b> ${live.length ? `<ul>${live.map((s) => `<li>${E(s)}</li>`).join('')}</ul>` : '<span class="muted">none firing' + (x.x ? ` · X: ${x.x.last24h} mentions 24h vs ${x.x.avgPrior6d}/day` : '') + '</span>'}</div>
      <div class="small">${safety}</div>
      <div class="small" style="line-height:1.5"><b>Plan:</b> ${E(pl.entry)}<br><b>Size:</b> ${E(pl.size)}<br><b>Walk away:</b> ${E((pl.walkAway || [])[0])}
        <details class="more"><summary>Sells and full walk-away</summary><ul>${(pl.sells || []).map((s) => `<li>${E(s)}</li>`).join('')}</ul><ul>${(pl.walkAway || []).map((s) => `<li>${E(s)}</li>`).join('')}</ul></details></div>
      <div class="f"><span>first flagged ${PT(L.firstFlaggedAt)}${L.how && L.how !== 'live' ? ' (replayed: signal day close)' : ''}</span><span>updated ${PT(x.updatedAt)}</span><span>price as of ${PT(x.priceNowAt)} (${ago(x.priceNowAt)})</span>
        <span>strength <span class="str ${E(x.strength)}">${E(x.strength)}</span></span>${x.dexscreener ? `<a href="${E(x.dexscreener)}" target="_blank" rel="noopener">DexScreener ↗</a>` : ''}</div>
      <div class="muted small" style="word-break:break-all;font-family:monospace">${E(addr)}</div></div>`;
  }
  function namedRows() {
    return `<div style="grid-column:1/-1" class="bkhow"><table><tr><th>Token</th><th>Where it lands</th></tr>${(D.named || []).map((n) => {
      let w;
      if (n.card) w = `<b>${E(n.card.status)}</b> · flagged ${PT(n.card.flag.firstFlaggedAt)} at ${px(n.card.flag.flagPrice)}, now ${px(n.card.priceNow)}`;
      else if (n.inScan) w = `scanned, not waking (${n.passed}/7 conditions${n.nowM ? `; 21-day base range ${n.nowM.qRange}x, ${n.nowM.ddPct}% below its high` : ''}). Missing: ${Object.entries(n.now || {}).filter(([, v]) => !v).map(([k]) => ({ tradable: 'below volume floor', dead: 'not a dead stretch', down: 'not 40%+ down', flat: 'base not flat', rising: 'volume not rising 3 of 4 days', hl: 'no higher low', near: 'already above the base' }[k])).join(', ') || 'no signal in the last 14 days'} · price ${px(n.priceNow)}${n.grade ? ' · ' + E(n.grade) : ''}${n.ctx && n.ctx.top10 != null ? ' · top-10 ' + n.ctx.top10.toFixed(1) + '%' : ''}${n.ctx && n.ctx.holders ? ' · ' + Number(n.ctx.holders).toLocaleString() + ' holders' : ''}${n.ctx && n.ctx.liqUsd ? ' · liq ' + usd(n.ctx.liqUsd) : ''}${n.ctx && n.ctx.flags && n.ctx.flags.length ? ' · ' + E(n.ctx.flags.join('; ')) : ''}`;
      else { const pc = n.desc && n.desc.priceCheck; w = `not scored: ${E(n.why)}${n.desc ? `<br><span class="muted">${E(n.desc.read)} · scanner price ${px(n.desc.priceNow)} (last day ${E(n.desc.lastDay)})</span>` : ''}`
        + (pc ? `<br><span class="${Math.abs(pc.devPct) > 25 ? '' : 'muted'}">price check: DexScreener ${px(pc.dexscreener)}${pc.jupiter ? ' · Jupiter ' + px(pc.jupiter) : ''}${pc.gtPool ? ' · GeckoTerminal pool ' + px(pc.gtPool) : ''}${Math.abs(pc.devPct) > 25 ? ` ⚠ scanner series off by ${pc.devPct}%` : ''}</span>` : '')
        + (n.grade ? `<br>${n.grade === 'F' ? `<b style="color:var(--red,#e55)">Grade F · ${E(n.ctx.veto)}</b>` : E(n.grade)}${n.ctx && n.ctx.top10 != null ? ' · top-10 ' + n.ctx.top10.toFixed(1) + '%' : ''}${n.ctx && n.ctx.holders ? ' · ' + Number(n.ctx.holders).toLocaleString() + ' holders' : ''}${n.ctx && n.ctx.liqUsd ? ' · liq ' + usd(n.ctx.liqUsd) : ''}` : ''); }
      if (n.x) w += `<br><span class="muted">X: ${n.x.last24h} mentions in 24h vs ${n.x.avgPrior6d}/day the prior 6 days${n.x.note ? ' (' + E(n.x.note) + ')' : ''}</span>`;
      return `<tr><td><b>${E(n.label)}</b><br><span class="muted small" style="font-family:monospace">${E(n.token)}</span></td><td>${w}</td></tr>`; }).join('')}</table></div>`;
  }
  function render() {
    if (!D || !mount()) return;
    if (F === 'named') { Q('#wkOut').innerHTML = namedRows(); Q('#wkMore').style.display = 'none'; return; }
    const it = D.items.filter((x) => F === 'all' || (F === 'majors' ? poolOf(x) === 'majors' : poolOf(x) !== 'majors'));
    const show = MORE ? it : it.slice(0, 9);
    Q('#wkOut').innerHTML = show.length ? show.map(card).join('') : `<div class="muted" style="padding:10px">Nothing waking up on ${F === 'majors' ? 'majors' : 'Solana / Robinhood Chain'} in the last 14 days.</div>`;
    Q('#wkMore').style.display = it.length > show.length ? '' : 'none'; Q('#wkMore').textContent = `Show ${it.length - show.length} more`;
    if (F === 'dex' && (D.closest || []).length) Q('#wkOut').insertAdjacentHTML('beforeend', `<div style="grid-column:1/-1" class="bkhow"><b>Closest to waking on Solana / Robinhood Chain</b> <span class="muted small">(not flagged, not a signal: 5-6 of the 7 conditions on the last complete UTC day)</span>
      <table><tr><th>Token</th><th>Chain</th><th>Passes</th><th>Missing</th><th>Last 4 days volume vs quiet base</th><th>Base</th></tr>${D.closest.map((r) => `<tr><td><b>${E(r.symbol)}</b><br><span class="muted small" style="font-family:monospace">${E(r.contract)}</span></td><td>${E(NAMEP[r.chain] || r.chain)}</td><td>${r.passed}/7</td><td>${E(r.missing.join(', '))}</td><td>${r.volLast4VsBase.map((z) => z == null ? '—' : z + 'x').join(' · ')}</td><td>${px(r.baseLow)}–${px(r.baseTop)} (${r.qRange}x)</td></tr>`).join('')}</table></div>`);
  }
  function how() {
    const r = (lbl, x, rnd) => `<tr><td>${lbl}</td><td>${x.n}</td><td>${x.tokens}</td><td>${x.hit2xPct ?? '—'}%</td><td>${x.drop50Pct ?? '—'}%</td><td>${pct(x.medR7)}</td><td>${pct(x.medR14)}</td><td>${pct(x.medR30)}</td></tr>`;
    const rows = ['solana', 'robinhood', 'majors'].map((p) => { const b = D.backtest[p]; if (!b) return '';
      const per = (k, nm) => { const x = b[k] || {}; if (!x.n) return `<tr><td>${nm}</td><td>0</td><td colspan="6" class="muted">no completed signals</td></tr>`;
        const R = x.random || {}, Qn = x.quietNotWaking || {}, B = x.breakout || {};
        return r(`<b>${nm}</b> signal`, x) + `<tr class="muted"><td>${nm} random, same dates</td><td>${R.pairs}</td><td></td><td>${R.hit2xPct}%</td><td>${R.drop50Pct}%</td><td>${pct(R.medR7)}</td><td>${pct(R.medR14)}</td><td>${pct(R.medR30)}</td></tr>`
          + `<tr class="muted"><td>${nm} quiet, not waking</td><td>${Qn.pairs}</td><td></td><td>${Qn.hit2xPct ?? '—'}%</td><td>${Qn.drop50Pct ?? '—'}%</td><td></td><td></td><td>${pct(Qn.medR30)}</td></tr>`
          + `<tr class="muted"><td colspan="8">${B.followedPct}% later broke out (daily Trigger analogue), median ${B.medLeadDays ?? '—'} days earlier and ${B.medCheaperPct ?? '—'}% cheaper than the breakout close${B.fromBreakout && B.fromBreakout.n ? `; on those events 30d median from flag ${pct(B.sameEventsFromFlag.medR30)} vs from breakout ${pct(B.fromBreakout.medR30)} (needs hindsight: you only know it broke out afterwards)` : ''}. Net (2x% − drop%) ${x.net} vs random ${x.randomNet}: ${x.beats ? '<b style="color:var(--grn)">beats random</b>' : '<b>does not beat random</b>'}.</td></tr>`; };
      return `<tr><th colspan="8">${E(NAMEP[p])} · ${b.tokens} tokens · ${E(b.firstDay)} → ${E(b.lastDay)} · split ${E(b.splitUtc)} · <span class="str ${E(b.strength)}">${E(b.strength)}</span> ${E(b.strengthWhy)}</th></tr>${per('earlier', 'Earlier')}${per('later', 'Later')}`; }).join('');
    const rh = D.rhRealTrigger || {};
    Q('#wkHow').innerHTML = `<p>Signal and test were fixed before any outcome was computed (<code>${E(D.predeclared.file)}</code>, sha256 ${E(String(D.predeclared.sha256).slice(0, 16))}…). One parameter set, no grid search. Outcomes: 2x / −50% on daily closes within 30 days, median return at 7/14/30 days; "random" = every other tradable token in the same pool on the same day.</p>
      <table><tr><th></th><th>n</th><th>tokens</th><th>hit 2x</th><th>drop −50%</th><th>7d</th><th>14d</th><th>30d</th></tr>${rows}</table>
      <p>Robinhood: ${rh.signals || 0} Waking signals vs ${rh.triggerReplayN ?? '—'} real 4h Trigger replays; ${rh.followedByRealTrigger || 0} were followed by a real Trigger${rh.medLeadDays != null ? `, median ${rh.medLeadDays} days earlier and ${rh.medCheaperPct}% cheaper` : ''}.</p>
      <ul>${(D.caveats || []).map((c) => `<li>${E(c)}</li>`).join('')}</ul>`;
  }
  async function load() {
    if (!mount()) return setTimeout(load, 1000);
    try { const r = await fetch('/api/waking'); D = await r.json(); if (D.error) throw new Error(D.error); } catch (e) { Q('#wkOut').innerHTML = `<div class="muted" style="padding:10px">Waking Up scan unavailable: ${E(e.message)}</div>`; return; }
    const on = Object.entries(D.alertsOn || {}).filter(([, v]) => v).map(([k]) => NAMEP[k]);
    const L = (p) => { const b = D.backtest[p] || {}, x = b.later || {}; return `${NAMEP[p]} <span class="str ${E(b.strength)}">${E(b.strength)}</span> (later period n=${x.n || 0}${x.n ? `: 2x ${x.hit2xPct}% vs random ${x.random.hit2xPct}%, −50% ${x.drop50Pct}% vs ${x.random.drop50Pct}%` : ''})`; };
    Q('#wkVerdict').innerHTML = (on.length ? `<b>Phone alerts ON for ${E(on.join(', '))}</b> (deduped, quiet hours 11 PM–7 AM PT queue to 7 AM).` : `<b>EXPERIMENTAL WATCH LIST · NO PHONE ALERTS.</b> No chain passed the out-of-sample test${(() => { const few = [], lost = []; for (const p of ['solana', 'robinhood', 'majors']) { const w = (D.backtest[p] || {}).strengthWhy || ''; (/too few/.test(w) ? few : lost).push(NAMEP[p]); } return (few.length ? `: ${few.join(' and ')} ${few.length > 1 ? 'have' : 'has'} too few past signals to test` : '') + (lost.length ? `${few.length ? ';' : ':'} on ${lost.join(' and ')} it did no better than random tokens` : ''); })()}. Treat cards as a shortlist to look at, not a buy signal.`)
      + `<br>${['solana', 'robinhood', 'majors'].map(L).join(' · ')}`;
    const n = (f) => D.items.filter(f).length;
    Q('#wkMeta').textContent = `scanned ${PT(D.generatedAt)} (${ago(D.generatedAt)}) · ${n((x) => poolOf(x) !== 'majors')} Solana/RH · ${n((x) => poolOf(x) === 'majors')} majors · ${n((x) => x.status === 'cheaper than flag')} cheaper than flag`;
    how(); render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
  setInterval(load, 15 * 60e3);
})();
