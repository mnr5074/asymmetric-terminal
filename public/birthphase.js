// Pre-launch desk (Command view): cross-launchpad birth-phase library + live matcher. Data: /api/birthphase
// (lib/birthphase.js <- research/birthphase/*.py). Shows coverage, held-out backtest and live pre-graduation matches.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const U = (x) => (x == null ? '—' : typeof fUsd === 'function' ? fUsd(x) : '$' + Math.round(x).toLocaleString());
  const PC = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const T = (s) => (s == null ? '—' : s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd');
  const I = (k) => (window.ix ? window.ix(k) : '');
  const G = window.EXPLAIN || (window.EXPLAIN = {});
  Object.assign(G, {
    bp_prob: ['P(reach $1M) / P($10M)', 'Share of the most similar past launches (same age after creation, same features, similar price path) that went on to reach that market cap, weighted by similarity. For pump.fun it is re-weighted to ALL launches using an unbiased random sample of launches and of graduations, so it is a real probability estimate (with wide error bars). For other pads there is no population sample yet: the number is the share among similar launches in our library, which over-represents winners, so treat it as a ranking, not a probability.', null, 'Pre-launch'],
    bp_sim: ['Similarity %', '100% = identical. Built from the distance between this launch and a past launch at the same age: market cap, price slope, curve fill %, number of trades and buyers, volume, top-10 buyer share, sell share, first-buyer sizes and their spread, same-second (bundled) buys, fresh-wallet share, dev buy % of supply, repeat early buyers, plus the shape of the price path. Different launchpads get a penalty.', null, 'Pre-launch'],
    bp_cov: ['Coverage', 'full = first buyers + curve arc + post-launch candles all measured; partial = some of it (e.g. first buyers not reachable within free-RPC page caps, or candles older than GeckoTerminal\'s free window); outcome-only = only peak/now market cap known. Missing values are left empty, never estimated.', null, 'Pre-launch'],
    bp_bt: ['Held-out backtest', 'The model is built only from launches created before a cut-off date and scored on the later launches, at the same ages (5 min, 15 min, 1 h after creation). Launches already above the target at that age are excluded. Precision = share of flagged launches that really reached the target; recall = share of all launches that reached it that were flagged. "pop-weighted" re-weights the pump.fun test set to the real mix of launches (most never graduate), which is the number that matters for live use.', null, 'Pre-launch'],
    bp_repeat: ['Repeat early buyers', 'How many of the first 20 buyers were also among the first 20 buyers of at least two earlier launches in the library: sniper bots, bundlers or insider wallets that keep getting in first. Counted only from launches that happened earlier, so the backtest does not peek.', null, 'Pre-launch'],
    bp_base: ['Base rate', 'Out of ALL launches on the pad (unbiased random sample of launches and graduations), the share that ever reached the target. This is what you should expect from a random pick; a match is only interesting if its probability is many times this.', null, 'Pre-launch'],
  });
  const css = document.createElement('style');
  css.textContent = `.bp .chip{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700}.bp .hi{background:#1f6f3f;color:#fff}.bp .unc{background:#4a3f10;color:#ffd}
  .bp tr.brow{cursor:pointer}.bp .bdet{padding:6px 8px;background:rgba(255,255,255,.03);white-space:normal}.bp .bnote{white-space:normal;padding:4px 8px}.bp td.w{white-space:normal}.bp details summary{cursor:pointer}`;
  document.head.appendChild(css);
  let D = null, open = null, started = false;
  async function load() {
    const box = Q('#bpOut'); if (!box) return;
    try { D = await (typeof api === 'function' ? api('/api/birthphase') : fetch('/api/birthphase').then((r) => r.json())); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message)}</div>`; return; }
    if (D.error) { box.innerHTML = `<div class="empty">${E(D.error)}</div>`; return; }
    render();
  }
  function prob(p) { if (!p) return '—'; if (p.note) return '<span class="muted small">already</span>'; return `${PC(p.p, p.p < 0.1 ? 1 : 0)}${p.calibrated ? '' : '<sup title="uncalibrated: share among similar library launches">*</sup>'}`; }
  function render() {
    const L = D.live || {}; const items = L.items || []; const cov = D.coverage || {}; const M = D.model || {};
    const rule = (L.flag_rule || {}).p_ge ?? 0.2;
    const flagged = items.filter((x) => ((x.probs['1000000'] || {}).p || 0) >= rule && (x.probs['1000000'] || {}).calibrated === true);
    Q('#bpMeta').textContent = `library ${cov.total ?? '—'} launches · live ${items.length} · updated ${D.liveAgeSec != null ? Math.round(D.liveAgeSec / 60) + 'm ago' : 'never'}${D.refreshing ? ' · refreshing…' : ''}`;
    const pr = (M.pad_rates || {})['pump.fun'];
    const base = pr ? `pump.fun base rate (random launches): graduates ${PC(pr.p_grad, 1)} (n=${pr.n_random_launches}); of random graduations, reach $1M ${PC((pr.p_given_grad || {})['1000000'], 1)} (n=${pr.n_random_grads}) → $1M per launch ≈ ${PC((pr.launch_base_rate || {})['1000000'], 2)} ${I('bp_base')}` : 'No population base rate yet (needs the random-launch sample).';
    const head = `<div class="bnote small">${flagged.length ? `<b>High-probability now (P($1M) ≥ ${PC(rule)}):</b> ${flagged.map((x) => `${E(x.symbol || x.address.slice(0, 6))} (${E(x.launchpad)}, ${PC(x.probs['1000000'].p)})`).join(', ')}` : `No live pre-launch token reaches P($1M) ≥ ${PC(rule)} right now.`}<br><span class="muted">${base}</span><br><span class="muted">${E((L.flag_rule || {}).note || '')} Only pads with a population base rate (pump.fun) can be flagged; other pads' numbers (marked *) are the share of similar library launches that ran, which is outcome-enriched — a ranking, not odds.</span></div>`;
    const rows = items.slice(0, 60).map((x, i) => {
      const m = x.matches[0];
      const r = `<tr class="brow" data-i="${i}"><td><b>${E(x.symbol || x.address.slice(0, 6))}</b> <span class="muted small">${E(x.launchpad)}</span></td><td class="r">${T(x.age_s)}</td><td class="r">${x.curve_pct != null ? Math.round(x.curve_pct) + '%' : '—'}</td><td class="r">${U(x.mcap)}</td><td class="r">${x.n_buyers ?? '—'}</td><td class="r">${x.repeat_early_buyers ?? '—'}</td><td class="r">${prob(x.probs['1000000'])}</td><td class="r">${prob(x.probs['10000000'])}</td><td class="w small">${m ? `${E(m.symbol || '?')} ${m.similarity_pct}% → ${m.peak_mcap ? U(m.peak_mcap) + ' peak' : 'no outcome'}` : '—'}</td></tr>`;
      return open === i ? r + `<tr><td colspan=9>${detail(x)}</td></tr>` : r;
    }).join('');
    Q('#bpOut').innerHTML = `<div class="bp">${head}<table class="tbl"><thead><tr><th>Live launch</th><th class="r">Age</th><th class="r">Curve</th><th class="r">Mcap</th><th class="r">Buyers</th><th class="r">Rpt ${I('bp_repeat')}</th><th class="r">P($1M) ${I('bp_prob')}</th><th class="r">P($10M)</th><th>Closest past launch ${I('bp_sim')}</th></tr></thead><tbody>${rows || '<tr><td colspan=9 class="empty">No live launches scored yet.</td></tr>'}</tbody></table>${foot()}</div>`;
  }
  function detail(x) {
    const nb = x.matches.map((m) => `<tr><td>${E(m.symbol || '?')} <span class="muted small">${E(m.launchpad)} · ${E(m.stratum)}</span></td><td class="r">${m.similarity_pct}%</td><td class="r">${U(m.peak_mcap)}</td><td class="r">${m.t_to_1m_s != null ? T(m.t_to_1m_s) : '—'}</td><td class="r">${m.max_dd_pct != null ? m.max_dd_pct + '%' : '—'}</td><td>${m.reached_1m == null ? 'unknown' : m.reached_1m ? '<b>yes</b>' : 'no'}</td></tr>`).join('');
    const p1 = x.probs['1000000'] || {};
    return `<div class="bdet small"><div><b>What the arc shows so far</b> (snapshot at ${T(x.snapshot_age_s)} after creation): ${E((x.why || []).join(' · ') || 'nothing unusual measured')}.</div>
      <div class="muted">P($1M) ${prob(p1)} from ${p1.n_neighbors ?? 0} neighbours${p1.base_rate != null ? ` vs base rate ${PC(p1.base_rate, 2)} for a random launch on this pad` : ' (no population base rate for this pad: number is a ranking)'} · P($100K) ${prob(x.probs['100000'])}</div>
      <table class="tbl"><thead><tr><th>Most similar past launches</th><th class="r">Similarity</th><th class="r">Peak mcap</th><th class="r">Time to $1M</th><th class="r">Drawdown from peak</th><th>Reached $1M</th></tr></thead><tbody>${nb || '<tr><td colspan=6 class="empty">none</td></tr>'}</tbody></table>
      <div class="muted">${E(x.chain)}:${E(x.address)}</div></div>`;
  }
  function pumpTbl(bt) {
    const po = (bt.pump_only || {}).by || {};
    const rows = Object.entries(po).filter(([k]) => !k.endsWith('_100000')).map(([k, r]) => {
      const [age, thr] = k.split('_').map(Number); const f = (t) => (r.at || []).find((z) => z.p_ge === t) || {};
      const c = (t) => { const a = f(t); return `<td class="r">${a.flagged ?? '—'} / ${a.hits ?? '—'}</td><td class="r">${PC(a.prec_popw, 1)} / ${PC(a.recall_popw)}</td><td class="r">${a.flagged_on_curve ?? '—'} / ${a.hits_on_curve ?? '—'}</td>`; };
      return `<tr><td>${T(age)}</td><td>${U(thr)}</td><td class="r">${r.n}</td><td class="r">${r.pos}</td><td class="r">${r.auc_popw != null ? r.auc_popw.toFixed(2) : '—'}</td>${c(0.01)}${c(0.1)}</tr>`;
    }).join('');
    if (!rows) return '';
    return `<div style="margin-top:6px"><b>pump.fun only, re-weighted to the real launch mix</b> (the honest live number)</div><table class="tbl"><thead><tr><th>Age</th><th>Target</th><th class="r">n test</th><th class="r">hits</th><th class="r">AUC pop-wt</th><th class="r">P≥1%: flagged/hits</th><th class="r">prec / recall (pop-wt)</th><th class="r">of which on curve: flagged/hits</th><th class="r">P≥10%: flagged/hits</th><th class="r">prec / recall (pop-wt)</th><th class="r">on curve</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function foot() {
    const cov = (D.coverage || {}).pads || {}; const bt = ((D.model || {}).backtest) || {};
    const ct = Object.entries(cov).sort((a, b) => b[1].n - a[1].n).map(([p, c]) => `<tr><td>${E(p)}</td><td class="r">${c.n}</td><td class="r">${c.full ?? '—'}</td><td class="r">${c.partial ?? '—'}</td><td class="r">${c.outcome_only ?? '—'}</td><td class="r">${c.failed ?? '—'}</td><td class="r">${c.reached_1m ?? '—'}</td><td class="w small muted">${E(Object.entries(c.by_stratum || {}).map(([k, v]) => k + ' ' + v).join(', '))}</td><td class="w small muted">${E(Object.entries(c.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}× ${k}`).join('; '))}</td></tr>`).join('');
    const b = (bt.by || []).filter((r) => r.threshold === 1e6 || r.threshold === 1e7).map((r) => {
      const a = (r.at || []).find((z) => z.p_ge === 0.2) || {}; const a1 = (r.at || []).find((z) => z.p_ge === 0.1) || {};
      return `<tr><td>${T(r.age_s)}</td><td>${U(r.threshold)}</td><td class="r">${r.n_test}</td><td class="r">${r.positives}</td><td class="r">${r.auc != null ? r.auc.toFixed(2) : '—'}</td><td class="r">${a1.flagged ?? '—'} / ${a1.hits ?? '—'}</td><td class="r">${PC(a1.precision)} / ${PC(a1.recall)}</td><td class="r">${a.flagged ?? '—'} / ${a.hits ?? '—'}</td><td class="r">${PC(a.precision)} / ${PC(a.recall)}</td><td class="r">${PC(a.precision_pop_weighted, 1)}</td></tr>`;
    }).join('');
    return `<details class="bnote small"><summary><b>Held-out backtest</b> ${I('bp_bt')} — how predictive this was on later launches the model never saw</summary>
      <table class="tbl"><thead><tr><th>Age</th><th>Target</th><th class="r">n test</th><th class="r">hits</th><th class="r">AUC</th><th class="r">P≥10%: flagged/hits</th><th class="r">prec / recall</th><th class="r">P≥20%: flagged/hits</th><th class="r">prec / recall</th><th class="r">prec pop-wt</th></tr></thead><tbody>${b || '<tr><td colspan=10 class="empty">not run yet</td></tr>'}</tbody></table>
      ${pumpTbl(bt)}
      <div class="muted">${E(bt.method || '')} AUC 0.5 = coin flip, 1.0 = perfect ranking. Small n: treat every number as rough.</div></details>
      <details class="bnote small"><summary><b>Library coverage per launchpad</b> ${I('bp_cov')}</summary><table class="tbl"><thead><tr><th>Launchpad</th><th class="r">n</th><th class="r">full</th><th class="r">partial</th><th class="r">outcome only</th><th class="r">failed</th><th class="r">≥$1M</th><th>sample strata</th><th>main gaps</th></tr></thead><tbody>${ct}</tbody></table>
      <div class="muted">Strata: random = uniform draw from all launches (unbiased); random_graduates = uniform draw from all graduations; catalog/screener = known runners and crashes (both outcomes); pad listing = GeckoTerminal pools (activity-filtered). Not financial advice.</div></details>`;
  }
  document.addEventListener('click', (e) => { const tr = e.target.closest('#bpOut tr.brow'); if (!tr || e.target.closest('.ix')) return; const i = +tr.dataset.i; open = open === i ? null : i; render(); });
  function applyFold() { const c = localStorage.getItem('bpCollapsed') === '1'; const o = Q('#bpOut'), b = Q('#bpToggle'); if (o) o.style.display = c ? 'none' : ''; if (b) b.textContent = c ? '▸' : '▾'; }
  document.addEventListener('click', (e) => { if (!e.target.closest('#bpToggle')) return; localStorage.setItem('bpCollapsed', localStorage.getItem('bpCollapsed') === '1' ? '0' : '1'); applyFold(); });
  function ensurePanel() {
    if (Q('#bpOut')) return true;
    const after = Q('#narrPanel') || Q('#ccDesks'); if (!after) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'bpPanel'; el.style.flex = 'none';
    el.innerHTML = '<div class="phead"><span>PRE-LAUNCH MATCHER <span class="muted small">live bonding-curve launches vs past birth phases · click a row</span></span><span><span id="bpMeta" class="muted small"></span> <button id="bpToggle" class="btn ghost mini2" title="collapse / expand">▾</button></span></div><div id="bpOut" class="pbody scroll" style="max-height:40vh;overflow:auto"><div class="empty">Loading…</div></div>';
    after.insertAdjacentElement('afterend', el); return true;
  }
  function start() { if (started || !ensurePanel()) return; started = true; applyFold(); load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 2 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 300)); else setTimeout(start, 300);
})();
