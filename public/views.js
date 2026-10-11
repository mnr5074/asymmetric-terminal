// ASYMMETRIC·TERMINAL: Options screener + Airdrop ranker / assist views.
// All grades are model ESTIMATES, not advice. The airdrop assist never asks for or stores keys: every transaction is
// built in the page, shown to you, and signed (or rejected) inside YOUR wallet (Phantom / Rabby). No automated signing.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const pct = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const num = (x, d = 2) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString() : (+x).toFixed(d));
  const px = (x) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));
  const gchip = (g) => `<span class="grade g${esc(g)}">${esc(g)}</span>`;
  const GR = { A: 4, B: 3, C: 2, D: 1, F: 0 };

  // ---------------- view switching ----------------
  function show(v) {
    document.body.dataset.view = v;
    document.querySelectorAll('#viewNav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    if (v === 'options') loadOptions(); if (v === 'airdrops') loadAirdrops();
    const u = new URL(location.href); v === 'terminal' ? u.searchParams.delete('view') : u.searchParams.set('view', v); history.replaceState(null, '', u);
  }
  Q('#viewNav').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) show(b.dataset.v); });

  // ================= OPTIONS =================
  let OPT = null;
  async function loadOptions(force) {
    const box = Q('#optOut');
    if (OPT && !force) return renderOptions();
    box.innerHTML = '<div class="empty"><span class="spin"></span> loading option chains (Derive + CBOE delayed)…</div>';
    try { OPT = await api('/api/options'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const unds = [...new Set(OPT.picks.map((p) => p.underlying))].sort();
    Q('#optUnd').innerHTML = '<option value="">All underlyings</option>' + unds.map((u) => `<option>${esc(u)}</option>`).join('');
    renderOptions();
  }
  ['#optVenue', '#optUnd', '#optType', '#optGrade', '#optSort', '#optBest', '#optUnusual', '#optEarn', '#optMaxLoss', '#optLive', '#optOne'].forEach((s) => Q(s).addEventListener('change', renderOptions));
  Q('#optRefresh').addEventListener('click', () => loadOptions(true));
  function renderOptions() {
    const d = OPT; if (!d) return;
    const venue = Q('#optVenue').value, und = Q('#optUnd').value, typ = Q('#optType').value, minG = GR[Q('#optGrade').value] ?? 0, sort = Q('#optSort').value;
    const maxLoss = +Q('#optMaxLoss').value || Infinity;
    let rows = d.picks.filter((p) => (!venue || (venue === 'derive' ? p.venue === 'Derive' : p.venue !== 'Derive')) && (!und || p.underlying === und) && (!typ || p.type === typ)
      && GR[p.grade] >= minG && (!Q('#optBest').checked || p.best_expiry) && (!Q('#optUnusual').checked || p.unusual) && (!Q('#optEarn').checked || p.earnings_before_expiry)
      && (!Q('#optLive').checked || p.live_quote) && p.max_loss <= maxLoss);
    const key = { score: (p) => GR[p.grade] * 1000 + p.score, ev: (p) => p.ev_pct, touch: (p) => p.p_touch3x_rv, itm: (p) => p.p_itm_rv, rr: (p) => p.rr_2sigma, cheap: (p) => -(p.iv_rv ?? 9), volo: (p) => p.vol_oi ?? -1 }[sort];
    rows.sort((a, b) => key(b) - key(a));
    if (Q('#optOne').checked && !und) { const seen = new Set(); rows = rows.filter((p) => !seen.has(p.underlying) && seen.add(p.underlying)); }
    const shown = rows.slice(0, 250);
    const u = d.universe;
    let h = `<div class="kv"><div><span class="muted small">Derive options listed / priced</span><b>${u.derive_listed} / ${u.derive_priced}</b></div><div><span class="muted small">Stock/ETF chains (CBOE delayed)</span><b>${u.stock_underlyings.length} · ${u.stock_contracts.toLocaleString()} contracts</b></div><div><span class="muted small">Screened long options</span><b>${u.eligible.toLocaleString()}</b><span class="muted small">of ${u.analyzed.toLocaleString()} analyzed</span></div><div><span class="muted small">Grades</span><b>${['A', 'B', 'C', 'D', 'F'].map((g) => `${g} ${d.grades[g] || 0}`).join(' · ')}</b></div><div><span class="muted small">Data age</span><b>${Math.round((d.ageSec || 0) / 60)} min</b><span class="muted small">${d.refreshing ? 'refreshing…' : new Date(d.generatedAt).toLocaleString()}</span></div></div>
    <div class="muted small pad">Showing ${shown.length} of ${rows.length} matching (top 20 per underlying stored). <span class="dn">Model estimates, not advice: long options usually expire worthless.</span> Click a row for details.</div>
    <div class="tablewrap"><table class="tbl opt"><thead><tr><th>Gr</th><th>Contract</th><th class="r">Premium<br><span class="muted">max loss</span></th><th class="r">Fair (RV)<br><span class="muted">prem vs fair</span></th><th class="r">IV / RV</th><th class="r">Breakeven<br><span class="muted">move</span></th><th class="r">±1σ / ±2σ by expiry</th><th class="r">Target 3x / 5x / 10x</th><th class="r">Exit by<br><span class="muted">needs (3x)</span></th><th class="r">P(ITM)<br><span class="muted">IV / RV</span></th><th class="r">P(touch 3x)<br><span class="muted">IV / RV</span></th><th class="r">EV</th><th class="r">R:R 2σ</th><th class="r">θ/day</th><th class="r">Vol/OI</th><th>Flags</th></tr></thead><tbody>
    ${shown.map((p, i) => `<tr data-i="${i}" class="optrow"><td>${gchip(p.grade)}<div class="muted small">${p.score}</div></td>
      <td><b>${esc(p.underlying)}</b> ${p.type === 'call' ? '<span class="up">C</span>' : '<span class="dn">P</span>'} ${px(p.strike)} <span class="muted small">${esc(p.expiry)} · ${p.days}d</span><div class="muted small">${esc(p.venue)} · spot ${px(p.spot)}${p.best_expiry ? ' · <span class="chip g">best expiry</span>' : ''}</div></td>
      <td class="r">${px(p.mid)}<div class="muted small">${fUsd(p.max_loss)}</div></td>
      <td class="r">${px(p.fair_rv)}<div class="small ${p.prem_vs_fair < 0 ? 'up' : 'dn'}">${p.prem_vs_fair != null ? (p.prem_vs_fair * 100).toFixed(0) + '%' : '—'}</div></td>
      <td class="r">${pct(p.iv)} / ${pct(p.rv30)}<div class="small ${p.iv_rv < 1 ? 'up' : 'dn'}">${num(p.iv_rv)}x</div></td>
      <td class="r">${px(p.breakeven)}<div class="muted small">${p.move_to_be_pct >= 0 ? '+' : ''}${p.move_to_be_pct.toFixed(1)}%</div></td>
      <td class="r small">${px(p.sigma1[0])}–${px(p.sigma1[1])}<div class="muted">${px(p.sigma2[0])}–${px(p.sigma2[1])}</div></td>
      <td class="r small">${px(p.targets['3x'])} / ${px(p.targets['5x'])}<div class="muted">${px(p.targets['10x'])}</div></td>
      <td class="r small">${esc(p.exit_by)}<div class="muted">${px(p.need_for_3x_at_exit)}</div></td>
      <td class="r">${pct(p.p_itm_iv)} / ${pct(p.p_itm_rv)}</td>
      <td class="r">${pct(p.p_touch3x_iv)} / ${pct(p.p_touch3x_rv)}</td>
      <td class="r ${p.ev >= 0 ? 'up' : 'dn'}">${p.ev_pct.toFixed(0)}%<div class="muted small">${fUsd(p.ev)}</div></td>
      <td class="r">${num(p.rr_2sigma, 1)}x</td>
      <td class="r dn small">${fUsd(p.theta_day)}<div class="muted">${p.theta_pct_day.toFixed(1)}%</div></td>
      <td class="r small">${p.vol_oi != null ? num(p.vol_oi) : '—'}<div class="muted">${p.volume ?? '—'}/${num(p.oi, 0)}</div></td>
      <td>${p.unusual ? '<span class="chip a">unusual vol</span>' : ''}${p.earnings_before_expiry ? `<span class="chip a" title="IV crush risk after the report">earnings ${esc(p.earnings)}</span>` : ''}${!p.live_quote ? '<span class="chip" title="no live bid/ask">mark only</span>' : ''}${(p.caps || []).map((c) => `<span class="chip" title="${esc(c)}">cap</span>`).join('')}</td></tr>`).join('')}</tbody></table></div>`;
    if (d.unusual?.length) h += `<div class="grp pad">Unusual volume vs open interest (latest session, CBOE delayed)</div><div class="tablewrap"><table class="tbl"><thead><tr><th>Contract</th><th class="r">Volume</th><th class="r">OI</th><th class="r">Vol/OI</th><th class="r">Premium</th><th class="r">IV</th><th>Grade</th></tr></thead><tbody>${d.unusual.slice(0, 25).map((p) => `<tr><td><b>${esc(p.underlying)}</b> ${p.type} ${px(p.strike)} ${esc(p.expiry)}</td><td class="r">${p.volume.toLocaleString()}</td><td class="r">${num(p.oi, 0)}</td><td class="r">${num(p.vol_oi)}</td><td class="r">${px(p.mid)}</td><td class="r">${pct(p.iv)}</td><td>${gchip(p.grade)}</td></tr>`).join('')}</tbody></table></div>`;
    h += `<details class="ev pad" open><summary>Grade formula & data notes</summary><div class="small">${esc(d.grade_formula)}</div><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul><div class="small muted">Realized-vol sources: ${Object.entries(d.rv_sources || {}).map(([k, v]) => `${esc(k)}=${esc(v || 'none')}`).join(', ')}${u.stock_failed?.length ? ' · failed chains: ' + esc(u.stock_failed.join('; ')) : ''}</div></details>`;
    Q('#optOut').innerHTML = h;
    Q('#optOut').querySelectorAll('tr.optrow').forEach((tr) => tr.addEventListener('click', () => {
      const p = shown[+tr.dataset.i]; const nx = tr.nextElementSibling;
      if (nx && nx.classList.contains('optdet')) { nx.remove(); return; }
      const det = document.createElement('tr'); det.className = 'optdet';
      det.innerHTML = `<td colspan="16" class="small">Score parts: ${Object.entries(p.parts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} (weights 30/25/20/15/10)${p.caps?.length ? ' · caps: ' + esc(p.caps.join('; ')) : ''}<br>
        Fair value IV ${px(p.fair_iv)} · bid ${px(p.bid)} / ask ${px(p.ask)}${p.spread_pct != null ? ` (spread ${(p.spread_pct * 100).toFixed(1)}%)` : ''} · multiplier ${p.mult} · ${esc(p.id)}<br>
        To make 3x you need ${esc(p.underlying)} at ${px(p.targets['3x'])} by expiry ${esc(p.expiry)} (${((p.targets['3x'] / p.spot - 1) * 100).toFixed(1)}%), or about ${px(p.need_for_3x_at_exit)} by the suggested exit ${esc(p.exit_by)} with IV unchanged. Theta costs ${fUsd(-p.theta_day)} per day now.</td>`;
      tr.after(det);
    }));
  }

  // ================= AIRDROPS =================
  let AD = null;
  const LSK = 'st.airdrop.track.v1';
  const track = () => JSON.parse(localStorage.getItem(LSK) || '{}');
  const saveTrack = (t) => localStorage.setItem(LSK, JSON.stringify(t));
  async function loadAirdrops(force) {
    if (AD && !force) return renderAirdrops();
    Q('#adOut').innerHTML = '<div class="empty"><span class="spin"></span> loading campaigns (airdrops.io, DefiLlama)…</div>';
    try { AD = await api('/api/airdrops'); } catch (e) { Q('#adOut').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    renderAirdrops();
  }
  ['#adGrade', '#adKind', '#adHideLate'].forEach((s) => Q(s).addEventListener('change', renderAirdrops));
  Q('#adSearch').addEventListener('input', renderAirdrops);
  const safeUrl = (u) => (u && /^https:\/\//i.test(u) ? u : null);
  function renderAirdrops() {
    const d = AD; if (!d) return;
    const minG = GR[Q('#adGrade').value] ?? 0, kind = Q('#adKind').value, q = Q('#adSearch').value.trim().toLowerCase(), hide = Q('#adHideLate').checked;
    const T = track();
    const rows = d.campaigns.filter((c) => GR[c.grade] >= minG && (!kind || c.kind === kind || (c.lists || []).includes(kind)) && (!q || c.name.toLowerCase().includes(q)) && (!hide || !c.claim_live));
    const gc = {}; d.campaigns.forEach((c) => (gc[c.grade] = (gc[c.grade] || 0) + 1));
    let h = `<div class="kv"><div><span class="muted small">Campaigns ranked</span><b>${d.count}</b></div><div><span class="muted small">Grades</span><b>${['A', 'B', 'C', 'D', 'F'].map((g) => `${g} ${gc[g] || 0}`).join(' · ')}</b></div><div><span class="muted small">Tracking</span><b>${Object.keys(T).length}</b></div><div><span class="muted small">Updated</span><b>${new Date(d.generatedAt).toLocaleString()}</b><span class="muted small">${d.refreshing ? 'refreshing…' : ''}</span></div></div>
    <div class="tablewrap"><table class="tbl ad"><thead><tr><th>Gr</th><th>Campaign</th><th>Status</th><th>Why</th><th class="r">Raised</th><th class="r">TVL</th><th class="r">Heat</th><th class="r">Age</th><th>Links</th><th></th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td>${gchip(c.grade)}<div class="muted small">${c.score}</div></td>
      <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.category || '')}${c.chains?.length ? ' · ' + esc(c.chains.slice(0, 3).join(', ')) : ''}</div></td>
      <td class="small">${esc(c.status || '')}<div class="muted">${esc(c.kind)}${c.kyc ? ' · KYC' : ''}</div></td>
      <td class="small why">${c.reasons.map((r) => esc(r)).join(' · ')}${c.actions ? `<div class="muted">tasks: ${esc(c.actions)}</div>` : ''}</td>
      <td class="r">${c.raised_usd ? fUsd(c.raised_usd) : '—'}<div class="muted small" title="${esc((c.backers || []).join(', '))}">${esc((c.top_backers || []).slice(0, 2).join(', '))}</div></td>
      <td class="r">${c.tvl ? fUsd(c.tvl) : '—'}</td><td class="r">${c.heat ?? '—'}</td><td class="r">${c.age_days}d</td>
      <td class="small">${safeUrl(c.official_url) ? `<a href="${esc(c.official_url)}" target="_blank" rel="noopener noreferrer">official ↗</a> ` : ''}${safeUrl(c.page) ? `<a href="${esc(c.page)}" target="_blank" rel="noopener noreferrer">guide ↗</a> ` : ''}${safeUrl(c.defillama) ? `<a href="${esc(c.defillama)}" target="_blank" rel="noopener noreferrer">llama ↗</a>` : ''}</td>
      <td><button class="btn mini2 ${T[c.key] ? 'on' : ''}" data-track="${esc(c.key)}">${T[c.key] ? 'tracking' : '+ track'}</button></td></tr>`).join('')}</tbody></table></div>
    <details class="ev pad"><summary>Grade formula & limits</summary><div class="small">${esc(d.grade_formula)}</div><ul>${d.limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><div class="small muted">sources: ${Object.entries(d.sources).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</div></details>`;
    Q('#adOut').innerHTML = h;
    Q('#adOut').querySelectorAll('button[data-track]').forEach((b) => b.addEventListener('click', () => toggleTrack(b.dataset.track)));
    renderAssist();
  }
  function defaultTasks(c) {
    const t = [{ t: 'Verify the official site, X account and docs (links can be spoofed; never trust DM links)', done: false },
      { t: 'Use a dedicated wallet with only the funds this campaign needs (one wallet; no multi-wallet farming)', done: false }];
    for (const a of (c.actions || '').split(/,| and /).map((s) => s.trim()).filter(Boolean)) t.push({ t: a, done: false, onchain: /deposit|trade|swap|bridge|stake|lend|provide|mint|buy|transact/i.test(a) });
    t.push({ t: 'Re-check points / eligibility page weekly', done: false });
    return t;
  }
  function toggleTrack(k) {
    const T = track();
    if (T[k]) { if (!confirm('Stop tracking and delete this checklist?')) return; delete T[k]; }
    else { const c = AD.campaigns.find((x) => x.key === k); T[k] = { name: c.name, official: c.official_url, page: c.page, added: Date.now(), due: '', remind: '', tasks: defaultTasks(c), txs: [] }; }
    saveTrack(T); renderAirdrops();
  }
  function ics(name, date, note) {
    const d = date.replace(/-/g, ''); const uid = Math.random().toString(36).slice(2);
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//asymmetric-terminal//airdrop assist//EN', 'BEGIN:VEVENT', `UID:${uid}@asymmetric-terminal`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:Airdrop task: ${name}`, `DESCRIPTION:${note.replace(/\n/g, ' ')}`, 'BEGIN:VALARM', 'TRIGGER:-PT9H', 'ACTION:DISPLAY', `DESCRIPTION:${name}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); a.download = `${name.replace(/\W+/g, '-')}-${d}.ics`; a.click();
  }
  function renderAssist() {
    const T = track(); const keys = Object.keys(T);
    if (!keys.length) { Q('#assistOut').innerHTML = '<div class="empty small">Track a campaign to get a checklist with progress, due and reminder dates, and prepared on-chain steps you sign in your own wallet.</div>'; return; }
    const today = new Date().toISOString().slice(0, 10);
    Q('#assistOut').innerHTML = keys.map((k) => { const x = T[k]; const done = x.tasks.filter((t) => t.done).length; const late = x.due && x.due < today && done < x.tasks.length;
      return `<div class="assist" data-k="${esc(k)}"><div class="ahead"><b>${esc(x.name)}</b> <span class="muted small">${done}/${x.tasks.length} done</span><div class="bar"><i style="width:${Math.round(done / x.tasks.length * 100)}%"></i></div>
        ${safeUrl(x.official) ? `<a class="small" href="${esc(x.official)}" target="_blank" rel="noopener noreferrer">official ↗</a>` : ''}</div>
        <div class="adates small"><label>due <input type="date" data-f="due" value="${esc(x.due)}"></label><label>remind <input type="date" data-f="remind" value="${esc(x.remind)}"></label><button class="btn mini2" data-ics="1">.ics reminder</button>${late ? '<span class="chip r">overdue</span>' : ''}${x.remind && x.remind <= today ? '<span class="chip a">reminder due</span>' : ''}</div>
        <ul class="tasks">${x.tasks.map((t, i) => `<li><label><input type="checkbox" data-task="${i}" ${t.done ? 'checked' : ''}> ${esc(t.t)}</label>${t.onchain ? ` <button class="btn mini2" data-prep="${i}" title="Prepare a transaction to sign in your wallet">prepare tx</button>` : ''}</li>`).join('')}</ul>
        <div class="addtask"><input placeholder="add a task" data-new="1"><button class="btn mini2" data-add="1">add</button></div>
        ${x.txs.length ? `<div class="small muted">signed by you: ${x.txs.map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.label)}</a>`).join(' · ')}</div>` : ''}</div>`; }).join('');
    Q('#assistOut').querySelectorAll('.assist').forEach((el) => {
      const k = el.dataset.k;
      const up = (fn) => { const T2 = track(); fn(T2[k]); saveTrack(T2); renderAssist(); };
      el.querySelectorAll('input[data-task]').forEach((cb) => cb.addEventListener('change', () => up((x) => (x.tasks[+cb.dataset.task].done = cb.checked))));
      el.querySelectorAll('input[data-f]').forEach((inp) => inp.addEventListener('change', () => up((x) => (x[inp.dataset.f] = inp.value))));
      el.querySelector('[data-add]').addEventListener('click', () => { const v = el.querySelector('[data-new]').value.trim(); if (v) up((x) => x.tasks.push({ t: v, done: false, onchain: /deposit|trade|swap|bridge|stake|transfer|mint/i.test(v) })); });
      el.querySelector('[data-ics]').addEventListener('click', () => { const x = track()[k]; const d = x.remind || x.due; if (!d) return alert('Set a due or reminder date first.'); ics(x.name, d, x.tasks.filter((t) => !t.done).map((t) => '- ' + t.t).join('\n')); });
      el.querySelectorAll('[data-prep]').forEach((b) => b.addEventListener('click', () => openPrep(k, +b.dataset.prep)));
    });
    // in-page reminders (only while the page is open)
    const due = keys.filter((k) => T[k].remind && T[k].remind <= today);
    if (due.length && 'Notification' in window && Notification.permission === 'granted' && !sessionStorage.getItem('adnotified')) { new Notification('Airdrop reminders', { body: due.map((k) => T[k].name).join(', ') }); sessionStorage.setItem('adnotified', '1'); }
  }
  Q('#adNotify').addEventListener('click', () => 'Notification' in window && Notification.requestPermission().then(renderAssist));

  // ---------------- wallets (your wallet signs; this page never sees keys) ----------------
  const W = { sol: null, evm: null, evmProv: null, evmName: '' };
  const evmProviders = [];
  window.addEventListener('eip6963:announceProvider', (e) => { if (!evmProviders.find((p) => p.info.uuid === e.detail.info.uuid)) evmProviders.push(e.detail); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  function walletBar() {
    Q('#wPhantom').textContent = W.sol ? 'Phantom ' + short(W.sol) : 'Connect Phantom (Solana)';
    Q('#wRabby').textContent = W.evm ? `${W.evmName} ${short(W.evm)}` : 'Connect Rabby (EVM)';
    Q('#wPhantom').classList.toggle('on', !!W.sol); Q('#wRabby').classList.toggle('on', !!W.evm);
  }
  function phantom() { return window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null; }
  Q('#wPhantom').addEventListener('click', async () => {
    const p = phantom();
    if (!p) return alert('Phantom not detected. Install the Phantom extension (phantom.com) and reload. This page uses Phantom\'s injected Solana provider (Wallet Standard compatible); it never asks for your seed phrase.');
    if (W.sol) { await p.disconnect?.(); W.sol = null; return walletBar(); }
    try { const r = await p.connect(); W.sol = r.publicKey.toString(); walletBar(); } catch (e) { alert('Phantom: ' + e.message); }
  });
  Q('#wRabby').addEventListener('click', async () => {
    if (W.evm) { W.evm = null; W.evmProv = null; return walletBar(); }
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await new Promise((r) => setTimeout(r, 150));
    const pick = evmProviders.find((p) => /rabby/i.test(p.info.rdns + p.info.name)) || evmProviders[0];
    const prov = pick?.provider || window.ethereum;
    if (!prov) return alert('No EVM wallet detected. Install Rabby (rabby.io) and reload. Detection uses EIP-6963, falling back to window.ethereum (EIP-1193).');
    try { const acc = await prov.request({ method: 'eth_requestAccounts' }); W.evm = acc[0]; W.evmProv = prov; W.evmName = pick?.info?.name || (prov.isRabby ? 'Rabby' : 'EVM wallet'); walletBar(); } catch (e) { alert('Wallet: ' + e.message); }
  });

  // ---------------- prepared transactions ----------------
  const EVMCH = { ethereum: [1, 'https://etherscan.io/tx/'], base: [8453, 'https://basescan.org/tx/'], arbitrum: [42161, 'https://arbiscan.io/tx/'], optimism: [10, 'https://optimistic.etherscan.io/tx/'], bsc: [56, 'https://bscscan.com/tx/'], polygon: [137, 'https://polygonscan.com/tx/'], avalanche: [43114, 'https://snowtrace.io/tx/'], blast: [81457, 'https://blastscan.io/tx/'] };
  let PREP = null;
  function openPrep(k, i) {
    const x = track()[k]; PREP = { k, i };
    Q('#prepTitle').textContent = `${x.name}: ${x.tasks[i].t}`;
    Q('#prepPreview').innerHTML = ''; Q('#prepModal').classList.remove('hidden');
  }
  Q('#prepModal').addEventListener('click', (e) => { if (e.target.id === 'prepModal' || e.target.dataset.close) Q('#prepModal').classList.add('hidden'); });
  Q('#prepAction').addEventListener('change', () => { Q('#prepTxFields').classList.toggle('hidden', Q('#prepAction').value === 'sign'); });
  function buildPrep() {
    const chain = Q('#prepChain').value, action = Q('#prepAction').value, to = Q('#prepTo').value.trim(), amt = Q('#prepAmt').value.trim(), msg = Q('#prepMsg').value.trim();
    const sol = chain === 'solana';
    if (action === 'sign') return { chain, action, msg: msg || `I am the owner of this wallet. ${new Date().toISOString()}` };
    if (sol ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) : !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Paste the destination address exactly as shown on the official site.');
    if (!(+amt > 0)) throw new Error('Enter an amount.');
    return { chain, action, to, amt: +amt };
  }
  Q('#prepBuild').addEventListener('click', () => {
    try {
      const p = buildPrep(); const sol = p.chain === 'solana';
      const from = sol ? W.sol : W.evm;
      Q('#prepPreview').innerHTML = `<div class="small"><b>You are about to ${p.action === 'sign' ? 'sign a message (no funds move)' : `send ${p.amt} ${sol ? 'SOL' : p.chain === 'bsc' ? 'BNB' : p.chain === 'polygon' ? 'POL' : p.chain === 'avalanche' ? 'AVAX' : 'ETH'}`}</b> on ${esc(p.chain)}<br>from: ${esc(from || '(connect wallet)')}<br>${p.to ? `to: <code>${esc(p.to)}</code><br>` : ''}${p.msg ? `message: <code>${esc(p.msg)}</code><br>` : ''}
        Your wallet will show the same details. Compare the address with the official docs. Nothing is sent unless you approve it in ${sol ? 'Phantom' : esc(W.evmName || 'Rabby')}.</div><button class="btn" id="prepSign">Open in wallet to review & sign</button>`;
      Q('#prepSign').addEventListener('click', () => signPrep(p));
    } catch (e) { Q('#prepPreview').innerHTML = `<div class="dn small">${esc(e.message)}</div>`; }
  });
  async function signPrep(p) {
    const sol = p.chain === 'solana';
    try {
      let label, url;
      if (sol) {
        const ph = phantom(); if (!ph || !W.sol) throw new Error('Connect Phantom first.');
        if (p.action === 'sign') { const r = await ph.signMessage(new TextEncoder().encode(p.msg), 'utf8'); label = 'signed message'; url = '#'; void r; }
        else {
          const { blockhash } = await api('/api/sol/blockhash');
          const message = solTransferMessage(W.sol, p.to, Math.round(p.amt * 1e9), blockhash);
          const r = await ph.request({ method: 'signAndSendTransaction', params: { message: b58enc(message) } });
          label = 'SOL transfer ' + short(r.signature); url = 'https://solscan.io/tx/' + r.signature;
        }
      } else {
        if (!W.evmProv || !W.evm) throw new Error('Connect Rabby first.');
        const [cid, ex] = EVMCH[p.chain];
        if (p.action === 'sign') { await W.evmProv.request({ method: 'personal_sign', params: ['0x' + [...new TextEncoder().encode(p.msg)].map((b) => b.toString(16).padStart(2, '0')).join(''), W.evm] }); label = 'signed message'; url = '#'; }
        else {
          await W.evmProv.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + cid.toString(16) }] });
          const wei = BigInt(Math.round(p.amt * 1e9)) * 10n ** 9n;
          const h = await W.evmProv.request({ method: 'eth_sendTransaction', params: [{ from: W.evm, to: p.to, value: '0x' + wei.toString(16) }] });
          label = `${p.chain} tx ${short(h)}`; url = ex + h;
        }
      }
      const T = track(); const x = T[PREP.k]; x.tasks[PREP.i].done = true; x.txs.push({ label, url, at: Date.now() }); saveTrack(T);
      Q('#prepModal').classList.add('hidden'); renderAssist();
    } catch (e) { Q('#prepPreview').insertAdjacentHTML('beforeend', `<div class="dn small">${esc(e.message || String(e))} (nothing was sent)</div>`); }
  }
  // --- minimal Solana legacy message for a System Program transfer (user signs in Phantom) ---
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58dec(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c === '1') out.unshift(0); else break; } return new Uint8Array(out); }
  function b58enc(b) { let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; }
  function pad32(b) { if (b.length > 32) throw new Error('bad key'); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; }
  function solTransferMessage(from, to, lamports, blockhash) {
    if (from === to) throw new Error('Destination equals your wallet.');
    const keys = [pad32(b58dec(from)), pad32(b58dec(to)), new Uint8Array(32)];
    const data = new Uint8Array(12); const dv = new DataView(data.buffer); dv.setUint32(0, 2, true); dv.setBigUint64(4, BigInt(lamports), true);
    const parts = [Uint8Array.of(1, 0, 1, 3), ...keys, pad32(b58dec(blockhash)), Uint8Array.of(1, 2, 2, 0, 1, 12), data];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  window.__solTransferMessage = solTransferMessage; window.__b58 = { b58enc, b58dec };

  const v = new URLSearchParams(location.search).get('view'); if (v) show(v);
})();
