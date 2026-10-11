// Pattern detectors panel (Command view): /api/patterns. Additive; self-contained.
(() => {
  const el = () => document.querySelector('#ccPatterns');
  const pct = (x) => (x == null ? '–' : Math.round(x * 1000) / 10 + '%');
  const pv = (p) => (p == null ? '–' : p < 0.001 ? '<0.001' : (+p).toFixed(3));
  const short = (a) => (a ? String(a).slice(0, 4) + '…' + String(a).slice(-4) : '');
  async function render() {
    const box = el(); if (!box) return;
    let d; try { d = await api('/api/patterns'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message || e)}</div>`; return; }
    const h = d.hours || {}, o = h.onset_all || {}, lv = h.live || {};
    const w = d.freshWallets || {}, c = d.cexFlows || {}, s = (d.stocks || {}).summary || {}, b = (d.bridges || {}).backtest || {};
    const row = (t, v) => `<div class="small"><b>${t}</b> ${v}</div>`;
    let html = '';
    html += row('1 · Crash hours', o.n ? `${o.n} onsets · Asia 00-08 UTC ${pct(o.asia_share)} vs ${pct(o.asia_expected_volume)} vol-baseline (p=${pv(o.asia_p_vs_volume_one_sided)}) · χ² vs volume p=${pv((o.chi2_volume_4h_buckets || {}).p)} · now ${lv.utcHour}:00 UTC${lv.inFlaggedWindow ? ' <span class="dn">flagged window</span>' : ''} · ${(lv.items || []).length} live dumps in window` : 'not generated');
    const t3 = (w.thresholds || [])[1];
    html += row('2 · Fresh-wallet clusters', w.sample ? `${w.sample.died} died vs ${w.sample.mooned} runners · ${t3 ? `${t3.rule}: died ${pct(t3.hit_rate_died)} / runners ${pct(t3.false_pos_rate_mooned)}` : ''} · live flags ${(w.live || []).filter((x) => x.flag).map((x) => esc(x.symbol)).join(', ') || 'none'}` : 'not generated');
    html += row('3 · Dev/top → CEX', c.cex ? `died ${c.cex.died.flagged}/${c.cex.died.n} · runners ${c.cex.mooned.flagged}/${c.cex.mooned.n} · live flags ${(c.live || []).filter((x) => x.flag).map((x) => esc(x.symbol)).join(', ') || 'none'}` : 'not generated');
    html += row('4 · Stock pairs', s.n_with_daily ? `${s.n_with_daily} tokens · median daily r ${s.median_r_daily_usd} (USD), ${s.median_r_daily_in_quote ?? '–'} (in quote) · crash pre-flags ${s.crashed_with_neg_div_flag_within_10d_before_break}/${s.crashed_tokens} · divergence now: ${(s.live_flags || []).slice(0, 6).map((x) => `${esc(x.symbol)}/${esc(x.stock)} z${x.z}`).join(', ') || 'none'}` : 'not generated');
    html += row('5 · Bridges', b.bridge_out ? `out-bridge died ${b.bridge_out.died.flagged}/${b.bridge_out.died.n} · runners ${b.bridge_out.mooned.flagged}/${b.bridge_out.mooned.n} · inbound-before-peak died ${b.inbound_bridge_before_peak.died.flagged} / runners ${b.inbound_bridge_before_peak.mooned.flagged}` : 'not generated');
    const a = d.aging || {};
    html += row('6 · Whale aging', a.sample ? `${a.sample.died} died vs ${a.sample.mooned} runners · awakening(idle≥7d) died ${a.awakening_7d.died.flagged} / runners ${a.awakening_7d.mooned.flagged} · live: ${(a.live || []).filter((x) => (x.flags || []).length).map((x) => `${esc(x.symbol)} (${esc(x.flags[0])})`).slice(0, 4).join(', ') || 'none'}` : 'not generated');
    const r8 = (o) => (o && o.died ? `died ${o.died.flagged}/${o.died.n} vs runners ${o.mooned.flagged}/${o.mooned.n}${o.fisher_one_sided_p != null ? ` · p=${o.fisher_one_sided_p}` : ''}` : 'not generated');
    const lf = (arr, f) => (arr || []).filter((x) => x.flag || (f && f(x))).map((x) => esc(x.symbol)).slice(0, 4).join(', ') || 'none';
    const lp = d.liquidityPull || {}, hc = d.holderConcentration || {}, bh = d.bridgeHop || {};
    html += row('7 · Liquidity pull', `${r8(lp)} · any LP withdrawal: ${r8(lp.any_withdrawal)} · live: ${lf(lp.live)}`);
    const am = hc.age_matched;
    html += row('8 · Holder concentration', `${r8(hc)}${am ? ` · age-matched: died ${am.died.flagged}/${am.died.n} vs runners@launch ${am.mooned_launch2h.flagged}/${am.mooned_launch2h.n} p=${am.fisher_one_sided_p}` : ''} · live: ${lf(hc.live)}`);
    html += row('9 · Bridge-hop→dump', `${bh.hops_checked != null ? `${bh.hops_checked} hops checked · ` : ''}${r8(bh)} · live: ${(bh.live || []).map((x) => esc(x.symbol)).slice(0, 4).join(', ') || 'none'}`);
    const ex = (d.coordinatedExits || []).filter((x) => x.significant).slice(0, 5);
    if (ex.length) html += `<div class="small muted">Exit events: ${ex.map((x) => `${esc(x.symbol)} (${esc(x.cohort || x.when)}) $${Math.round(x.usd_total || 0)} ${esc((x.kinds || []).join('+'))}${x.lead_h_before_break != null ? ` lead ${x.lead_h_before_break}h` : ''}`).join(' · ')}</div>`;
    const li = (lv.items || []).slice(0, 6);
    if (li.length) html += `<div class="small">${li.map((x) => `<span class="dn">${esc(x.symbol)} ${x.ch1}%</span>`).join(' ')}</div>`;
    html += '<div class="small muted">Backtests + methods: /api/patterns · /api/bridges · free data only</div>';
    box.innerHTML = html;
  }
  window.addEventListener('load', () => { render(); setInterval(render, 120e3); });
})();
