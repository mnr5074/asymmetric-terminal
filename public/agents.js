// AI Agents Desk (Command view), weighted to Virtuals: launchpad, upcoming launches, how allocation works now, VIRTUAL token,
// birth-phase library + live lookalike matcher, AI-agent protocol comparison, DOT tracker. Data: /api/agents. Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const U = (x) => { if (x == null || isNaN(x)) return '—'; const a = Math.abs(x); return (x < 0 ? '-' : '') + '$' + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a >= 1 ? Math.round(a).toLocaleString() : a.toPrecision(3)); };
  const PC = (x, d = 1) => (x == null || isNaN(x) ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : ''}${(+x).toFixed(d)}%</span>`);
  const N = (x) => (x == null || isNaN(x) ? '—' : Math.round(x).toLocaleString());
  const H = (h) => (h == null ? '—' : h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd');
  const D = (s) => (s ? String(s).slice(0, 10) : '—');
  const I = (k) => (window.ix ? window.ix(k) : '');
  const G = window.EXPLAIN || {};
  Object.assign(G, {
    ag_desk: ['AI Agents desk', 'Everything about AI-agent tokens, weighted to Virtuals Protocol (your thesis), but every number shown is the raw public figure. Sources: Virtuals public API, CoinGecko, DefiLlama, DexScreener, GeckoTerminal, Base/Robinhood chain data, Google News.', null, 'AI Agents'],
    ag_curve: ['Bonding curve', 'A new Virtuals token first trades against a formula (the "curve") on Virtuals itself. Each buy pushes the price up. When 42,000 VIRTUAL has gone in, it "graduates" to a normal Uniswap pool with liquidity locked for 10 years.', null, 'AI Agents'],
    ag_grad: ['Graduation', 'The moment a token leaves the bonding curve and gets a real DEX pool (42,000 VIRTUAL raised). Over 75% of Virtuals tokens have their busiest day at graduation.', null, 'AI Agents'],
    ag_xstart: ['× since curve start', 'Current market cap divided by the market cap the token started at on the curve (8,500 VIRTUAL for today\'s standard launches). 1.0× = back where it started.', null, 'AI Agents'],
    ag_antic: ['Anticipation score (0–100)', 'Adds only things we can see: Launch Radar listing (15), verified by Virtuals (15), verified X/website (10), team listed (15), GitHub pushes in 30 days (10), news mentions in 14 days (20), holders before launch (15), founder video (5). It measures attention, not quality.', null, 'AI Agents'],
    ag_radar: ['Launch Radar', 'A founder pays 100 VIRTUAL to show the project before trading opens. Visibility only, no reserved allocation for anyone.', null, 'AI Agents'],
    ag_60d: ['60 Days launch', 'A trial launch: the founder has 60 days to prove it. If they walk away, the pool is drained and what is left is refunded to holders (not always in full). Founder fees stay locked until they commit.', null, 'AI Agents'],
    ag_ve: ['veVIRTUAL', 'VIRTUAL you lock (up to 2 years). It counts for airdrops: launches that switch on Airdrop Distribution give up to 5% of their supply to lockers in proportion to veVIRTUAL. It shrinks to zero as the unlock date approaches unless Auto Max-Lock is on.', null, 'AI Agents'],
    ag_sniper: ['Anti-sniper tax', 'Optional launch setting: buys pay a tax that starts at 99% and falls to 1% over up to 98 minutes. The tax buys tokens back for the team. Buying in the first minutes can lose most of your money to tax.', null, 'AI Agents'],
    ag_genesis: ['Genesis (ended)', 'The old Virtuals launch format (Apr–Oct 2025): you pledged VIRTUAL and Virgen points to get a share; extra pledges were refunded. It was shut down and points phased out. Shown here only as history.', null, 'AI Agents'],
    ag_oversub: ['Pledged ÷ 42K', 'How much VIRTUAL was pledged compared with the standard 42,000 raise. 3× means demand was three times the target, so pledgers got roughly a third of what they asked for. The exact tier per launch is not published.', null, 'AI Agents'],
    ag_drawdown: ['Down from ATH', 'How far the price is below its all-time high. −85% means it would have to rise about 6.7× to get back there.', null, 'AI Agents'],
    ag_rev: ['Protocol revenue', 'Fees the protocol keeps (DefiLlama). For Virtuals: its 30% share of the 1% trading fee plus other protocol income. "Holders revenue" is the part used for buybacks, burns or payouts to holders.', null, 'AI Agents'],
    ag_obj: ['Objective score', 'Where a protocol ranks inside this peer group on 30-day fees (30%), market cap (25%), 30-day price change (20%), GitHub commits (15%) and trading turnover (10%). Missing data is skipped, never guessed.', null, 'AI Agents'],
    ag_thesis: ['Desk score (thesis-weighted)', 'Objective score with a tilt for your thesis: Virtuals ×1.25. Both ranks are shown so you can see exactly how much the tilt moves it.', null, 'AI Agents'],
    ag_birth: ['Birth-phase library', 'For past Virtuals launches we replay every trade from the very first buyer on the curve: who bought first and how much, how fast the curve filled, how concentrated holders were, and how high it went later. This is the reference set for spotting lookalikes.', null, 'AI Agents'],
    ag_match: ['Lookalike match %', 'How close a live launch\'s birth so far is to a past launch at the same market-cap stage: buyer counts, holder concentration, buy sizes, speed and the shape of its price curve. 100% = identical. A match is a resemblance, not a forecast.', null, 'AI Agents'],
    ag_base: ['Base rate', 'Out of a random sample of past Virtuals launches that reached this stage, how many went on to $1M. Compare the lookalikes\' hit rate with it: if they are not better than the base rate, the match tells you nothing.', null, 'AI Agents'],
    ag_valid: ['Matcher check (AUC)', 'We hid each random-sample launch and asked the matcher to rank it from its lookalikes. AUC 0.5 = coin flip, 1.0 = perfect. Top-third vs bottom-third hit rates show whether high matches actually ran more often.', null, 'AI Agents'],
    ag_fresh: ['Fresh wallets', 'First buyers whose wallet had made 2 or fewer transactions before buying (Base only). Several fresh wallets buying within 6 hours is the "coordinated fresh-wallet" pattern from detector 2, often one person with many wallets.', null, 'AI Agents'],
    ag_repeat: ['Repeat early buyers', 'First buyers who were also among the first 25 buyers of earlier launches in the library: bots, snipers or the Virtuals launch infrastructure itself.', null, 'AI Agents'],
    ag_prebuy: ['Pre-buy', 'A large buy (5,000+ VIRTUAL) in the very first block of trading: the creator\'s Pre-buy module or a seeding wallet. It jumps the market cap before the public trades.', null, 'AI Agents'],
    ag_gini: ['Gini', 'Holder inequality from 0 (everyone holds the same) to 1 (one wallet holds everything). Fresh launches are usually above 0.9.', null, 'AI Agents'],
    ag_fill: ['Curve fill speed', 'Net VIRTUAL entering the curve per hour as a % of the 42,000 needed to graduate. 100%/h = graduates in about an hour.', null, 'AI Agents'],
    ag_dot: ['DOT (Dot, usedot.xyz)', 'Private AI app on Base (not Polkadot, not a Virtuals launch). Its site says it buys DOT with revenue and burns it. We check the token supply and burn addresses every day and measure the price reaction around the first recurring burn.', null, 'AI Agents'],
    ag_xref: ['Pump detector / narrative cross-check', 'Matches Virtuals tokens against the terminal\'s pump detector grades and the Narratives desk. "Early-launch pattern" = under 24 hours old or still on the curve while the AI-agents theme is emerging or heating.', null, 'AI Agents'],
  });
  const css = document.createElement('style');
  css.textContent = `.agd .sub{display:flex;gap:2px;flex-wrap:wrap;margin-bottom:4px}.agd .sub button{background:none;border:0;color:var(--mut);font:inherit;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;padding:2px 6px;border-bottom:2px solid transparent;cursor:pointer}
  .agd .sub button.on{color:#fff;border-color:var(--acc)}.agd .kv{display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0}.agd .kv div{white-space:nowrap}.agd .note{white-space:normal;line-height:1.35;margin:4px 0}
  .agd .card{border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin:4px 0;white-space:normal}.agd .tag{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;background:#262b33;color:#cbd}
  .agd .tag.g{background:#1f6f3f;color:#fff}.agd .tag.r{background:#7a1f1f;color:#fff}.agd .tag.y{background:#5a4a10;color:#ffd}.agd .tbl td.w{white-space:normal;max-width:380px}.agd .thesis{background:rgba(120,160,255,.08)}`;
  document.head.appendChild(css);
  let DATA = null, tab = localStorage.getItem('agTab') || 'launchpad', started = false;
  async function load() {
    try { DATA = await (typeof api === 'function' ? api('/api/agents') : fetch('/api/agents').then((r) => r.json())); }
    catch (e) { const o = Q('#agOut'); if (o) o.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return; }
    if (DATA && DATA.error) { Q('#agOut').innerHTML = `<div class="empty">${E(DATA.error)}</div>`; return; }
    render();
  }
  const TABS = [['launchpad', 'Virtuals launches'], ['upcoming', 'Upcoming'], ['alloc', 'How to get in'], ['virtual', 'VIRTUAL'], ['birth', 'Birth library & lookalikes'], ['protocols', 'Protocols'], ['dot', 'DOT']];
  function render() {
    const o = Q('#agOut'); if (!o || !DATA) return;
    const m = Q('#agMeta'); if (m) m.textContent = `updated ${Math.round((DATA.ageSec || 0) / 60)}m ago · VIRTUAL $${(DATA.virtual_usd || 0).toFixed(3)}`;
    const f = { launchpad, upcoming, alloc, virtual: virt, birth, protocols, dot }[tab] || launchpad;
    let body = ''; try { body = f(); } catch (e) { body = `<div class="empty">render error: ${E(e.message)}</div>`; }
    o.innerHTML = `<div class="agd"><div class="sub">${TABS.map(([k, l]) => `<button data-agt="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>${body}<div class="small muted note">${E(DATA.disclaimer || '')} Sources: ${E(Object.entries(DATA.sources || {}).map(([k, v]) => k + ': ' + v).join(' · '))}</div></div>`;
  }
  function launchpad() {
    const L = DATA.launchpad || {}; const x = DATA.crossref || {}; const xb = {}; (x.rows || []).forEach((r) => { xb[r.id] = r; });
    const c = L.counts_30d || {};
    const row = (r) => { const xr = xb[r.id] || {}; return `<tr><td><a href="${E(r.url)}" target="_blank" rel="noopener">${E(r.symbol)}</a> <span class="muted small">${E((r.name || '').replace(/ by Virtuals$/, '').slice(0, 22))}</span></td><td>${E(r.chain)}</td><td>${r.status === 'graduated' ? '<span class="tag g">grad</span>' : '<span class="tag">curve</span>'}</td><td>${D(r.launched_at)}</td><td class="r">${H(r.curve_to_grad_h)}</td><td class="r">${U(r.mcap_usd)}</td><td class="r">${r.x_since_curve_start != null ? r.x_since_curve_start + '×' : '—'}</td><td class="r">${U(r.volume24h)}</td><td class="r">${U(r.liquidity_usd)}</td><td class="r">${N(r.holders)}</td><td class="r">${r.top10_pct != null ? Math.round(r.top10_pct) + '%' : '—'}</td><td>${(xr.flags || []).map((f) => `<span class="tag y">${E(f)}</span>`).join(' ') || (xr.detector ? E(xr.detector.grade) : '')}</td></tr>`; };
    const th = `<thead><tr><th>Agent</th><th>Chain</th><th>Stage ${I('ag_curve')}</th><th>Launched</th><th class="r">Curve→grad ${I('ag_grad')}</th><th class="r">Mcap</th><th class="r">× start ${I('ag_xstart')}</th><th class="r">Vol 24h</th><th class="r">Liquidity</th><th class="r">Holders</th><th class="r">Top10</th><th>Flags ${I('ag_xref')}</th></tr></thead>`;
    const t = x.theme || {};
    return `<div class="kv small"><div>Last 30 days: ${Object.entries(c).map(([k, v]) => `${E(k)} ${N(v.created_30d)} created / ${N(v.graduated_30d)} graduated`).join(' · ')}</div><div>Graduation = 42,000 VIRTUAL ≈ ${U(L.graduation_threshold_usd)} ${I('ag_grad')}</div></div>
      <div class="kv small"><div>AI-agents theme (Narratives desk): <b>${E(t.status || '—')}</b>, momentum ${E(t.momentum ?? '—')}, mcap 7d ${t.mcap7d_pct ?? '—'}% / 30d ${t.mcap30d_pct ?? '—'}%, breadth 7d ${t.breadth7 != null ? Math.round(t.breadth7 * 100) + '%' : '—'}</div><div>Pump-detector overlap: ${(x.rows || []).filter((r) => r.detector).length} of ${(x.rows || []).length} Virtuals tokens are in the live feed</div></div>
      <div class="small muted">Recent launches (graduated in 30 days + 7-day launches with 25+ holders), by market cap</div>
      <table class="tbl">${th}<tbody>${(L.recent || []).slice(0, 40).map(row).join('') || '<tr><td colspan=12 class="empty">none</td></tr>'}</tbody></table>
      <div class="small muted" style="margin-top:6px">Largest Virtuals agents (all time, graduated)</div><table class="tbl">${th}<tbody>${(L.top_agents || []).slice(0, 25).map(row).join('')}</tbody></table>`;
  }
  function upcoming() {
    const u = DATA.upcoming || {};
    const rows = (u.items || []).map((r) => `<tr><td><a href="${E(r.url)}" target="_blank" rel="noopener">${E(r.symbol)}</a> <span class="muted small">${E((r.name || '').replace(/ by Virtuals$/, '').slice(0, 24))}</span></td><td>${r.kind === 'scheduled' ? '<span class="tag y">scheduled</span>' : r.kind === 'launch_radar' ? `<span class="tag">radar</span>` : `<span class="tag">60 days</span>`}</td><td>${E(r.chain)}</td><td>${r.starts_in_h != null ? 'in ' + H(r.starts_in_h) : D(r.launched_at)}</td><td class="r"><b>${r.anticipation}</b></td><td class="r">${N(r.holders)}</td><td class="r">${U(r.mcap_usd)}</td><td class="r">${r.news_n}</td><td>${r.team.length ? E(r.team.map((m) => m.name).filter(Boolean).join(', ')) : '<span class="muted">not listed</span>'}</td><td>${r.github ? E(r.github.repo || r.github.org) + ' ' + D(r.github.pushed_at || r.github.last_push) : '—'}</td><td class="w small">${E(Object.entries(r.anticipation_parts || {}).filter(([, v]) => v).map(([k, v]) => k.replace(/_/g, ' ') + ' ' + v).join(', '))}</td></tr>`).join('');
    return `<div class="note small">${E(u.note || '')} ${I('ag_antic')} ${I('ag_radar')} ${I('ag_60d')}</div><div class="small">Scheduled with a future start: ${u.n_scheduled ?? 0} (${u.n_scheduled_low_signal ?? 0} of them look like placeholders: ≤2 holders, no signals).</div>
      <table class="tbl"><thead><tr><th>Project</th><th>Type</th><th>Chain</th><th>Starts / launched</th><th class="r">Anticip. ${I('ag_antic')}</th><th class="r">Holders</th><th class="r">Mcap</th><th class="r">News 14d</th><th>Team</th><th>GitHub</th><th>Why</th></tr></thead><tbody>${rows || '<tr><td colspan=11 class="empty">no upcoming launches published right now</td></tr>'}</tbody></table>`;
  }
  function alloc() {
    const M = DATA.mechanics || {}; const g = DATA.genesis || {};
    const w = (M.ways_to_get_in || []).map((x) => `<tr><td><b>${E(x.what)}</b></td><td class="w">${E(x.how)}</td><td class="w small">${E(x.caps)}</td><td class="w small">${E(x.refund)}</td></tr>`).join('');
    const top = (g.top_now || []).map((r) => `<tr><td>${E(r.symbol)}</td><td>${D(r.genesis_end)}</td><td class="r">${N(r.pledged_virtual)}</td><td class="r">${r.pledge_x_vs_42k}×</td><td class="r">${N(r.participants)}</td><td class="r">${U(r.mcap_usd_now)}</td></tr>`).join('');
    const fn = g.finalized_now || {};
    return `<div class="card"><b>${E(M.headline || '')}</b> ${I('ag_genesis')}<div class="small muted">As of ${E(M.as_of || '')}</div></div>
      <table class="tbl"><thead><tr><th>Way in</th><th>How it works</th><th>Caps</th><th>Refund</th></tr></thead><tbody>${w}</tbody></table>
      <div class="note small">${E(M.fees || '')} ${I('ag_sniper')} ${I('ag_ve')}</div><div class="note small">${E(M.titan || '')}</div>
      <div class="card"><b>Genesis history (ended)</b> ${I('ag_genesis')}: ${N(g.n_total)} Genesis launches ${D(g.first_end)} → ${D(g.last_end)}: ${N((g.counts || {}).FINALIZED)} finalized, ${N((g.counts || {}).FAILED)} failed, ${N((g.counts || {}).CANCELLED)} cancelled (success ${g.success_rate != null ? Math.round(g.success_rate * 100) + '%' : '—'}).
        Finalized launches drew a median ${N((g.finalized_pledged_virtual || {}).median)} VIRTUAL pledged (${g.oversubscription_vs_42k_median}× the 42K target ${I('ag_oversub')}; p90 ${N((g.finalized_pledged_virtual || {}).p90)}, max ${N((g.finalized_pledged_virtual || {}).max)}) from a median ${N((g.finalized_participants || {}).median)} wallets.
        <b>Today</b> the ${N(fn.n_priced)} finalized Genesis tokens have a median market cap of ${U(fn.median_mcap_usd)}; ${N(fn.n_above_1m)} are above $1M, ${N(fn.n_above_10m)} above $10M, ${N(fn.n_below_100k)} below $100K.<div class="small muted">${E(g.caveats || '')}</div></div>
      <table class="tbl"><thead><tr><th>Genesis token</th><th>Ended</th><th class="r">Pledged VIRTUAL</th><th class="r">÷42K ${I('ag_oversub')}</th><th class="r">Wallets</th><th class="r">Mcap now</th></tr></thead><tbody>${top}</tbody></table>
      <div class="small muted">Sources: ${(M.sources || []).map((s) => `<a href="${E(s)}" target="_blank" rel="noopener">${E(s.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join(' · ')}</div>`;
  }
  function virt() {
    const v = DATA.virtual || {}; const p = v.protocol || {};
    return `<div class="kv"><div>Price <b>$${v.price_usd != null ? (+v.price_usd).toFixed(4) : '—'}</b></div><div>Mcap ${U(v.mcap_usd)} (#${E(v.mcap_rank ?? '—')})</div><div>FDV ${U(v.fdv_usd)}</div><div>Circulating ${N(v.circulating)} / ${N(v.total_supply)}</div><div>Vol 24h ${U(v.volume24h_usd)}</div></div>
      <div class="kv"><div>24h ${PC(v.ch24h_pct)}</div><div>7d ${PC(v.ch7d_pct)}</div><div>30d ${PC(v.ch30d_pct)}</div><div>90d ${PC(v.ch90d_pct)}</div><div>1y ${PC(v.ch1y_pct)}</div><div>ATH $${E(v.ath_usd)} on ${D(v.ath_date)}: ${PC(v.ath_drawdown_pct)} ${I('ag_drawdown')}</div></div>
      <div class="kv"><div>Protocol fees 30d ${U(p.fees_30d)} (${PC(p.fees_30d_trend_pct)} vs prior 30d)</div><div>Revenue 30d ${U(p.revenue_30d)} ${I('ag_rev')} (${PC(p.revenue_30d_trend_pct)})</div><div>Revenue annualized ${U(p.revenue_annualized)}</div><div>Revenue all-time ${U(p.revenue_all_time)}</div><div>Holders revenue (buyback/burn) 30d ${U(p.holders_revenue_30d)}</div></div>
      <div class="note small">${E(v.buyback_note || '')}${(v.buyback_news || []).length ? ' Headlines: ' + v.buyback_news.map((n) => `<a href="${E(n.link)}" target="_blank" rel="noopener">${E(n.title)}</a>`).join(' · ') : ''}</div>
      <div class="small muted">Sources: ${E(v.source || '')}, DefiLlama /summary/fees/virtuals-protocol</div>`;
  }
  function birth() {
    const b = DATA.birth; if (!b) return '<div class="empty">Birth-phase library is being built (first build takes a few hours).</div>';
    const c = b.coverage || {}; const v = b.validation || {}; const br = b.base_rates || {};
    const cases = (b.case_studies || []).map((x) => { if (x.status) return `<div class="card"><b>${E(x.name)}</b>: ${E(x.status)}</div>`; const cu = x.curve || {}; const o = x.outcome || {}; const bs = cu.buy_size || {};
      return `<div class="card"><b>${E(x.name)}</b> <span class="muted small">${E(x.chain)} ${E(x.token || '')}</span><div class="small">${E(x.note || '')}</div>
      <div class="kv small"><div>First buy ${E((x.first_buy_at || '').replace('T', ' ').slice(0, 16))} UTC</div><div>Curve → graduation ${H(cu.first_buy_to_graduation_h)}</div><div>Fill ${N(cu.fill_pct_per_h)}%/h ${I('ag_fill')}</div><div>Curve buyers ${N(cu.unique_buyers)} (${N(cu.n_buys)} buys)</div><div>Buy size median ${U(bs.median_buy_usd)} · p90 ${U(bs.p90_buy_usd)} · top buyer ${bs.top_buyer_share ?? '—'}%</div>
      <div>Pre-buy ${x.prebuy ? U(x.prebuy.usd) + ' by ' + E(x.prebuy.wallet) : 'none'} ${I('ag_prebuy')}</div><div>Fresh first buyers ${x.fresh_first_buyers ?? '—'} ${I('ag_fresh')}</div><div>Holders at curve end ${N((cu.holders_end || {}).holders)}, top10 ${((cu.holders_end || {}).top10_pct ?? '—')}%, Gini ${((cu.holders_end || {}).gini ?? '—')} ${I('ag_gini')}</div>
      <div>Curve start ${U(cu.launch_mcap_usd)} → curve peak ${U(cu.peak_curve_mcap_usd)}</div><div><b>Peak ${U(o.peak_mcap_usd)}</b> on ${D(o.peak_at)}</div><div>Hours to $100K/$1M/$10M: ${H(o.hours_to_100k)} / ${H(o.hours_to_1000k)} / ${H(o.hours_to_10000k)}</div></div>
      <div class="small muted">First buyers: ${(x.first_buyers || []).slice(0, 8).map((f) => `${E(f.short)} +${f.t_s}s ${U(f.usd)}${f.fresh ? ' fresh' : ''}${f.contract_wallet ? ' (smart wallet)' : ''}${f.wallet_age_days != null ? ' age ' + f.wallet_age_days + 'd' : ''}`).join(' · ')}</div><div class="small muted">Path: ${E((x.post || {}).resolution || '')} ${E((x.post || {}).peak_basis || '')}</div></div>`; }).join('');
    const unres = Object.entries(b.case_unresolved || {}).map(([k, t]) => `<div class="card small"><b>${E(k)}</b>: ${E(t)}</div>`).join('');
    const live = (b.live || []).map((r) => { const m = r.match || {}; const top = (m.top || [])[0];
      return `<tr><td><a href="${E(r.url)}" target="_blank" rel="noopener">${E(r.symbol)}</a> <span class="muted small">${E(r.chain)}</span></td><td class="r">${U(r.mcap_usd_now)}</td><td class="r">${N(r.holders)}</td><td>${r.stage_matched ? '$' + r.stage_matched / 1000 + 'K' : '—'}</td><td class="w">${E(r.headline)}${top ? ` <span class="muted small">(features ${top.feature_dist}, curve ${top.arc_dtw})</span>` : ''}</td>
      <td class="r">${m.nearest10_rate_1m != null ? Math.round(m.nearest10_rate_1m * 100) + '%' : '—'}</td><td class="r">${m.nearest10_random_rate_1m != null ? Math.round(m.nearest10_random_rate_1m * 100) + '% (n' + m.nearest10_random_n + ')' : '—'}</td><td class="r">${m.base_rate_1m_random != null ? Math.round(m.base_rate_1m_random * 100) + '% (n' + m.base_rate_n + ')' : '—'}</td>
      <td>${r.prebuy ? '<span class="tag y">pre-buy ' + U(r.prebuy.usd) + '</span> ' : ''}${r.fresh_cluster_flag ? '<span class="tag r">fresh cluster</span> ' : ''}${r.repeat_early_buyers ? `<span class="tag">${r.repeat_early_buyers} repeat buyers</span>` : ''}</td></tr>`; }).join('');
    const bases = Object.entries(br).map(([s, x]) => `$${s / 1000}K: ${x.then_reached_1m}/${x.n_random_reached_stage} reached $1M${x.rate_1m != null ? ' (' + Math.round(x.rate_1m * 100) + '%)' : ''}, ${x.then_reached_10m} reached $10M`).join(' · ');
    const run = (b.runners || []).map((r) => `<tr><td>${E(r.symbol)}</td><td>${E(r.chain)}</td><td>${E(r.cohort)}</td><td>${D(r.first_buy_at)}</td><td class="r">${H(r.curve_h)}</td><td class="r">${N(r.unique_buyers_curve)}</td><td class="r">${U(r.median_buy_usd)}</td><td class="r">${H(r.hours_to_100k)}</td><td class="r">${H(r.hours_to_1m)}</td><td class="r">${H(r.hours_to_10m)}</td><td class="r"><b>${U(r.peak_mcap_usd)}</b></td><td>${D(r.peak_at)}</td></tr>`).join('');
    const pw = (b.protocol_wallets || []).map((w) => `${E(w.short)} (top-3 first buyer in ${w.launches_as_top3_first_buyer} launches)`).join(' · ');
    return `<div class="note small">${I('ag_birth')} Library: <b>${N(c.n_launches)}</b> Virtuals launches (${Object.entries(c.by_chain || {}).map(([k, v]) => k + ' ' + v).join(', ')}; cohorts ${Object.entries(c.by_cohort || {}).map(([k, v]) => k + ' ' + v).join(', ')}). Pre-launch curve trades captured for ${N(c.n_with_prelaunch_trades)}, full fingerprints ${N(c.n_full_fingerprint)}, wallet-nonce checks ${N(c.n_with_wallet_nonce)}, post-graduation path ${N(c.n_with_post_path)}.${b.status_building ? ' Build in progress.' : ''}</div>
      <div class="note small"><b>Base rates</b> (random cohort) ${I('ag_base')}: ${bases || '—'}. <b>Matcher check</b> ${I('ag_valid')}: ${v.n ? `n=${v.n} at $${v.stage_usd / 1000}K, AUC ${v.auc ?? '—'}, top third ${v.top_third_rate_1m != null ? Math.round(v.top_third_rate_1m * 100) + '%' : '—'} vs bottom third ${v.bottom_third_rate_1m != null ? Math.round(v.bottom_third_rate_1m * 100) + '%' : '—'} reached $1M (base ${Math.round((v.base_rate_1m || 0) * 100)}%)` : E(v.note || 'not enough data yet')}</div>
      <div class="small muted">Live Virtuals launches on the curve at $15K–$80K (last 7 days), matched at their current stage ${I('ag_match')}</div>
      <table class="tbl"><thead><tr><th>Live launch</th><th class="r">Mcap</th><th class="r">Holders</th><th>Stage</th><th>Closest past launch</th><th class="r">10 nearest → $1M</th><th class="r">nearest random → $1M</th><th class="r">Base rate ${I('ag_base')}</th><th>Flags</th></tr></thead><tbody>${live || '<tr><td colspan=9 class="empty">no live launches in the $15K–$80K band right now (or the live matcher has not run yet)</td></tr>'}</tbody></table>
      ${cases}${unres}
      <div class="small muted" style="margin-top:6px">Library launches that reached $1M+</div><table class="tbl"><thead><tr><th>Token</th><th>Chain</th><th>Cohort</th><th>First buy</th><th class="r">Curve</th><th class="r">Curve buyers</th><th class="r">Median buy</th><th class="r">→$100K</th><th class="r">→$1M</th><th class="r">→$10M</th><th class="r">Peak</th><th>Peak date</th></tr></thead><tbody>${run || '<tr><td colspan=12 class="empty">none yet</td></tr>'}</tbody></table>
      ${pw ? `<div class="small muted">Wallets that keep appearing as first buyers ${I('ag_repeat')}: ${pw}</div>` : ''}<div class="small muted">${E((b.method || {}).similarity || '')} ${E((b.method || {}).base_rate || '')}</div>`;
  }
  function protocols() {
    const P = DATA.protocols || {};
    const rows = (P.rows || []).map((r) => `<tr class="${r.thesis_weight > 1 ? 'thesis' : ''}"><td>${r.desk_rank}</td><td class="muted">${r.objective_rank}</td><td><b>${E(r.name)}</b> <span class="muted small">${E(r.symbol || '')}</span></td><td class="w small">${E(r.kind)}</td><td class="r">${U(r.mcap_usd)}</td><td class="r">${PC(r.ch7d_pct)}</td><td class="r">${PC(r.ch30d_pct)}</td><td class="r">${PC(r.ch1y_pct, 0)}</td><td class="r">${PC(r.ath_drawdown_pct, 0)}</td><td class="r">${U(r.fees_30d)}</td><td class="r">${U(r.revenue_30d)}</td><td class="r">${r.github && r.github.commits_30d != null ? r.github.commits_30d + (r.github.commits_30d_capped ? '+' : '') : '—'}</td><td class="r">${r.objective_score ?? '—'}</td><td class="r"><b>${r.desk_score ?? '—'}</b></td></tr>`).join('');
    return `<table class="tbl"><thead><tr><th>Desk #</th><th>Obj #</th><th>Protocol</th><th>What it is</th><th class="r">Mcap</th><th class="r">7d</th><th class="r">30d</th><th class="r">1y</th><th class="r">vs ATH</th><th class="r">Fees 30d</th><th class="r">Revenue 30d ${I('ag_rev')}</th><th class="r">Commits 30d</th><th class="r">Objective ${I('ag_obj')}</th><th class="r">Desk ${I('ag_thesis')}</th></tr></thead><tbody>${rows}</tbody></table><div class="note small muted">${E(P.method || '')} Fees/revenue are blank where DefiLlama has no adapter (not zero).</div>`;
  }
  function dot() {
    const d = DATA.dot || {}; const m = d.market || {}; const b = d.burns || {}; const r = d.reaction_to_first_burn;
    const fw = (x) => (x ? `${PC(x.dot_pct)} (ETH ${PC(x.eth_pct)}, excess ${PC(x.excess_pct)})` : '—');
    return `<div class="card">${I('ag_dot')} <b>${E(d.name || 'DOT')}</b> <span class="muted small">${E(d.token || '')} on Base</span><div class="small">${E(d.identity || '')}</div></div>
      <div class="kv"><div>Price $${m.price_usd ?? '—'}</div><div>Mcap ${U(m.mcap_usd)}</div><div>Liquidity ${U(m.liquidity_usd)}</div><div>Vol 24h ${U(m.volume24h_usd)}</div><div>24h ${PC((m.ch || {}).h24)}</div><div>30d ${PC(d.ch30d_pct)}</div><div>ATH close $${(d.ath_close || {}).usd ? (+d.ath_close.usd).toPrecision(3) : '—'} ${D((d.ath_close || {}).date)} (${PC((d.ath_close || {}).drawdown_pct)})</div><div>Pool since ${D(m.pair_created)} (${E(m.dex || '')} vs ${E(m.quote || '')})</div></div>
      <div class="kv small"><div><b>Staking:</b> ${E(d.staking_status || '—')}</div><div><b>Buy-burn:</b> ${E(d.buyburn_status || '—')}</div></div>
      ${r ? `<div class="note small"><b>Price reaction</b> from the ${E(r.event)} (${D(r.event_day)}): +1d ${fw(r['+1d'])} · +7d ${fw(r['+7d'])} · +30d ${fw(r['+30d'])}. <span class="muted">${E(r.method)}; one data point, not a pattern.</span></div>` : ''}
      <div class="small muted">Burn check: ${E(b.method || b.error || '')}. Dead-address balance ${N(b.dead_balance_now)} DOT.</div>
      ${(d.news || []).length ? `<div class="small">News: ${d.news.map((n) => `<a href="${E(n.link)}" target="_blank" rel="noopener">${E(n.title)}</a>`).join(' · ')}</div>` : '<div class="small muted">No DOT news in Google News (30 days).</div>'}`;
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-agt]'); if (!b) return; tab = b.dataset.agt; localStorage.setItem('agTab', tab); render(); });
  function applyFold() { const c = localStorage.getItem('agCollapsed') === '1'; const o = Q('#agOut'), b = Q('#agToggle'); if (o) o.style.display = c ? 'none' : ''; if (b) b.textContent = c ? '▸' : '▾'; }
  document.addEventListener('click', (e) => { if (!e.target.closest('#agToggle')) return; localStorage.setItem('agCollapsed', localStorage.getItem('agCollapsed') === '1' ? '0' : '1'); applyFold(); });
  function ensurePanel() {
    if (Q('#agOut')) return true;
    const after = Q('#narrPanel') || Q('#ccDesks'); if (!after) return false;
    const el = document.createElement('div'); el.className = 'panel'; el.id = 'agPanel'; el.style.flex = 'none';
    el.innerHTML = `<div class="phead"><span>AI AGENTS DESK <span class="muted small">Virtuals-weighted · launches · allocation · lookalikes</span> ${I('ag_desk')}</span><span><span id="agMeta" class="muted small"></span> <button id="agToggle" class="btn ghost mini2" title="collapse / expand">▾</button></span></div><div id="agOut" class="pbody scroll" style="max-height:46vh;overflow:auto"><div class="empty">Loading…</div></div>`;
    after.insertAdjacentElement('afterend', el); return true;
  }
  function start() { if (started) return; if (!ensurePanel()) { setTimeout(start, 500); return; } started = true; applyFold(); load(); setInterval(() => { if (document.body.dataset.view === 'command') load(); }, 5 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 300)); else setTimeout(start, 300);
})();
