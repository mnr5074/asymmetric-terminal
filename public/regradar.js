// Regulatory Radar section for the Macro & News desk (additive): /api/regradar + /api/regradar/study.
// Wraps window.loadMacro so the section is appended after the macro desk renders. Not financial advice.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const N = (x, d = 1) => (x == null || isNaN(x) ? '—' : (+x).toFixed(d));
  const S = (x, d = 1, u = '%') => (x == null || isNaN(x) ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${(+x).toFixed(d)}${u}</span>`);
  const PV = (p) => (p == null ? '–' : p < 0.001 ? '<0.001' : (+p).toFixed(3));
  const PCT = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
  const big = (x) => (x == null ? '—' : Math.abs(x) >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(0) + 'K' : (+x).toFixed(0));
  const DIR = { hawkish: '<span class="dn">hawkish</span>', dovish: '<span class="up">dovish</span>', neutral: '<span class="muted">neutral</span>' };
  const SEV = (s) => `<b class="${s >= 4 ? 'dn' : s >= 3 ? '' : 'muted'}">${'●'.repeat(s)}${'○'.repeat(5 - s)}</b>`;
  const age = (ts) => (typeof fAge === 'function' ? fAge(ts * 1000) : new Date(ts * 1000).toISOString().slice(0, 10));
  let state = { country: '', minsev: 3 };

  function flowCell(f) {
    if (!f) return '';
    const parts = [];
    for (const [k, v] of Object.entries(f)) {
      if (k === 'trends') { for (const [kw, t] of Object.entries(v.kw || {})) parts.push(`Trends[${E(v.geo)}] ${E(kw)} ×${N(t.ratio_post_pre_7d, 2)}`); continue; }
      if (!v || v.value == null) continue;
      const val = /vol/.test(k) ? '×' + N(v.value, 2) : k === 'tron_usdt_net' ? big(v.value) : /premium/.test(k) ? N(v.value, 2) + 'pp' : N(v.value, 2) + '%';
      parts.push(`${E(k)} ${val}${v.p_emp != null ? ` <span class="${v.p_emp < 0.1 ? 'up' : 'muted'}">p${PV(v.p_emp)}</span>` : ''}${v.post_days != null && v.post_days < 8 ? ` <span class="muted">(${v.post_days}d post)</span>` : ''}`);
    }
    return parts.join(' · ');
  }

  async function render() {
    const host = document.querySelector('#macroOut'); if (!host) return;
    let box = document.querySelector('#regRadar');
    if (!box) { box = document.createElement('div'); box.id = 'regRadar'; host.appendChild(box); }
    box.innerHTML = '<div class="grp" style="padding:0 8px">Regulatory Radar</div><div class="empty"><span class="spin"></span> loading…</div>';
    const qs = new URLSearchParams({ limit: '400' });
    const [d, s] = await Promise.all([api('/api/regradar?' + qs).catch((e) => ({ error: e.message })), api('/api/regradar/study').catch((e) => ({ error: e.message }))]);
    let h = `<div class="grp" style="padding:0 8px">Regulatory Radar <span class="muted small">crypto policy news (Google News + regulator RSS, en/es/pt/fa/tr/zh/ko/ja), classified · deduped · flow cross-check · event study</span></div>`;
    if (d.error) { box.innerHTML = h + `<div class="empty">${E(d.error)}</div>`; return; }
    // alerts
    const al = (d.alerts_recent || []).filter((a) => !a.initial_baseline).slice(0, 8);
    h += `<div class="small" style="padding:2px 8px"><b>Alerts (severity ≥4, new since last run):</b> ${al.length ? al.map((a) => `<div>${SEV(a.severity)} <span class="chip">${E(a.country)}</span> ${E(a.type)} ${DIR[a.direction] || ''} <a href="${E(a.link)}" target="_blank" rel="noopener noreferrer">${E(a.title)}</a> <span class="muted">${E(a.date)}</span></div>`).join('') : '<span class="muted">none new' + (d.first_run_baseline ? ' (first run recorded a baseline)' : '') + '</span>'}</div>`;
    // country chips
    const bc = Object.entries(d.by_country || {}).sort((a, b) => b[1].n - a[1].n);
    h += `<div class="small" style="padding:2px 8px">${['', ...bc.map(([c]) => c)].slice(0, 22).map((c) => `<button class="btn ghost rr-c" data-c="${E(c)}" style="padding:0 5px;${state.country === c ? 'font-weight:bold' : ''}">${c ? `${E(c)} ${d.by_country[c].n}` : 'all'}</button>`).join(' ')}
      · min severity <select id="rrSev">${[1, 2, 3, 4, 5].map((v) => `<option ${v === state.minsev ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="muted">· ${d.counts.clusters} items / ${d.counts.raw} raw (${d.counts.dropped_non_policy ?? 0} non-policy dropped) · updated ${Math.round((d.ageSec || 0) / 60)} min ago${d.refreshing ? ' · refreshing' : ''}</span></div>`;
    const items = (d.items || []).filter((x) => x.severity >= state.minsev && (!state.country || x.country === state.country)).slice(0, 40);
    h += `<table class="tbl news"><thead><tr><th>sev</th><th>when</th><th>ctry</th><th>type</th><th>dir</th><th>headline</th><th class="r">src</th></tr></thead><tbody>${items.map((x) => `<tr><td class="nowrap">${SEV(x.severity)}</td><td class="muted small nowrap">${age(x.ts)}</td><td><span class="chip">${E(x.country)}</span></td><td class="small">${E(x.type_label)}</td><td class="small">${DIR[x.direction] || ''}</td><td><a href="${E(x.link)}" target="_blank" rel="noopener noreferrer">${E(x.title)}</a> <span class="muted small">${E(x.publisher)}${x.official ? ' · official' : ''}${x.new ? ' · NEW' : ''}</span></td><td class="r small">${x.n_sources}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">no items at this filter</td></tr>'}</tbody></table>`;
    // dossiers
    h += `<div class="grp" style="padding:0 8px">Dossiers <span class="muted small">latest headlines in window + verified milestones</span></div><div class="small" style="padding:0 8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:6px">${(d.dossiers || []).map((x) => `<div style="border:1px solid var(--line,#333);padding:4px 6px;border-radius:4px"><b>${E(x.name)}</b> <span class="muted">${x.n_items_window} items · <span class="dn">${x.direction_mix.hawkish}</span>/<span class="up">${x.direction_mix.dovish}</span>/${x.direction_mix.neutral}</span>
        ${(x.latest || []).slice(0, 3).map((l) => `<div>${E(l.date)} <a href="${E(l.link)}" target="_blank" rel="noopener noreferrer">${E(l.title)}</a> ${DIR[l.direction] || ''}</div>`).join('') || '<div class="muted">no items this window</div>'}
        ${(x.milestones || []).length ? `<details><summary class="muted">${x.milestones.length} milestones</summary>${x.milestones.map((m) => `<div>${E(m.date)} ${E(m.label)} ${m.citation && m.citation.link ? `<a href="${E(m.citation.link)}" target="_blank" rel="noopener noreferrer">[${E(m.citation.publisher || 'src')}]</a>` : ''}</div>`).join('')}</details>` : ''}</div>`).join('')}</div>`;
    // flows
    const F = d.flows || {};
    const ar = F.AR || {}, ng = F.NG || {}, ir = F.IR || {}, tr = F.TR || {}, br = F.BR || {}, tu = F.TRON_USDT || {};
    h += `<div class="grp" style="padding:0 8px">Local crypto-dollar premiums & flows (live, public tickers)</div><table class="tbl small"><tbody>
      <tr><td>Argentina ARS</td><td>oficial ${N(ar.oficial, 0)} · blue ${N(ar.blue, 0)} · cripto ${N(ar.cripto, 0)} · Binance USDT ${N(ar.binance_spot?.last, 0)} · P2P median ${N(ar.binance_p2p_buy?.median, 0)}</td><td>USDT prem vs oficial <b>${PCT(ar.premium_usdt_vs_oficial)}</b> · blue ${PCT(ar.premium_blue_vs_oficial)}</td><td class="muted">vol Binance ${big(ar.binance_spot?.vol24_usdt)} · Bitso ${big(ar.bitso_usdt?.vol24_usdt)} USDT/24h</td></tr>
      <tr><td>Nigeria NGN</td><td>Luno ${N(ng.luno_usdt?.last, 0)} · Quidax ${N(ng.quidax_usdt?.last, 0)} · ref ${N(ng.official_ref, 0)} · Binance P2P ads ${ng.binance_p2p_buy?.n_ads ?? '—'}</td><td>USDT prem vs ref <b>${PCT(ng.premium_usdt_vs_ref)}</b></td><td class="muted">vol Luno ${big(ng.luno_usdt?.vol24_usdt)} · Quidax ${big(ng.quidax_usdt?.vol24_usdt)}</td></tr>
      <tr><td>Iran IRT</td><td>Nobitex USDT ${N(ir.nobitex_usdt?.last_toman, 0)} toman (${S(ir.nobitex_usdt?.day_change_pct, 2)} 24h)</td><td class="muted">official ref not a market rate</td><td class="muted">vol ${big(ir.nobitex_usdt?.vol24_usdt)} USDT/24h</td></tr>
      <tr><td>Turkey TRY</td><td>Binance USDT ${N(tr.binance_spot?.last, 3)} · ref ${N(tr.official_ref, 3)}</td><td>prem <b>${PCT(tr.premium_usdt_vs_ref)}</b></td><td class="muted">vol ${big(tr.binance_spot?.vol24_usdt)}</td></tr>
      <tr><td>Brazil BRL</td><td>Binance USDT ${N(br.binance_spot?.last, 3)} · ref ${N(br.official_ref, 3)}</td><td>prem <b>${PCT(br.premium_usdt_vs_ref)}</b></td><td class="muted">vol ${big(br.binance_spot?.vol24_usdt)}</td></tr>
      <tr><td>Tron USDT</td><td>supply ${big(tu.supply)} (as of ${E(tu.asof || '—')})</td><td>net 1d ${big(tu.net_1d)} · 7d ${big(tu.net_7d)} · 30d ${big(tu.net_30d)}</td><td class="muted">${(tu.spikes_90d || []).length} spike days / 90d (stables module)</td></tr></tbody></table>`;
    if ((d.crossref || []).length) h += `<details class="ev" style="padding:2px 8px"><summary>Flow cross-check for flagged items (days 0..+7 vs −7..−1; p = rank vs all other dates)</summary><table class="tbl small"><tbody>${d.crossref.map((c) => `<tr><td class="nowrap">${E(c.date)}</td><td><span class="chip">${E(c.country)}</span></td><td>${E(c.title).slice(0, 90)}</td><td>${flowCell(c.flows) || '<span class="muted">no country series</span>'}</td></tr>`).join('')}</tbody></table></details>`;
    // study
    if (!s.error && s.summary) {
      const G = s.summary; const rows = Object.keys(G);
      const cell = (g, a, w) => { const x = G[g]?.stats?.[a]?.[w]; return x && x.n ? `${S(x.mean, 2)} <span class="muted">n${x.n} p<sub>t</sub>${PV(x.p_t)}${x.p_placebo != null ? ' p<sub>pl</sub>' + PV(x.p_placebo) : ''}</span>` : '<span class="muted">—</span>'; };
      h += `<div class="grp" style="padding:0 8px">Event study: mean CAR around regulatory events (${E(s.price_range?.[0])} → ${E(s.price_range?.[1])}) · ${s.events.length} verified curated events, ${s.gdelt_events.length} GDELT spike days</div>
        <table class="tbl small"><thead><tr><th>group</th><th class="r">n</th><th class="r">BTC [−1,+1]</th><th class="r">BTC [0,+7]</th><th class="r">ETH−BTC [0,+7]</th><th class="r">SOL−BTC [0,+7]</th><th class="r">Catalog−BTC [0,+7]</th></tr></thead><tbody>
        ${rows.map((g) => `<tr><td>${E(g)}</td><td class="r">${G[g].n_events}</td><td class="r">${cell(g, 'BTC', '-1,1')}</td><td class="r">${cell(g, 'BTC', '0,7')}</td><td class="r">${cell(g, 'ETH_vs_BTC', '0,7')}</td><td class="r">${cell(g, 'SOL_vs_BTC', '0,7')}</td><td class="r">${cell(g, 'CATALOG_vs_BTC', '0,7')}</td></tr>`).join('')}</tbody></table>
        <details class="ev" style="padding:2px 8px"><summary>Events, citations & local reactions</summary><table class="tbl small"><tbody>${s.events.map((e) => `<tr><td class="nowrap">${E(e.date)}</td><td><span class="chip">${E(e.country)}</span></td><td>${E(e.label)} ${DIR[e.direction] || ''} ${(e.citations || []).slice(0, 1).map((c) => `<a href="${E(c.link)}" target="_blank" rel="noopener noreferrer">[${E(c.publisher)}]</a>`).join('')}</td><td class="r">BTC ${S(e.car?.BTC?.['-1,1'], 1)} / ${S(e.car?.BTC?.['0,7'], 1)}</td><td>${flowCell(e.flows)}</td></tr>`).join('')}</tbody></table>
        <div class="small muted">${E(s.method)}</div><ul class="small">${(s.caveats || []).map((c) => `<li>${E(c)}</li>`).join('')}</ul></details>`;
    } else h += `<div class="muted small" style="padding:4px 8px">Event study: ${E(s.error || 'not generated')}</div>`;
    h += `<div class="muted small" style="padding:2px 8px">Keyword classifier (transparent rules, imperfect); severity 1–5. Sources linked per item. Not financial advice.</div>`;
    box.innerHTML = h;
    box.querySelectorAll('.rr-c').forEach((b) => b.addEventListener('click', () => { state.country = b.dataset.c; render(); }));
    const sel = box.querySelector('#rrSev'); if (sel) sel.addEventListener('change', () => { state.minsev = +sel.value; render(); });
  }
  const orig = window.loadMacro;
  if (typeof orig === 'function') {
    window.loadMacro = async function loadMacroWithRadar() { await orig.apply(this, arguments); try { await render(); } catch (e) { console.warn('regradar', e); } };
  }
  window.loadRegRadar = render;
})();
