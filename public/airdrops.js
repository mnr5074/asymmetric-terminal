// ASYMMETRIC·TERMINAL Airdrop Desk v2 (additive panel inside the Airdrops view).
// Tabs: ROI ranking (/api/airdrops/roi, research/airdrops_roi.py) · Classic ranker (views.js) · Tracker · Under-farmed · My Farms · Value · Speculation.
// Data: /api/airdrops/desk (research/airdrops_v2.py), /api/airdrops/farm(s) (lib/airdrops.js). Read-only: a public address is all it ever asks for.
// Every figure is pulled from a public source or typed by you; estimates are ranges with the method shown. Not financial advice.
'use strict';
(function () {
  const Q = (s, r = document) => r.querySelector(s);
  const usd = (x) => (x == null || isNaN(x) ? '—' : fUsd(x));
  const pc = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const pcu = (x, d = 3) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const n0 = (x) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (+x).toFixed(2));
  const link = (u, t) => (u && /^https:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)} ↗</a>` : '');
  const gchip = (g) => `<span class="grade g${esc(g)}">${esc(g)}</span>`;
  const ix2 = (t) => (window.ix ? window.ix(t) : '');
  const chip = (txt, cls) => `<span class="a2chip ${cls}">${esc(txt)}</span>`;
  const conf = (c) => (c ? chip('confirmed', 'ok') : chip('unconfirmed', 'warn'));

  Object.assign(window.EXPLAIN || {}, {
    a2_under: ['Under-farmed score', 'How much room is left for a new farmer: low TVL (less capital competing for the same airdrop), a lot of funding relative to TVL (investors expect a valuable token, but few people deposit yet), a young program, little hype (few headlines, low airdrops.io heat), a visible points program and token hints. 0–100; A ≥ 70, B ≥ 58, C ≥ 45. Without points evidence it is capped at C.', null, 'Airdrops'],
    a2_timeline: ['Estimated timeline', 'When a token might launch. Evidence first: a public token sale, a "TGE/tokenomics/claim" headline, or TGE on the official site means "near". Otherwise we add the usual gap between first funding round and TGE seen in past airdrops (EigenLayer, Ethena, Blast …) to this protocol\'s first round. "Overdue" = later than 75% of those cases with no token news (the drop gets less likely).', null, 'Airdrops'],
    a2_pool: ['Community pool (estimate)', 'Dollar value of the whole airdrop to users = expected token valuation (FDV) × share of supply given to the community. Low/mid/high come from past airdrops: small protocols (YO, TownSquare) for the low end, big famous drops for the high end. Famous drops are survivors, so the high end is optimistic.', null, 'Airdrops'],
    a2_per1k: ['Per $1,000 deposited (ceiling)', 'If the whole community pool were split by capital at today\'s TVL, what $1,000 would get. Real programs also weigh time, boosts and referrals, part of the pool goes elsewhere, and TVL usually grows, so treat it as a ceiling for comparing protocols, not a forecast.', null, 'Airdrops'],
    a2_fdvraised: ['FDV ÷ money raised', 'How many times the money investors put in the token was valued at launch. Past drops: median about 97× for famous drops, about 10× for small ones (YO 9×, TownSquare sale 12×). We multiply a protocol\'s funding by these to guess its launch valuation when no valuation is disclosed.', null, 'Airdrops'],
    a2_share: ['Your share', 'Your points ÷ everyone\'s points. Your airdrop ≈ share × community pool. Only computable when the protocol publishes the total; otherwise we can only use your deposit ÷ TVL for programs that reward capital.', null, 'Airdrops'],
    a2_dilution: ['Dilution warning', 'Your share shrinks when everyone else\'s points (or TVL, if totals are hidden) grow faster than yours. Same points, smaller slice. We compare growth over the last 24h / 7d / 30d of snapshots.', null, 'Airdrops'],
    a2_rate: ['Accumulation rate', 'Points you earned per day between two snapshots. Snapshots are taken each time you press Check now, and hourly while this page is open.', null, 'Airdrops'],
    a2_rank: ['Rank change', 'Places gained (+) or lost (−) on the leaderboard between snapshots. Losing places while your points rise means others are farming faster.', null, 'Airdrops'],
    a2_conf: ['Confirmed vs unconfirmed', 'Confirmed = stated by the team (docs, blog, official post) or an on-chain/funding fact. Unconfirmed = expectations: news speculation, airdrop-site listings, pre-market prices, third-party calendars.', null, 'Airdrops'],
    a2_auto: ['Automated vs manual', 'Automated = we read it from a public API with just your address. Manual = the protocol hides it behind a wallet-signature login, so you copy the number from its site. We never ask you to sign anything here.', null, 'Airdrops'],
    a2_roi: ['Airdrop ROI', 'Expected value per wallet = chance a token happens × launch valuation (FDV) × share for the community × your slice. Your slice comes from published points totals, your deposit vs TVL, or the crowd size; when those are unknown we fall back on what past drops with a similar crowd paid per wallet, cut by a survivor haircut. ROI = that value ÷ everything it costs you: fees, your time at an hourly rate, what the capital could earn elsewhere, and the chance of losing it. Low/base/high are the pessimistic/middle/optimistic ends of every input, not probabilities.', null, 'Airdrops'],
    a2_sat: ['Saturation score', '0–100, higher = less crowded. 45%: expected airdrop dollars still to be handed out per participant. 35%: how many people farm it (fewer is better). 20%: how quiet it is on X (7-day post count, a noisy proxy). Crowded, hyped campaigns split the same pool among more wallets.', null, 'Airdrops'],
    a2_kind: ['Sourced / derived / assumed', 'Sourced = a number published by the team, its docs, DefiLlama or a dashboard (link given). Derived = computed from sourced numbers. Assumed = our estimate, shown so you can disagree. Unknown = no data; the model falls back to the calibration set.', null, 'Airdrops'],
    a2_comps: ['Comparables', 'Past airdrops used as yardsticks: % of supply given to users, launch valuation (price at the end of launch day × supply), dollar value of the drop, and airdrop $ per $1 of TVL at launch. Prices: DefiLlama coins API; TVL: DefiLlama.', null, 'Airdrops'],
  });

  const css = document.createElement('style');
  css.textContent = `.a2tabs{display:flex;gap:4px;flex-wrap:wrap;padding:4px 6px;border-bottom:1px solid var(--line)}.a2tabs button{font-size:11px}.a2tabs button.on{background:#1d3b5a;color:#fff}
  #ad2Out{overflow:auto;flex:1;min-height:0;padding:4px 6px}.a2chip{display:inline-block;font-size:9.5px;padding:0 5px;border-radius:3px;border:1px solid;margin-right:3px;vertical-align:middle}
  .a2chip.ok{color:#5be39a;border-color:#14432c}.a2chip.warn{color:#e8c64c;border-color:#4a4313}.a2chip.bad{color:#ff6b6b;border-color:#6a1f27}.a2chip.mut{color:#8b97a8;border-color:#2a3442}
  .a2card{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:6px 0}.a2card h4{margin:0 0 4px}.a2grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin:6px 0}
  .a2grid div{border:1px solid #1a2230;border-radius:4px;padding:4px 6px}.a2grid span{display:block;font-size:10px;color:var(--mut)}.a2warn{color:#ffb38a;margin:2px 0}.a2form{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:4px 0}
  .a2form input,.a2form select{font-size:11px}.a2x td{white-space:normal;background:#0d131c;font-size:11px}.a2bar{display:inline-block;width:40px;height:5px;background:#1a2230;border-radius:3px;vertical-align:middle;margin-right:4px}.a2bar i{display:block;height:100%;background:#3d8bfd;border-radius:3px}
  .a2tbl tr.clk{cursor:pointer}.a2tbl td{vertical-align:top;white-space:normal}.a2tbl td.why,.a2tbl td:nth-child(8){min-width:280px}.a2ev li{margin:2px 0}`;
  document.head.appendChild(css);

  let D = null, tab = 'classic', open = new Set(), farmTimer = null;
  const panel = Q('#viewAirdrops .adleft');
  if (!panel || !Q('#adOut')) return;
  const bar = document.createElement('div'); bar.className = 'a2tabs';
  bar.innerHTML = [['roi', 'ROI ranking'], ['classic', 'Classic ranker'], ['tracker', 'Tracker'], ['under', 'Under-farmed'], ['farms', 'My Farms'], ['value', 'Value calc'], ['spec', 'Speculation']].map(([k, t]) => `<button class="btn mini2 ${k === tab ? 'on' : ''}" data-a2="${k}">${t}</button>`).join('');
  const out = document.createElement('div'); out.id = 'ad2Out'; out.style.display = 'none';
  Q('#adOut').before(bar); Q('#adOut').after(out);
  bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-a2]'); if (b) setTab(b.dataset.a2); });
  function setTab(k) {
    tab = k; bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a2 === k));
    Q('#adOut').style.display = k === 'classic' ? '' : 'none'; out.style.display = k === 'classic' ? 'none' : '';
    const f = panel.querySelector('.filters'); if (f) f.style.visibility = k === 'classic' ? '' : 'hidden';
    if (k !== 'classic') render();
    if (k === 'farms' && !farmTimer) farmTimer = setInterval(() => { if (tab === 'farms' && document.body.dataset.view === 'airdrops') loadFarms(true); }, 3600e3);
  }
  async function load() {
    if (D) return D;
    out.innerHTML = '<div class="empty"><span class="spin"></span> loading Airdrop Desk (DefiLlama, comparables, news)…</div>';
    D = await api('/api/airdrops/desk'); return D;
  }
  async function render() {
    if (tab === 'roi') return roiTab();
    try { await load(); } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    ({ tracker, under, farms: farmsTab, value, spec })[tab]();
  }
  const hdr = (t, sub) => `<div class="muted small pad">${t}${sub ? ' · ' + sub : ''} · updated ${new Date(D.generatedAt).toLocaleString()}${D.refreshing ? ' (refreshing…)' : ''}</div>`;
  const tlChip = (b) => chip(b, b === 'near' ? 'ok' : b === 'mid' ? 'mut' : b === 'overdue' ? 'bad' : 'warn');
  const parts = (p) => Object.entries(p || {}).map(([k, v]) => `<span title="${esc(k)}" class="small"><span class="a2bar"><i style="width:${Math.round(v * 100)}%"></i></span>${esc(k.replace(/_/g, ' '))}</span>`).join(' ');
  const spark = (pts, w = 160, h = 28) => { const v = (pts || []).map((x) => x[1]); if (v.length < 2) return ''; const mx = Math.max(...v), mn = Math.min(...v); const s = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - ((y - mn) / (mx - mn || 1)) * h}`).join(' '); return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline fill="none" stroke="#3d8bfd" stroke-width="1.5" points="${s}"/></svg>`; };
  const poolTxt = (a) => (a?.pool_usd ? `${usd(a.pool_usd.lo)} – ${usd(a.pool_usd.hi)} <span class="muted">(mid ${usd(a.pool_usd.mid)})</span>` : '—');

  function detail(c) {
    const a = c.alloc || {}, tl = c.timeline || {};
    return `<tr class="a2x"><td colspan="9"><div><b>${esc(c.name)}</b> ${esc(c.description || '')}</div>
      <div>${ix2('a2_under')} parts: ${parts(c.parts)}</div>
      <div>${ix2('a2_timeline')} timeline: ${tlChip(tl.bucket)} ${tl.window ? `window ${esc(tl.window.from)} → ${esc(tl.window.to)} (mid ${esc(tl.window.mid)}) <span class="muted">${esc(tl.window.method)}</span>` : 'no funding date to anchor'}</div>
      ${(tl.evidence || []).length ? `<ul class="a2ev">${tl.evidence.map((e) => `<li>${conf(e.confirmed)}${chip(e.kind, 'mut')} ${esc(e.t || '')} ${esc(e.text)} ${link(e.url, 'source')}</li>`).join('')}</ul>` : ''}
      <div>${ix2('a2_pool')} community pool: ${poolTxt(a)} · FDV guess ${usd(a.fdv?.lo)}–${usd(a.fdv?.hi)} <span class="muted">(${esc(a.fdv?.method || 'no funding data')}; airdrop % ${a.pct_used?.map((x) => x?.toFixed(1)).join(' / ')})</span></div>
      <div>${ix2('a2_per1k')} per $1k at today's TVL (ceiling): ${a.per_1k_at_today_tvl ? `${usd(a.per_1k_at_today_tvl.lo)} – ${usd(a.per_1k_at_today_tvl.hi)}` : '—'}</div>
      <div>TVL ${spark(c.tvl_hist?.weekly)} now ${usd(c.tvl)} · 30d ${pc(c.tvl_hist?.ch30, 0)} · 90d ${pc(c.tvl_hist?.ch90, 0)} · peak ${usd(c.tvl_hist?.peak)} (${esc(c.tvl_hist?.peak_date || '')})</div>
      <div>Funding: ${(c.raises || []).map((r) => `${esc(r.date || '?')} ${esc(r.round || 'round')} ${usd(r.amountUsd)}${r.lead?.length ? ' (' + esc(r.lead.slice(0, 3).join(', ')) + ')' : ''}`).join(' · ') || '—'}</div>
      ${c.flags?.length ? `<div class="a2warn">⚠ ${c.flags.map(esc).join(' · ')}</div>` : ''}
      ${(c.news || []).length ? `<div class="small">Headlines: ${c.news.slice(0, 5).map((n) => `${esc(n.t)} ${link(n.url, n.title.slice(0, 90))}`).join('<br>')}</div>` : '<div class="muted small">No crypto headlines in 120 days.</div>'}
      <div class="small">${link(c.url, 'official')} ${link(c.defillama, 'DefiLlama')} ${link(c.airdrops_io, 'airdrops.io')} · site keywords: ${esc((c.site?.hits || []).join(', ') || (c.site?.error ? 'site fetch failed' : 'none found'))}</div></td></tr>`;
  }
  function bindRows() { out.querySelectorAll('tr.clk').forEach((r) => r.addEventListener('click', (e) => { if (e.target.closest('a,button')) return; const k = r.dataset.k; open.has(k) ? open.delete(k) : open.add(k); render(); })); }

  function tracker() {
    const ord = { near: 0, mid: 1, far: 2, unknown: 3, overdue: 4 };
    const rows = D.candidates.slice().sort((a, b) => ord[a.timeline.bucket] - ord[b.timeline.bucket] || b.score - a.score);
    out.innerHTML = hdr(`Anticipated airdrops: ${rows.length} tokenless protocols with funding or a campaign`, 'tap a row for evidence') + `<div class="tablewrap"><table class="tbl a2tbl"><thead><tr><th>${ix2('a2_timeline')} When</th><th>Protocol</th><th class="r">TVL</th><th class="r">30d</th><th class="r">Raised</th><th>Evidence</th><th>${ix2('a2_pool')} Pool est.</th><th class="r">Score</th><th></th></tr></thead><tbody>
      ${rows.map((c) => { const ev = c.timeline.evidence || []; const nc = ev.filter((e) => e.confirmed).length; return `<tr class="clk" data-k="${esc(c.key)}"><td>${tlChip(c.timeline.bucket)}<div class="muted small">${c.timeline.window ? esc(c.timeline.window.from.slice(0, 7)) + '→' + esc(c.timeline.window.to.slice(0, 7)) : ''}</div></td>
        <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.category || '')} · ${esc((c.chains || []).slice(0, 3).join(', '))}</div></td><td class="r">${usd(c.tvl)}</td><td class="r">${pc(c.tvl_hist?.ch30, 0)}</td><td class="r">${usd(c.raised_usd)}</td>
        <td class="small">${nc ? chip(nc + ' confirmed', 'ok') : ''}${ev.length - nc ? chip(ev.length - nc + ' unconfirmed', 'warn') : ''}${c.points_evidence ? chip('points', 'mut') : ''}${c.flags?.length ? chip('⚠ ' + c.flags.length, 'bad') : ''}</td>
        <td class="small">${poolTxt(c.alloc)}</td><td class="r">${gchip(c.grade)} ${c.score}</td><td></td></tr>${open.has(c.key) ? detail(c) : ''}`; }).join('')}</tbody></table></div>
      <details class="pad small"><summary>Method & limits</summary><p>${esc(D.methods.timeline)}</p><p>${esc(D.methods.allocation)}</p><ul>${D.limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><div class="muted">sources: ${Object.entries(D.sources).map(([k, v]) => esc(k + ' ' + v)).join(' · ')}</div></details>`;
    bindRows();
  }
  function under() {
    const rows = D.candidates.slice().sort((a, b) => b.score - a.score);
    out.innerHTML = hdr('Under-farmed: low TVL vs funding, young, quiet, with a points program', 'sweet spot = high score') + `<div class="tablewrap"><table class="tbl a2tbl"><thead><tr><th>${ix2('a2_under')} Gr</th><th>Protocol</th><th class="r">TVL</th><th class="r">Raised</th><th class="r">${ix2('a2_fdvraised')} Raised/TVL</th><th class="r">Age</th><th class="r">News 90d</th><th>Why</th><th>${ix2('a2_per1k')} /$1k</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="clk" data-k="${esc(c.key)}"><td>${gchip(c.grade)}<div class="muted small">${c.score}</div></td><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.category || '')} · ${esc((c.chains || []).slice(0, 3).join(', '))}</div></td>
        <td class="r">${usd(c.tvl)}</td><td class="r">${usd(c.raised_usd)}</td><td class="r">${c.raised_usd && c.tvl ? (c.raised_usd / c.tvl).toFixed(2) + '×' : '—'}</td><td class="r">${c.age_days ?? '—'}d</td><td class="r">${c.news_90d}${c.heat != null ? ` · ${c.heat}°` : ''}</td>
        <td class="small">${c.why.map(esc).join(' · ')}${c.flags?.length ? `<div class="a2warn">⚠ ${c.flags.map(esc).join(' · ')}</div>` : ''}</td><td class="small">${c.alloc?.per_1k_at_today_tvl ? usd(c.alloc.per_1k_at_today_tvl.lo) + '–' + usd(c.alloc.per_1k_at_today_tvl.hi) : '—'}</td></tr>${open.has(c.key) ? detail(c) : ''}`).join('')}</tbody></table></div>
      <details class="pad small"><summary>Score formula</summary>${esc(D.methods.underfarmed)}</details>`;
    bindRows();
  }

  // ---------------- My Farms ----------------
  let FARMS = null, adapters = null;
  async function loadFarms(refresh) {
    try { FARMS = (await api('/api/airdrops/farms' + (refresh ? '?refresh=1' : ''))).farms; } catch (e) { FARMS = []; }
    if (tab === 'farms') farmsTab();
  }
  function intel(k) {
    const f = D.farms?.[k]; if (!f) return '';
    return `<details class="a2card"><summary><b>${esc(f.name)}</b> research card · ${esc(f.chain)} · TVL ${spark(f.tvl_hist?.weekly)} ${usd(f.tvl_hist?.tvl)} (peak ${usd(f.tvl_hist?.peak)} ${esc(f.tvl_hist?.peak_date || '')})</summary>
      <p class="small">${esc(f.status)}</p><p class="small"><b>Points program:</b> ${esc(f.points_program)}</p>${f.tvl_note ? `<p class="small"><b>TVL note:</b> ${esc(f.tvl_note)}</p>` : ''}${f.user_rank_source ? `<p class="small">${esc(f.user_rank_source)}</p>` : ''}
      <div class="small">${ix2('a2_auto')} automated: ${esc((f.automation?.public || []).join(' · '))}${f.automation?.login?.length ? `<div class="a2warn">needs login (manual): ${esc(f.automation.login.join(' · '))}</div>` : ''}</div>
      <div class="small">${ix2('a2_conf')} evidence:</div><ul class="a2ev small">${(f.evidence || []).map((e) => `<li>${conf(e.confirmed)}${chip(e.kind, 'mut')} ${esc(e.t)} ${esc(e.text)} ${link(e.url, 'source')}</li>`).join('')}</ul>
      <div class="small">${link(f.site, 'app')} ${link(f.docs, 'docs')} ${link(`https://defillama.com/protocol/${f.defillama_slug}`, 'DefiLlama')}</div></details>`;
  }
  function farmCard(f) {
    const L = f.last || {}, A = f.analysis || {}, ad = f.adapter || {};
    const W = A.windows || [];
    const val = f.value;
    let valTxt = '';
    if (val?.usd != null) valTxt = `${usd(val.usd)} <span class="muted small">(${n0(val.yo_earned ?? L.points)} YO × $${val.unit_price}: ${esc(val.unit_price_note)})</span>`;
    else if (val?.scenarios) valTxt = L.share != null ? val.scenarios.map((s) => `${esc(s.label)}: ${usd(L.share * s.pool_usd)}`).join(' · ') : `Day-one community pool ${val.scenarios.map((s) => `${usd(s.pool_usd)} @ ${esc(s.label)}`).join(' · ')}. Your $ = your share × pool; enter total points if TownSquare ever publishes it. <span class="muted">${esc(val.note)}</span>`;
    return `<div class="a2card"><h4>${esc(f.label || f.name)} <span class="muted small">${esc(f.address.slice(0, 6))}…${esc(f.address.slice(-4))}</span> <button class="btn mini2" data-chk="${esc(f.protocol)}|${esc(f.address)}">Check now</button> <button class="btn ghost mini2" data-del="${esc(f.id)}">remove</button></h4>
      <div class="a2grid"><div><span>${esc(ad.unit || 'points')}</span><b>${n0(L.points)}</b></div><div><span>${ix2('a2_rank')} rank</span><b>${L.rank ? '#' + L.rank.toLocaleString() : '—'}</b>${L.total_users ? `<span>of ${L.total_users.toLocaleString()} ${f.protocol === 'townsquare' ? 'registered users' : 'wallets'}</span>` : ''}</div>
        <div><span>${ix2('a2_share')} share of total</span><b>${pcu(L.share, 4)}</b>${L.capital_share != null ? `<span>capital share ${pcu(L.capital_share, 4)}</span>` : ''}</div><div><span>protocol TVL</span><b>${usd(L.tvl)}</b>${f.tvl_since_first?.at_first ? `<span>${pc(f.tvl_since_first.now / f.tvl_since_first.at_first - 1)} since first check</span>` : ''}</div>
        ${L.deposit_usd != null ? `<div><span>your deposit</span><b>${usd(L.deposit_usd)}</b></div>` : ''}${f.protocol === 'yo' && L.extra ? `<div><span>this week / last week YO</span><b>${n0(L.extra.this_week_yo)} / ${n0(L.extra.last_week_yo)}</b></div><div><span>Merkl unclaimed YO</span><b>${n0(L.extra.merkl_unclaimed_yo)}</b></div><div><span>expected YO/day (yoETH Base)</span><b>${n0(L.extra.expected_yo_per_day_base)}</b></div>` : ''}</div>
      ${(A.warnings || []).map((w) => `<div class="a2warn">⚠ ${ix2('a2_dilution')} ${esc(w)}</div>`).join('')}${(A.notes || []).map((w) => `<div class="muted small">• ${esc(w)}</div>`).join('')}
      ${W.length ? `<table class="tbl small"><thead><tr><th>window</th><th class="r">${ix2('a2_rate')} pts/day</th><th class="r">your growth</th><th class="r">total growth</th><th class="r">TVL growth</th><th class="r">share Δ</th><th class="r">rank Δ</th></tr></thead><tbody>${W.map((w) => `<tr><td>${esc(w.label)} (${w.days}d)</td><td class="r">${n0(w.points_per_day)}</td><td class="r">${pc(w.points_growth)}</td><td class="r">${pc(w.total_growth)}</td><td class="r">${pc(w.tvl_growth)}</td><td class="r ${w.share_change < 0 ? 'dn' : 'up'}">${pc(w.share_change)}</td><td class="r">${w.rank_change == null ? '—' : (w.rank_change > 0 ? '+' : '') + w.rank_change}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="small"><b>Value:</b> ${valTxt || '—'}</div>
      <div class="small">${ix2('a2_auto')} automated: ${esc((ad.automated || []).join(' · '))}${ad.manual?.length ? `<br>manual: ${esc(ad.manual.join(' · '))}` : ''}${ad.login?.length ? `<div class="a2warn">login-only: ${esc(ad.login.join(' '))}</div>` : ''}</div>
      ${ad.notes ? `<div class="muted small">${esc(ad.notes)}</div>` : ''}${f.sources ? `<div class="muted small">sources: ${Object.entries(f.sources).map(([k, v]) => esc(k + ' ' + v)).join(' · ')}</div>` : ''}
      <div class="muted small">TVL ${spark(f.tvl_weekly)} · ${f.history?.length || 0} snapshots since ${f.created ? new Date(f.created).toLocaleDateString() : '—'}</div></div>`;
  }
  function farmsTab() {
    if (FARMS == null) { out.innerHTML = '<div class="empty"><span class="spin"></span></div>'; loadFarms(false); return; }
    out.innerHTML = hdr('My Farms: read-only monitor (public address only; never a key or seed phrase)') + `<div class="a2card"><div class="a2form">
      <select id="a2p"><option value="yo">YO Protocol (yoETH)</option><option value="townsquare">TownSquare</option><option value="other">Other (DefiLlama slug)…</option></select>
      <input id="a2slug" placeholder="defillama slug" style="display:none;width:120px"><input id="a2addr" placeholder="wallet address 0x… (public)" style="width:280px">
      <input id="a2pts" placeholder="points (manual)" style="width:100px"><input id="a2rank" placeholder="rank (manual)" style="width:80px"><input id="a2tot" placeholder="total points (if published)" style="width:130px"><input id="a2dep" placeholder="your deposit $ (optional)" style="width:120px">
      <button class="btn" id="a2go">Check now</button></div>
      <div class="muted small">YO is fully automatic (public leaderboard + Merkl + on-chain balance). TownSquare points sit behind a wallet-signature login, so type your points/rank from app.townsq.xyz/ranking each time you check; the desk keeps the history and computes rate, rank change and dilution.</div><div id="a2msg" class="small"></div></div>
      ${(FARMS || []).map(farmCard).join('') || '<div class="muted small pad">No farms yet. Add YO and TownSquare above with your wallet address.</div>'}
      ${intel('yo')}${intel('townsquare')}`;
    Q('#a2p').addEventListener('change', (e) => (Q('#a2slug').style.display = e.target.value === 'other' ? '' : 'none'));
    Q('#a2go').addEventListener('click', () => submit(Q('#a2p').value === 'other' ? Q('#a2slug').value.trim() : Q('#a2p').value, Q('#a2addr').value.trim(), { points: Q('#a2pts').value, rank: Q('#a2rank').value, total: Q('#a2tot').value, deposit: Q('#a2dep').value }));
    out.querySelectorAll('[data-chk]').forEach((b) => b.addEventListener('click', () => { const [p, a] = b.dataset.chk.split('|'); const m = p === 'yo' ? {} : { points: prompt('Your current points (blank = keep last):') || '', rank: prompt('Your current rank (blank = keep last):') || '' }; submit(p, a, m); }));
    out.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('Remove this farm and its history?')) return; await api('/api/airdrops/farm/delete?id=' + encodeURIComponent(b.dataset.del)); loadFarms(false); }));
  }
  async function submit(p, a, m) {
    const msg = Q('#a2msg'); if (msg) msg.innerHTML = '<span class="spin"></span> checking…';
    const qs = new URLSearchParams({ protocol: p, address: a }); for (const [k, v] of Object.entries(m || {})) if (v !== '' && v != null) qs.set(k, String(v).replace(/[, _]/g, ''));
    try { await api('/api/airdrops/farm?' + qs); await loadFarms(false); } catch (e) { if (Q('#a2msg')) Q('#a2msg').innerHTML = `<span class="dn">${esc(e.message)}</span>`; }
  }

  // ---------------- Value calc ----------------
  function value() {
    const S = D.comparable_stats || {}; const C = D.comparables || [];
    out.innerHTML = hdr('Airdrop value estimate from comparables') + `<div class="a2card"><div class="a2form">
      <label class="small">Token FDV at launch $ <input id="vF" placeholder="e.g. 200000000" style="width:120px"></label>
      <label class="small">Airdrop % of supply <input id="vP" placeholder="${S.airdrop_pct?.median?.toFixed(2)}" style="width:70px"></label>
      <label class="small">Your points <input id="vU" style="width:110px"></label><label class="small">Total points <input id="vT" style="width:120px"></label>
      <label class="small">or your share % <input id="vS" style="width:80px"></label><label class="small">or deposit $ / TVL $ <input id="vD" style="width:80px"> / <input id="vV" style="width:100px"></label>
      <select id="vPre"><option value="">preset…</option><option value="ts">TownSquare (sale tiers, day-one pool)</option><option value="comps">Comparables median (big drops)</option></select></div>
      <div id="vOut" class="small"></div></div>
      <div class="tablewrap"><table class="tbl small"><thead><tr><th>${ix2('a2_comps')} Airdrop</th><th>TGE</th><th class="r">% supply</th><th class="r">Price TGE / +7d</th><th class="r">FDV</th><th class="r">Drop $</th><th class="r">TVL at TGE</th><th class="r">Drop $ per $1 TVL</th><th class="r">Raised</th><th class="r">FDV/raised</th><th class="r">1st round→TGE</th></tr></thead><tbody>
      ${C.map((c) => `<tr><td>${esc(c.name)}${c.small ? ' ' + chip('small', 'mut') : ''}${c.pending ? ' ' + chip('pre-TGE', 'warn') : ''}<div class="muted">${esc(c.airdrop_note || '')}</div></td><td>${esc(c.tge)}</td><td class="r">${c.airdrop_pct ?? '—'}%</td><td class="r">${c.price_tge != null ? '$' + (+c.price_tge).toPrecision(3) : '—'} / ${c.price_7d != null ? '$' + (+c.price_7d).toPrecision(3) : '—'}</td><td class="r">${usd(c.fdv_tge)}</td><td class="r">${usd(c.airdrop_usd)}</td><td class="r">${usd(c.tvl_at_tge)}</td><td class="r">${c.airdrop_per_tvl != null ? '$' + c.airdrop_per_tvl.toFixed(3) : '—'}</td><td class="r">${usd(c.raised_before_tge)}</td><td class="r">${c.fdv_per_raised ? Math.round(c.fdv_per_raised) + '×' : '—'}</td><td class="r">${c.months_first_round_to_tge ?? '—'} mo</td></tr>`).join('')}</tbody></table></div>
      <div class="muted small pad">Big-drop stats (excl. small/pre-TGE): airdrop % p25/median/p75 ${['p25', 'median', 'p75'].map((k) => S.airdrop_pct?.[k]?.toFixed(2)).join(' / ')} · FDV/raised ${['p25', 'median', 'p75'].map((k) => S.fdv_per_raised?.[k] ? Math.round(S.fdv_per_raised[k]) + '×' : '—').join(' / ')} · drop $ per $1 TVL ${['p25', 'median', 'p75'].map((k) => S.airdrop_per_tvl?.[k]?.toFixed(3)).join(' / ')} · small-protocol FDV/raised median ${S.fdv_per_raised_small?.median ? Math.round(S.fdv_per_raised_small.median) + '×' : '—'}. Prices: DefiLlama coins API (end of TGE day, and 7 days later); supply and % from the sources in data/airdrop_seed.json.</div>`;
    const calc = () => {
      const F = +Q('#vF').value || null, P = +Q('#vP').value || S.airdrop_pct?.median, U = +Q('#vU').value, T = +Q('#vT').value, Sh = +Q('#vS').value, Dp = +Q('#vD').value, V = +Q('#vV').value;
      const share = U && T ? U / T : Sh ? Sh / 100 : Dp && V ? Dp / V : null;
      const how = U && T ? 'points ÷ total points' : Sh ? 'share you entered' : Dp && V ? 'capital share (deposit ÷ TVL): only meaningful for capital-weighted programs' : null;
      const fdvs = F ? [F] : [S.fdv_tge?.p25, S.fdv_tge?.median, S.fdv_tge?.p75];
      const pools = fdvs.map((f) => (f ? (f * P) / 100 : null));
      Q('#vOut').innerHTML = `Community pool: ${pools.map(usd).join(' / ')} <span class="muted">(${F ? 'your FDV' : 'comparables FDV p25/median/p75 (big drops: optimistic for small protocols)'} × ${P?.toFixed(2)}%)</span>` +
        (share != null ? `<br><b>Your estimate: ${pools.map((p) => usd(p * share)).join(' / ')}</b> <span class="muted">share ${(share * 100).toPrecision(3)}% via ${esc(how)}</span>` : '<br><span class="muted">Enter your points and total points (or a share) to get your slice.</span>');
    };
    out.querySelectorAll('#vF,#vP,#vU,#vT,#vS,#vD,#vV').forEach((i) => i.addEventListener('input', calc));
    Q('#vPre').addEventListener('change', (e) => {
      if (e.target.value === 'ts') { Q('#vF').value = '200000000'; Q('#vP').value = '1.86'; }
      if (e.target.value === 'comps') { Q('#vF').value = ''; Q('#vP').value = S.airdrop_pct?.median?.toFixed(2) || ''; }
      calc();
    });
    calc();
  }

  // ---------------- Speculation ----------------
  function spec() {
    const items = [];
    for (const [k, f] of Object.entries(D.farms || {})) items.push({ name: f.name, ev: f.evidence || [], news: f.news || [], farm: true, status: f.status });
    for (const c of D.candidates.slice().sort((a, b) => b.score - a.score).slice(0, 40)) items.push({ name: c.name, ev: c.timeline?.evidence || [], news: c.news || [], io: c.airdrops_io, heat: c.heat, flags: c.flags });
    out.innerHTML = hdr('Speculation tracker: official hints vs community expectations') + `<div class="muted small pad">${ix2('a2_conf')} Confirmed = team statement or funding/on-chain fact. Unconfirmed = news speculation, airdrop-site listing, pre-market price, third-party calendars. Headlines: Google News RSS (crypto-filtered).</div>` +
      items.map((it) => { const off = it.ev.filter((e) => e.kind === 'official' || e.kind === 'funding' || e.kind === 'onchain'), com = it.ev.filter((e) => !(e.kind === 'official' || e.kind === 'funding' || e.kind === 'onchain'));
        return `<details class="a2card" ${it.farm ? 'open' : ''}><summary><b>${esc(it.name)}</b> ${it.farm ? chip('your farm', 'ok') : ''} ${chip(it.ev.filter((e) => e.confirmed).length + ' confirmed', 'ok')} ${chip(it.ev.filter((e) => !e.confirmed).length + ' unconfirmed', 'warn')} ${chip(it.news.length + ' headlines', 'mut')} ${it.io ? chip('on airdrops.io' + (it.heat != null ? ' ' + it.heat + '°' : ''), 'warn') : ''}</summary>
          ${it.status ? `<p class="small">${esc(it.status)}</p>` : ''}
          <div class="small"><b>Official hints</b>${off.length ? `<ul class="a2ev">${off.map((e) => `<li>${conf(e.confirmed)}${esc(e.t || '')} ${esc(e.text)} ${link(e.url, 'source')}</li>`).join('')}</ul>` : ' <span class="muted">none found in free sources</span>'}</div>
          <div class="small"><b>Community signals</b>${com.length ? `<ul class="a2ev">${com.map((e) => `<li>${conf(e.confirmed)}${chip(e.kind, 'mut')} ${esc(e.t || '')} ${esc(e.text)} ${link(e.url, 'source')}</li>`).join('')}</ul>` : ''}${it.news.length ? `<ul class="a2ev">${it.news.slice(0, 6).map((n) => `<li>${n.confirmed_kw ? chip('token-launch wording', 'ok') : n.spec_kw ? chip('speculation', 'warn') : chip('news', 'mut')} ${esc(n.t)} ${link(n.url, n.title.slice(0, 110))}</li>`).join('')}</ul>` : ' <span class="muted">no headlines</span>'}</div>
          ${it.flags?.length ? `<div class="a2warn">⚠ ${it.flags.map(esc).join(' · ')}</div>` : ''}</details>`; }).join('');
  }
  // ---------------- ROI ranking ----------------
  let R = null, roiAll = false;
  const mu = (x) => (x == null || isNaN(x) ? '—' : (x < 0 ? '−' : '') + (Math.abs(x) < 10 ? '$' + Math.abs(x).toFixed(2) : fUsd(Math.abs(x))));
  const kchip = (k) => chip(k || 'unknown', k === 'sourced' ? 'ok' : k === 'derived' ? 'ok' : k === 'assumed' ? 'warn' : 'mut');
  const rngTxt = (o, f) => (o ? `${f(o.lo)} / <b>${f(o.base)}</b> / ${f(o.hi)}` : '—');
  const xr = (x) => (x == null ? 'n/m' : x.toFixed(2) + '×');
  const pt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' PT';
  const tierChip = (t) => (t === 'allowed' ? chip('US OK', 'ok') : t === 'unknown' ? chip('US terms unknown', 'warn') : chip('US restricted', 'bad'));
  const IN = { p_token: ['P(token)', (v) => pcu(v, 0)], fdv: ['FDV', mu], comm_pct: ['Community %', (v) => v + '%'], participants: ['Participants', n0], total_points: ['Total points', n0], weekly_pool: ['Weekly points', n0], points_left: ['Points left', n0], weeks_left: ['Weeks left', n0], k: ['Your weight', (v) => v + '×'], deposit: ['Deposit', mu], window_share: ['Window share', (v) => pcu(v, 0)], capital: ['Capital', mu], weekly_cost: ['Fees/week', mu], hours_week: ['Hours/week', (v) => v], risk_yr: ['Loss risk/yr', (v) => pcu(v, 0)], pool_tokens: ['Pool tokens', n0] };
  function inputsTbl(inp) {
    return `<table class="a2tbl small"><tr><th>input</th><th>low / base / high</th><th>label</th><th>note / source</th></tr>${Object.entries(inp).map(([k, v]) => {
      if (k === 'funding') return `<tr><td>Funding</td><td>${v.usd != null ? mu(v.usd) : 'unknown'}${v.valuation ? ' · val ' + mu(v.valuation) : ''}</td><td>${kchip(v.kind)}</td><td>${esc(v.note || '')} ${link(v.src, 'source')}</td></tr>`;
      const [lab, f] = IN[k] || [k, n0];
      const val = v.kind === 'unknown' ? 'unknown' : v.lo == null ? f(v.base) : `${f(v.lo)} / <b>${f(v.base)}</b> / ${f(v.hi)}`;
      return `<tr><td>${esc(lab)}</td><td>${val}</td><td>${kchip(v.kind)}</td><td>${esc(v.note || '')} ${link(v.src, 'source')}</td></tr>`; }).join('')}</table>`;
  }
  function roiCard(c) {
    const s = c.saturation || {}, cb = c.cost.base || {};
    return `<details class="a2card"><summary><b>#${c.rank} ${esc(c.name)}</b> ${tierChip(c.tier)} ${c.confirmed ? chip('token/points confirmed', 'ok') : chip('speculative', 'warn')} <span class="muted small">${esc(c.chain)} · ${esc(c.cat)}</span><br>
      <span class="small">EV ${rngTxt(c.ev, mu)} · cost <b>${mu(cb.total)}</b> · ROI ${rngTxt(c.roi, xr)} · net base <b>${mu(c.net.base)}</b> · saturation <b>${s.score ?? '—'}</b></span></summary>
      <p class="small">${esc(c.status)} ${link(c.status_src, 'source')} · US: ${esc(c.us)}${c.us_note ? ' (' + esc(c.us_note) + ')' : ''} ${link(c.us_src, 'terms')}</p>
      ${c.tier === 'restricted' ? '<div class="a2warn">⚠ Excludes US persons. Shown for comparison only; do not farm it through a VPN (breaks the terms; allocations get voided).</div>' : ''}
      ${c.tier === 'unknown' ? '<div class="a2warn">⚠ Read the terms for US eligibility before doing anything.</div>' : ''}
      <div class="a2grid"><div><span>EV / wallet (low/base/high)</span>${rngTxt(c.ev, mu)}</div><div><span>Cost base: time + fees + opp. + risk</span>${mu(cb.time)} + ${mu(cb.direct)} + ${mu(cb.opportunity)} + ${mu(cb.risk)} over ${cb.weeks} wk</div>
      <div><span>ROI (EV ÷ cost)</span>${rngTxt(c.roi, xr)}</div><div><span>Saturation ${ix2('a2_sat')}</span>${s.score ?? '—'} ${parts(s.parts && Object.fromEntries(Object.entries(s.parts).filter(([, v]) => v != null)))}</div>
      <div><span>Expected pool (base)</span>${mu(s.expected_pool_usd)}${s.remaining_fraction != null ? ` · ${pcu(s.remaining_fraction, 0)} still to distribute` : ''}</div><div><span>Pool $ left per participant</span>${s.pool_per_participant_usd != null ? mu(s.pool_per_participant_usd) : 'unknown'}</div>
      <div><span>X posts, 7 days (weak hype proxy)</span>${s.x_posts7d ?? 'not measured'}</div>${c.extra?.tvl_usd ? `<div><span>TVL now (DefiLlama)</span>${mu(c.extra.tvl_usd)}</div>` : ''}${c.extra?.pool_usd_live ? `<div><span>Pool at live price</span>${mu(c.extra.pool_usd_live)}<br><span>${esc(c.extra.pool_note)}</span></div>` : ''}</div>
      <div class="small"><b>Method:</b> ${esc(c.ev_method)}</div>
      <div class="small"><b>What to do</b> (you do it yourself; nothing here signs or trades) · budget cap <b>${mu(c.plan.budget_cap)}</b> · time ${esc(c.plan.time)}<ol class="a2ev">${c.plan.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
      <b>When to stop:</b> ${esc(c.plan.stop)}<br><b>Claim / sell:</b> ${esc(c.plan.claim)}</div>
      <details><summary class="small">Inputs ${ix2('a2_kind')} (${c.inputs_sourced}/${c.inputs_total} sourced or derived)</summary>${inputsTbl(c.inputs)}</details>
      <div class="muted small">Signal strength: ${esc(c.strength)} · data as of ${pt(R.generatedAt)} · seed reviewed ${esc(R.reviewed)}</div></details>`;
  }
  async function roiTab() {
    if (!R) { out.innerHTML = '<div class="empty"><span class="spin"></span> loading Airdrop ROI…</div>'; try { R = await api('/api/airdrops/roi'); } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
    const cs = roiAll ? R.candidates.slice().sort((a, b) => a.rank_if_eligible - b.rank_if_eligible) : R.candidates;
    const cal = R.calibration, B = cal.buckets;
    out.innerHTML = `<div class="muted small pad">Airdrop ROI ${ix2('a2_roi')} · ranks where your time and money earn the most, not what is most hyped · data as of ${pt(R.generatedAt)} · X counts as of ${R.x_counts_asof ? pt(Date.parse(R.x_counts_asof)) : 'unknown'} · strength: unproven (model), calibration ${esc(cal.strength)} · estimates, not advice</div>
      <div class="a2form small"><label><input type="checkbox" id="roiAll" style="width:auto;display:inline" ${roiAll ? 'checked' : ''}> rank everything as if eligible (comparison only)</label> <span class="muted">Home jurisdiction: ${esc(R.you.jurisdiction)} (${esc(R.you.jurisdiction_note)})</span> <button class="btn mini2" data-a2go="under">Discovery: Under-farmed tab →</button></div>
      <table class="a2tbl small"><tr><th>#</th><th>Program</th><th>US</th><th>EV/wallet lo/base/hi</th><th>Cost (base)</th><th>ROI lo/base/hi</th><th>Net (base)</th><th>Saturation</th><th>Inputs sourced</th></tr>
      ${cs.map((c, i) => `<tr><td>${roiAll ? c.rank_if_eligible : c.rank}</td><td>${esc(c.name)}</td><td>${tierChip(c.tier)}</td><td>${rngTxt(c.ev, mu)}</td><td>${mu(c.cost.base.total)}</td><td>${rngTxt(c.roi, xr)}</td><td>${mu(c.net.base)}</td><td>${c.saturation.score ?? '—'}</td><td>${c.inputs_sourced}/${c.inputs_total}</td></tr>`).join('')}</table>
      <div class="muted small pad">${esc(R.method.rank)} ${esc(R.method.scenarios)} ROI "n/m" = costs under $10, so use EV. Click a card for inputs, farm plan, stop rule and claim plan.</div>
      ${cs.map(roiCard).join('')}
      <details class="a2card" open><summary><b>Calibration: does crowding cut per-wallet value?</b> ${chip(cal.strength, 'warn')}</summary>
        <ul class="a2ev small">${cal.verdict.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
        <table class="a2tbl small"><tr><th>Crowd</th><th>n</th><th>Drops</th><th>$/wallet p25 / median / p75 at TGE</th><th>Median price change +30d / +90d</th></tr>
        ${['small', 'mid', 'mega'].map((b) => `<tr><td>${b}${b === 'small' ? ' (<150k)' : b === 'mid' ? ' (150–600k)' : ' (>600k)'}</td><td>${B[b].n}</td><td>${B[b].names.join(', ')}</td><td>${mu(B[b].per_wallet_p25)} / <b>${mu(B[b].per_wallet_median)}</b> / ${mu(B[b].per_wallet_p75)}</td><td>${pc(B[b].ret30_median)} / ${pc(B[b].ret90_median)}</td></tr>`).join('')}</table>
        <table class="a2tbl small"><tr><th>Drop</th><th>TGE</th><th>Wallets</th><th>Pool $ at TGE</th><th>$/wallet</th><th>+30d</th><th>+90d</th><th>source</th></tr>
        ${cal.rows.map((r) => `<tr><td>${esc(r.sym)}</td><td>${esc(r.tge)}${r.tge_kind === 'assumed' ? ' ' + chip('date assumed', 'warn') : ''}</td><td>${n0(r.wallets)}</td><td>${mu(r.pool_usd)}</td><td>${mu(r.per_wallet_usd)}</td><td>${pc(r.ret30)}</td><td>${pc(r.ret90)}</td><td>${link(r.src, 'source')}</td></tr>`).join('')}</table>
        <ul class="a2ev small muted">${cal.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>
      <details class="a2card"><summary><b>Checked and rejected (${R.rejected.length})</b></summary><ul class="a2ev small">${R.rejected.map((r) => `<li><b>${esc(r.name)}</b>: ${esc(r.why)} ${link(r.src, 'source')}</li>`).join('')}</ul></details>
      <div class="muted small pad">${esc(R.method.saturation)} ${esc(R.method.refresh)}</div>`;
    Q('#roiAll', out).onchange = (e) => { roiAll = e.target.checked; roiTab(); };
    Q('[data-a2go]', out).onclick = (e) => setTab(e.target.dataset.a2go);
  }
  setTab('roi');
  window.ad2Show = setTab;
})();
