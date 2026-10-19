// Long Book tab: long-term desk for quantum-resistance and real buy-and-burn candidates (research/longbook/longbook.py ->
// /api/longbook). Read-only (fine for guests). Every claim shows its verified status + primary sources; every metric shows
// its as-of time in PT; the accumulation rule carries its own backtest strength label. Mechanical plans, not advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (x) => (x == null ? '—' : x >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + Math.round(x / 1e3) + 'K' : '$' + Math.round(x));
  const px = (x) => (x == null ? '—' : '$' + (x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : Number(x).toPrecision(3)));
  const pc = (x, d = 0) => (x == null ? '—' : (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const PT = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
  const ageD = (t) => (t ? (Date.now() - new Date(t).getTime()) / 864e5 : null);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; } };
  const ST = { shipped: ['live', 'var(--grn)'], verified: ['verified', 'var(--grn)'], testnet: ['testnet', 'var(--amb)'], partly: ['partly', 'var(--amb)'], roadmap: ['roadmap only', 'var(--mut)'], 'not-verified': ['not verified', 'var(--red,#d55)'], marketing: ['marketing / false', 'var(--red,#d55)'] };

  const nav = Q('#viewNav');
  if (nav && !nav.querySelector('[data-v=longbook]')) { const b = document.createElement('button'); b.dataset.v = 'longbook'; b.textContent = 'Long Book'; b.title = 'Long-term: quantum resistance + real buy-and-burn'; nav.appendChild(b); }
  const sec = document.createElement('section'); sec.id = 'viewLongbook'; sec.className = 'view'; sec.dataset.provRoute = '/api/longbook';
  sec.innerHTML = `<div class="panel" style="flex:none"><div class="phead"><h2>Long Book: quantum resistance + real buy-and-burn</h2><span id="lbMeta" class="muted small"></span></div>
    <div class="bkintro muted">Long-term holds only (Bitcoin excluded). Two themes: <b>quantum</b> = chains with post-quantum signatures shipped or credibly scheduled; <b>buyback</b> = protocols whose revenue really buys (and ideally burns) the token, checked against DefiLlama holders revenue. Every claim is graded live / testnet / roadmap only / marketing. Prices are a frozen snapshot: check the as-of time on each card.</div>
    <div id="lbRule" class="bkintro"></div>
    <div class="bkfilters" id="lbF"><button data-f="all" class="on">All</button><button data-f="quantum">Quantum</button><button data-f="buyback">Buyback</button></div>
    <div id="lbOut" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;padding:6px 14px 14px"></div>
    <details class="more" style="margin:0 14px 6px"><summary>Backtest: accumulate in a deep drawdown vs DCA vs lump sum</summary><div id="lbBt" class="bkhow"></div></details>
    <details class="more" style="margin:0 14px 14px"><summary>Rejected candidates (and why)</summary><div id="lbRej" class="bkhow"></div></details></div>`;
  (Q('#viewCommand') || document.body).after(sec);
  const css = document.createElement('style');
  css.textContent = `body[data-view=longbook] main.grid{display:none}body[data-view=longbook] #viewLongbook{display:flex;flex-direction:column;overflow:auto}
  #viewLongbook .bk{background:var(--panel2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
  #viewLongbook .bk .h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}#viewLongbook .bk .h b{font-size:1.15em;color:#fff}
  #viewLongbook .bk ul{margin:0;padding-left:18px;line-height:1.5}#viewLongbook .f{font-size:.82em;color:var(--mut);display:flex;flex-wrap:wrap;gap:4px 12px}
  #viewLongbook .kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:.86em}#viewLongbook .kv span:nth-child(odd){color:var(--mut)}
  #viewLongbook .chip{border-radius:999px;padding:1px 8px;font-size:.75em;background:#0a0e14;white-space:nowrap}
  #viewLongbook .bk.q{box-shadow:inset 3px 0 0 var(--blu)}#viewLongbook .bk.b{box-shadow:inset 3px 0 0 var(--grn)}
  #viewLongbook table{width:100%;border-collapse:collapse;font-size:.86em}#viewLongbook td,#viewLongbook th{padding:5px;border-bottom:1px solid #0f141b;text-align:left}`;
  document.head.appendChild(css);
  let D = null, F = 'all';

  const claim = (c) => { const [t, col] = ST[c.status] || [c.status, 'var(--mut)'];
    return `<li><span class="chip" style="color:${col}">${E(t)}</span> ${E(c.claim)} <span class="muted small">(${E(c.date)})</span><br><span class="muted small">${E(c.note || '')} ${(c.sources || []).map((u) => `<a href="${E(u)}" target="_blank" rel="noopener">${E(host(u))}↗</a>`).join(' ')}</span></li>`; };
  const revRow = (lbl, r) => (r ? `<span>${E(lbl)}</span><span>30d ${usd(r.d30)} · 90d ${usd(r.d90)} · 1y ${usd(r.y1)} <span class="muted">(to ${E(r.asOf)})</span></span>` : '');
  function card(c) {
    const m = c.market, p = c.price || {}, z = p.zone || {}, rv = c.revenue || {}, u = c.unlocks || {}, ns = c.netSupply, s = c.sentiment;
    const stale = ageD(m.asOf); const fresh = stale == null ? 'no data' : stale > 3 ? `snapshot ${Math.round(stale)}d old` : 'fresh';
    const above = (p.trim || []).filter((t) => p.lastClose >= t.price).map((t) => t.mult + 'x');
    const ps = Object.entries(c.priceToRevenue || {}).map(([k, v]) => `${k === 'holdersRevenue' ? 'holders rev' : k === 'chainFees' ? 'chain fees' : k} ${v}x`).join(' · ');
    const nx = (u.next || []).slice(0, 3).map((n) => `${E(n.date)} ${Math.round(n.tokens).toLocaleString()} (${E(n.category)})`).join('; ');
    const w0 = ns && ns.windows && ns.windows['1m']; const w = w0 && w0.netPctCirc != null && w0.burnPctCirc != null ? w0 : null;
    return `<div class="bk ${c.theme === 'quantum' ? 'q' : 'b'}"><div class="h"><b>${E(c.sym)}</b><span class="chip">${E(c.theme)}</span><span class="chip">${E(c.bucket)}</span><span class="muted small">${E(c.name || '')}</span><span style="margin-left:auto" class="num">${px(m.price)}</span></div>
      <div><b>Thesis:</b> ${E(c.thesis)}</div>
      <details class="more" open><summary>Claims checklist</summary><ul>${c.claims.map(claim).join('')}</ul></details>
      <div class="kv">
        <span>Market cap / FDV</span><span>${usd(m.mcap)} / ${usd(m.fdv)} · circulating ${m.circPct == null ? '—' : m.circPct + '%'} of ${m.max ? 'max' : 'total'}</span>
        <span>Drawdown</span><span>1y high ${p.y1 ? p.y1.ddPct + '%' : '—'} · 3y high ${p.y3 ? p.y3.ddPct + '%' + (p.y3.fullWindow ? '' : ' (history < 3y)') : '—'} · ATH ${m.athDDPct == null ? '—' : m.athDDPct + '%'}</span>
        <span>vs 200d avg</span><span>${p.xSma200 == null ? '—' : p.xSma200 + 'x'} (close ${px(p.lastClose)} on ${E(p.lastDay)}, ${E(p.src)})</span>
        ${revRow('Fees', rv.fees)}${revRow('Revenue', rv.revenue)}${revRow('Holders revenue', rv.holdersRevenue)}${rv.chainFees ? `<span>Chain fees</span><span>30d ${usd(rv.chainFees.d30)} · 1y ${usd(rv.chainFees.y1)} <span class="muted">(to ${E(rv.chainFees.asOf)})</span></span>` : ''}
        <span>Price / revenue</span><span>${ps || '—'}${c.holdersYieldPct != null ? ` · buyback yield ${c.holdersYieldPct}%/yr` : ''}</span>
        ${(c.derived || []).map((d) => `<span>Derived</span><span>${E(d.what)}: ${usd(d.usd1y)}/yr = ${d.pctMcap}% of mcap</span>`).join('')}
        <span>Unlocks</span><span>${u.next ? `30d ${u.unlock30dPctCirc}% of circ (insiders ${u.insider30dPctCirc}%)${nx ? ' · next ' + nx : ' · none scheduled in DefiLlama'}` : E(u.note || '—')} <span class="muted">(${PT(u.asOf)})</span></span>
        ${w ? `<span>Net supply 1m</span><span>unlock ${w.unlockPctCirc}% − burn ${w.burnPctCirc}% = <b>${w.netPctCirc >= 0 ? '+' : ''}${w.netPctCirc}%</b> <span class="muted">(buyburn worker estimate)</span></span>` : ''}
        ${c.consistency ? `<span>Buyback record</span><span>${E(c.consistency.frequency)} · uptime ${Math.round(c.consistency.uptime * 100)}% · ${c.consistency.nGaps} gap(s)</span>` : ''}
        <span>Liquidity</span><span>24h vol ${usd(c.liquidity.vol24h)} · ${c.liquidity.venues} venues · ${c.liquidity.majors.length ? E(c.liquidity.majors.join(', ')) : 'no major CEX'}</span>
        ${c.sentimentSym ? `<span>Sentiment</span><span>${s ? `oscillator ${s.oscillator} (${E(s.zone)})${s.suppressed ? ' · suppressed (unreliable query)' : ''}${s.lowSample ? ' · low sample' : ''} · ${PT(s.asOf)}` : 'tracked but no reading'}</span>` : ''}
        ${c.extra && c.extra.zecShielded ? `<span>Shielded</span><span>${c.extra.zecShielded.sharePct}% of supply (Ironwood ${c.extra.zecShielded.ironwoodPct}%) on ${E(c.extra.zecShielded.date)}</span>` : ''}
      </div>
      <div style="line-height:1.55"><b>Accumulation zone:</b> ${z.buyBelow ? `below ${px(z.buyBelow)} (${z.distPct}% from here) · ${z.ruleFiresNow ? '<b style="color:var(--grn)">rule fires now</b>' : 'not in zone'}` : 'not computable (history too short)'}<br>
        <b>DCA plan:</b> ${c.plan.weeklyPctOfBudget}% of the Long Book budget per week (weight ${c.plan.weightPct}%): half every week, half only in zone weeks.<br>
        <b>Max position:</b> ${c.capPct}% of the whole portfolio${c.bucket === 'meme' ? ' (counts toward the 7% meme slice)' : ''}.<br>
        <b>Trim when euphoric:</b> sell 1/4 at each of ${(p.trim || []).map((t) => `${t.mult}x 200d avg (${px(t.price)})`).join(', ') || '—'}${c.sentimentSym ? ', or 1/4 when the sentiment zone is euphoric' : ''}.${above.length ? ` <b style="color:var(--amb)">Now above ${above.join(', ')}: trim zone, not a buy.</b>` : ''}</div>
      <details class="more"><summary>Thesis-break exits &amp; risks</summary><div class="small" style="line-height:1.55"><b>Exit all if:</b><ul>${c.thesisBreak.map((x) => `<li>${E(x)}</li>`).join('')}</ul><b>Risks:</b><ul>${c.risks.map((x) => `<li>${E(x)}</li>`).join('')}</ul></div></details>
      <div class="f"><span>signal <span class="str unproven">${E((D.backtest.strength || '').split(' ')[0])}</span></span><span>market ${PT(m.asOf)} (${fresh})</span><span>claims reviewed ${E(D.reviewedAt)}</span></div></div>`;
  }
  function render() {
    if (!D) return;
    const it = D.candidates.filter((c) => F === 'all' || c.theme === F);
    Q('#lbOut').innerHTML = it.map(card).join('');
  }
  const sumRow = (lbl, s, b, eps) => `<tr><td>${E(lbl)}</td><td>${s.n || 0}</td><td>${eps ?? '—'}</td><td>${pc(s.median)}</td><td>${pc(s.mean)}</td><td>${s.pctPos == null ? '—' : Math.round(s.pctPos * 100) + '%'}</td><td>${b ? pc(b.median) : '—'}</td></tr>`;
  function renderBt() {
    const b = D.backtest, ch = b.chosen;
    Q('#lbRule').innerHTML = `<b>Accumulation rule:</b> ${E(b.rule.label)} (chosen on pre-2023 data, tested on 2023+). Strength: <span class="str unproven">${E(b.strength)}</span>. ${E(b.strengthNote)}.<br><span class="muted">Portfolio caps: ${E(D.portfolio.note)}</span>`;
    const hd = '<tr><th></th><th>weekly n</th><th>episodes</th><th>median</th><th>mean</th><th>% up</th><th>all-weeks median</th></tr>';
    const sims = Object.entries(b.simulations).map(([k, v]) => ['full', 'test'].map((w) => { const r = v[w]; if (!r) return ''; return `<tr><td>${E(k)} ${w === 'test' ? '2023+' : 'all'} <span class="muted">${E(r.from)}→${E(r.to)}</span></td>${['lumpSum', 'dca', 'ruleOnly', 'half'].map((s) => `<td>${r[s].multiple}x <span class="muted">(${Math.round(r[s].maxDD * 100)}%)</span></td>`).join('')}</tr>`; }).join('')).join('');
    Q('#lbBt').innerHTML = `<p>Weekly entry points on Binance daily closes for ${E(b.universe.join(', '))}. Train = entries before ${E(b.trainEnd)}; test = entries after. Forward returns need a full 1y/2y of later data.</p>
      <table>${hd}${sumRow('Rule, train: 1y forward', ch.train.signal.fwd1y, ch.train.baseline.fwd1y, ch.train.episodes)}${sumRow('Rule, test: 1y forward', ch.test.signal.fwd1y, ch.test.baseline.fwd1y, ch.test.episodes)}${sumRow('Rule, test: 2y forward', ch.test.signal.fwd2y, ch.test.baseline.fwd2y, ch.test.episodes)}${sumRow('Rule, test: worst drop within 1y', ch.test.signal.maxDD1y, ch.test.baseline.maxDD1y, '')}
      ${sumRow(`Broad Binance universe (${b.broad.n_coins} coins), train`, b.broad.train.signal.fwd1y, b.broad.train.baseline.fwd1y, b.broad.train.episodes)}${sumRow('Broad universe, test', b.broad.test.signal.fwd1y, b.broad.test.baseline.fwd1y, b.broad.test.episodes)}</table>
      <p><b>All grid cells</b> (not just the chosen one), 1y forward median:</p><table><tr><th>rule</th><th>train n</th><th>train median</th><th>train all-weeks</th><th>test n</th><th>test episodes</th><th>test median</th><th>test all-weeks</th></tr>${b.grid.map((g) => `<tr><td>${E(g.label)}</td><td>${g.train.signal.fwd1y.n || 0}</td><td>${pc(g.train.signal.fwd1y.median)}</td><td>${pc(g.train.baseline.fwd1y.median)}</td><td>${g.testSummary.fwd1y.n || 0}</td><td>${g.testSummary.episodes}</td><td>${pc(g.testSummary.fwd1y.median)}</td><td>${pc(g.testSummary.baseMedian1y)}</td></tr>`).join('')}</table>
      <p><b>Strategy simulation</b> ($1 per week budget; value ÷ money put in, worst peak-to-trough of that multiple in brackets). Rule-only holds cash until the rule fires; half = 50% DCA + 50% saved for zone weeks.</p>
      <table><tr><th></th><th>lump sum</th><th>weekly DCA</th><th>rule only</th><th>half/half</th></tr>${sims}</table>
      <p><b>Trim levels</b> (1y forward return after weeks priced at or above N× the 200d average, all history, same coins):</p><table><tr><th>level</th><th>weekly n</th><th>episodes</th><th>median 1y</th><th>% up</th><th>all-weeks median</th></tr>${b.euphoria.map((e) => `<tr><td>${e.mult}x</td><td>${e.signal.n}</td><td>${e.episodes}</td><td>${pc(e.signal.median)}</td><td>${e.signal.pctPos == null ? '—' : Math.round(e.signal.pctPos * 100) + '%'}</td><td>${pc(e.baseline.median)}</td></tr>`).join('')}</table>
      <ul>${b.caveats.map((c) => `<li>${E(c)}</li>`).join('')}<li>${E(b.broad.caveat)}</li></ul>`;
    Q('#lbRej').innerHTML = `<ul>${D.rejected.map((r) => `<li><b>${E(r.sym)}</b>: ${E(r.why)} ${(r.sources || []).map((u) => `<a href="${E(u)}" target="_blank" rel="noopener">${E(host(u))}↗</a>`).join(' ')}</li>`).join('')}</ul>`;
  }
  async function load() {
    try { const r = await fetch('/api/longbook'); D = await r.json(); if (D.error) throw new Error(D.error); } catch (e) { Q('#lbOut').innerHTML = `<div class="muted" style="padding:10px">Long Book unavailable: ${E(e.message)}</div>`; return; }
    Q('#lbMeta').textContent = `built ${PT(D.generatedAt)} · ${D.candidates.length} candidates · claims reviewed ${D.reviewedAt}`;
    renderBt(); render();
  }
  Q('#lbF').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; F = b.dataset.f; Q('#lbF').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
  nav && nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v === 'longbook') load(); });
  if (new URLSearchParams(location.search).get('view') === 'longbook') setTimeout(() => nav && nav.querySelector('[data-v=longbook]')?.click(), 0);
  else if (document.body.dataset.view === 'longbook') load();
})();
