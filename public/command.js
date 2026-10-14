// ASYMMETRIC·TERMINAL Command Center: one dense page fed by the backend desks (/api/desks).
// Grades and summaries are automated estimates from public data. Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const G = (g) => `<span class="grade g${esc(g || 'F')}">${esc(g || '?')}</span>`;
  const ago = (t) => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
  const rugChip = (r) => !r ? '' : `<span class="rugc r${esc(r.level)}" title="${esc((r.top || []).join(' · '))}">${r.score}${r.dump30 ? '⚠' : ''}</span>`;
  let DK = null, liveItems = [], liveFilter = 'AB', sel = null, liveShown = [];

  async function loadDesks() {
    try { DK = await api('/api/desks'); } catch (e) { Q('#ccDesks').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    renderDesks(); renderTicker(); renderMacro(); renderOptions(); renderAirdrops(); renderSleepers(); renderSlow();
    const ns = DK.nansen; const nb = Q('#ccNansen');
    if (nb) { nb.innerHTML = ns?.enabled ? `Nansen ${ix('smart')} ${ns.creditsRemaining ?? '?'} credits left · today ${ns.usedToday}/${ns.dailyCap} · month ${ns.usedThisMonth}/${ns.monthlyCap}` : ''; }
    const lb = Q('#ccLow'); if (lb) { lb.classList.toggle('hidden', !ns?.lowCredit); if (ns?.lowCredit) lb.textContent = '⚠ ' + ns.lowCredit.text; }
    const xp = Q('#ccX'); if (xp) { const on = DK.x && DK.x.enabled !== false; xp.closest('.panel').classList.toggle('hidden', !on); if (on) xp.innerHTML = (DK.x.items || []).map((i) => `<div>${ix('xsoc')} <b>${esc(i.sym)}</b> ${i.sample} posts sampled · ${i.postsPerHour ?? '—'}/h · tone ${i.toneAvg ?? '—'} · ${i.why}</div>`).join('') + `<div class="muted small">spent $${DK.x.status.spentUsd} of $${DK.x.status.monthlyCapUsd} · today ${DK.x.status.postsToday}/${DK.x.status.dailyPostCap} posts</div>`; }
    Q('#ccUpdated').textContent = 'desks ' + (DK.generatedAt ? new Date(DK.generatedAt).toLocaleTimeString() : 'warming up');
  }
  async function loadLive() {
    try { const d = await api('/api/live?limit=200'); liveItems = d.items; Q('#ccLiveMeta').textContent = `${d.universe || 0} tracked · ${d.scanned || 0} scanned · ${Object.entries(d.grades || {}).map(([g, n]) => g + ':' + n).join(' ')}`; } catch (e) { Q('#ccLive').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    renderLive();
  }
  function renderDesks() {
    const order = [['crypto', 'Crypto'], ['options', 'Stocks & Options'], ['macro', 'Macro/Fed'], ['news', 'News'], ['airdrops', 'Airdrops'], ['sleepers', 'Sleepers']];
    Q('#ccDesks').innerHTML = order.map(([k, n]) => { const d = DK[k]; return `<div class="desk"><div class="dh">${esc(n)} desk <span class="muted">${d?.updatedAt ? ago(d.updatedAt) + ' ago' : ''}</span></div><ul>${(d?.summary || ['warming up…']).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`; }).join('');
  }
  function renderTicker() {
    const it = (DK.news?.items || []).slice(0, 30);
    const s = it.map((x) => `<a href="${esc(x.link)}" target="_blank" rel="noopener" class="tk s${x.sentiment.label}"><b>${esc(x.cat)}</b> ${esc(x.title)}${x.mentions.length ? ' <i>' + x.mentions.map((m) => esc(m.sym)).join(' ') + '</i>' : ''}</a>`).join('<span class="sep">◆</span>');
    Q('#ccTicker').innerHTML = s ? `<div class="marq">${s}<span class="sep">◆</span>${s}</div>` : '<span class="muted">loading headlines…</span>';
  }
  function renderLive() {
    const f = liveFilter === 'AB' ? liveItems.filter((x) => x.grade === 'A' || x.grade === 'B') : liveFilter === 'all' ? liveItems.filter((x) => !x.veto) : liveItems.filter((x) => x.veto);
    liveShown = f.slice(0, 120); window._ixRows = liveShown;
    Q('#ccLive').innerHTML = `<table class="tbl"><thead><tr><th>Gr ${ix('grade')}</th><th>Score ${ix('asym')}</th><th>Token</th><th>Chain</th><th>Age</th><th>Mcap ${ix('fdv')}</th><th>Liq ${ix('liq')}</th><th>1h</th><th>24h</th><th>Rug ${ix('rug')}</th><th>Why ${ix('veto')}</th></tr></thead><tbody>${f.slice(0, 120).map((x) => `<tr data-k="${esc(x.key)}" data-i="${liveShown.indexOf(x)}" class="${sel === x.key ? 'sel' : ''}"><td>${G(x.grade)}</td><td>${x.score}</td><td class="tok"><b>${esc((x.symbol || '?').slice(0, 12))}</b></td><td>${chainTag ? chainTag(x.chain) : esc(x.chain)}</td><td>${x.ageH < 48 ? x.ageH.toFixed(1) + 'h' : (x.ageH / 24).toFixed(0) + 'd'}</td><td>${fUsd(x.mcap || x.fdv)}</td><td>${fUsd(x.liq)}</td><td>${fPct(x.ch1)}</td><td>${fPct(x.ch24)}</td><td>${rugChip(x.rug)}</td><td class="why small">${esc(x.veto ? 'VETO: ' + x.veto : (x.reasons || []).slice(0, 2).join(' · '))}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">nothing in this filter yet — the feed fills over the first few cycles</td></tr>'}</tbody></table>`;
  }
  function renderMacro() {
    const m = DK.macro?.snapshot; if (!m) { Q('#ccMacro').innerHTML = '<div class="empty">loading…</div>'; return; }
    const k = m.fed?.kalshi?.[0];
    Q('#ccMacro').innerHTML = `<div class="kv"><span>Fed target</span><b>${m.fed?.target?.lower}–${m.fed?.target?.upper}%</b><span>EFFR</span><b>${m.fed?.effective?.v}%</b><span>Next FOMC</span><b>${esc(m.fed?.nextMeeting?.label || '?')}</b><span>2y / 10y</span><b>${m.yields?.dgs2?.v}% / ${m.yields?.dgs10?.v}%</b><span>NFP</span><b>${m.data?.nfp?.change}K (${esc(m.data?.nfp?.refMonth)})</b><span>Unemp.</span><b>${m.data?.unrate?.v}%</b><span>CPI y/y</span><b>${m.data?.cpi?.yoy?.toFixed(1)}%</b><span>Next NFP / CPI</span><b>${esc(m.calendar?.nfp?.next)} / ${esc(m.calendar?.cpi?.next)}</b></div>${k ? `<div class="small muted" style="margin-top:4px">Kalshi: ${esc(k.title)}</div>${k.outcomes.slice(0, 3).map((x) => `<div class="bar"><span>${esc(x.outcome)}</span><i style="width:${Math.round(x.prob * 100)}%"></i><b>${Math.round(x.prob * 100)}%</b></div>`).join('')}` : ''}`;
  }
  function renderOptions() {
    const t = DK.options?.top || [];
    Q('#ccOpt').innerHTML = `<table class="tbl"><thead><tr><th>Gr</th><th>Contract</th><th>Mid</th><th>EV</th><th>P(ITM)</th><th>R:R</th></tr></thead><tbody>${t.map((p) => `<tr><td>${G(p.grade)}</td><td><b>${esc(p.underlying)}</b> ${esc(p.type)} ${esc(p.strike)} ${esc(p.expiry)}${window.fsLine ? window.fsLine(p) : ''}</td><td>${p.mid?.toFixed(2)}</td><td>${p.ev_pct != null ? p.ev_pct.toFixed(0) + '%' : '—'}</td><td>${p.p_itm_rv != null ? Math.round(p.p_itm_rv * 100) + '%' : '—'}</td><td>${p.rr_2sigma != null ? p.rr_2sigma.toFixed(1) : '—'}</td></tr>`).join('') || '<tr><td colspan=6 class="empty">no A picks</td></tr>'}</tbody></table>`;
  }
  function renderAirdrops() {
    const t = DK.airdrops?.top || [];
    Q('#ccAir').innerHTML = `<table class="tbl"><thead><tr><th>Gr</th><th>Campaign</th><th>Raised</th><th>TVL</th><th>Age</th></tr></thead><tbody>${t.map((c) => `<tr><td>${G(c.grade)}</td><td><b>${esc(c.name)}</b> <span class="muted small">${esc((c.chains || []).slice(0, 2).join(','))}</span></td><td>${fUsd(c.raised_usd)}</td><td>${fUsd(c.tvl)}</td><td>${c.age_days != null ? c.age_days + 'd' : '—'}</td></tr>`).join('')}</tbody></table>`;
  }
  function renderSleepers() {
    const t = DK.sleepers?.top || [];
    Q('#ccSleep').innerHTML = `<table class="tbl"><thead><tr><th>Gr ${ix('sleeper')}</th><th>Token</th><th>vs ATH</th><th>Acc. ${ix('accumulation')}</th><th>Looks like ${ix('lookalike')}</th></tr></thead><tbody>${t.map((x) => `<tr><td>${G(x.grade)}</td><td><b>${esc(x.symbol)}</b> <span class="muted small">${esc(x.sector || '')}</span>${(window.fsLine ? window.fsLine(x) : '')}</td><td>${x.drawdown_pct != null ? '-' + Math.abs(x.drawdown_pct).toFixed(0) + '%' : '—'}</td><td>${x.accumulation ? x.accumulation.conditions_met + '/4' + (x.accumulation.flag ? ' ●' : '') : '—'}</td><td class="small">${x.lookalikes?.[0] ? esc(x.lookalikes[0].like) + ' ' + x.lookalikes[0].similarity + '%' : '—'}</td></tr>`).join('') || '<tr><td colspan=5 class="empty">sleeper screen not generated yet</td></tr>'}</tbody></table>`;
  }
  function renderSlow() {
    const t = DK.crypto?.slowRug || [];
    Q('#ccSlow').innerHTML = t.length ? t.map((x) => `<div class="slow" data-k="${esc(x.key)}">${rugChip(x.rug)} <b>${esc(x.symbol)}</b> <span class="muted">${esc(x.chain)}</span> <span class="small">${esc((x.rug.top || [])[0] || '')}</span></div>`).join('') : '<div class="empty small">no token on slow-rug watch right now</div>';
  }
  function renderWatchCC() {
    const rows = (typeof watch !== 'undefined' ? watch : []).map(([c, a]) => { const t = (typeof tokenData !== 'undefined' && tokenData[`${c}:${a}`]) || {}; return `<tr data-c="${esc(c)}" data-a="${esc(a)}"><td class="tok"><b>${esc(t.symbol || a.slice(0, 6))}</b></td><td>${chainTag ? chainTag(c) : esc(c)}</td><td>${fPrice ? fPrice(t.priceUsd) : t.priceUsd}</td><td>${fPct(t.change?.h1)}</td><td>${fPct(t.change?.h24)}</td><td>${fUsd(t.liquidity?.usd ?? t.liquidity)}</td></tr>`; });
    Q('#ccWatch').innerHTML = `<table class="tbl"><thead><tr><th>Token</th><th>Chain</th><th>Price</th><th>1h</th><th>24h</th><th>Liq</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  async function detail(key) {
    sel = key; renderLive();
    const [chain, address] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const x = liveItems.find((i) => i.key === key) || {}; if (window.setExplainCtx) setExplainCtx(x, x.symbol);
    const box = Q('#ccDetail');
    box.innerHTML = `<div class="dt"><b>${esc(x.symbol || address.slice(0, 8))}</b> ${chainTag ? chainTag(chain) : ''} ${G(x.grade)} score ${x.score ?? '—'} ${rugChip(x.rug)} <a href="${esc(x.url || '#')}" target="_blank" rel="noopener">chart ↗</a> <button class="btn ghost mini" id="ccOpenT">open in Terminal</button></div>
      <div class="plain">${esc(x.symbol ? livePlain(x) : '')}</div>${x.components?.nansen ? `<div class="small">${ix('smart')} Nansen 24h: smart money ${fUsd(x.components.nansen.smart)}, whales ${fUsd(x.components.nansen.whale)}, to exchanges ${fUsd(x.components.nansen.exchange)}</div>` : ''}<div class="small">${esc((x.reasons || []).join(' · '))}</div>${x.flags?.length ? `<div class="small dn">${esc(x.flags.join(' · '))}</div>` : ''}
      ${x.rug ? `<div class="small"><b>Rug forecast ${x.rug.score}/100 (${esc(x.rug.level)})${x.rug.dump30 ? ' · DUMP RISK 30d' : ''}</b>: ${esc((x.rug.top || []).join(' · ') || 'no signals')}</div>` : ''}
      <div id="ccExit"></div><div id="ccChecks"><span class="spin"></span> scanning…</div>`;
    Q('#ccOpenT').onclick = () => { document.querySelector('#viewNav button[data-v=terminal]').click(); select(chain, address, null); };
    api(`/api/exitplan?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`).then((r) => { if (sel !== key || !r?.exit) return; const e = r.exit; const c = e.crashLike || (r.crash?.ok ? { text: r.crash.text, similarity: r.crash.top.similarity, compare: r.crash.top.compare, evidence: r.crash.evidence, crashOdds: r.crash.crashOdds } : null);
      Q('#ccExit').innerHTML = `<div class="exitcard l-${esc(e.level)}"><b>Exit plan</b> <span class="small">${esc(e.text)}</span>${c ? `<div class="small"><b>Crash lookalike:</b> ${esc(c.text)}${c.crashOdds != null ? ` · crash odds ${Math.round(c.crashOdds * 100)}% (25 nearest past days)` : ''}${c.evidence?.n ? ` <span class="muted">(backtest of this band: ${c.evidence.n} days / ${c.evidence.tokens} tokens, ${Math.round((c.evidence.hit_rate || 0) * 100)}% fell 70%+ within 90d vs ${Math.round((c.evidence.base_rate || 0) * 100)}% base)</span>` : ''}<div class="cmpg">${c.compare.map((m) => `<span class="${m.close ? 'up' : 'muted'}">${esc(m.label)}: ${m.now} vs ${m.them}</span>`).join(' · ')}</div></div>` : r.crash && !r.crash.ok ? `<div class="small muted">Crash lookalike: ${esc(r.crash.why)}</div>` : ''}${(e.triggers || []).length ? `<details class="small"><summary>Exit-now triggers${(e.triggered || []).length ? ` (<b class="dn">${e.triggered.length} firing</b>)` : ''}</summary><ul>${e.triggers.map((t) => `<li class="${t.on ? 'dn' : ''}">${t.on ? '⚠ ' : ''}${esc(t.t)}${t.precedent ? `<div class="muted">Happened before: ${esc(t.precedent)}</div>` : ''}</li>`).join('')}</ul></details>` : ''}<div class="small muted">${esc(e.label)}</div></div>`; }).catch(() => {});
    try {
      const s = await api(`/api/scan?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`);
      if (sel !== key) return;
      Q('#ccChecks').innerHTML = `<div class="small">Scanner risk ${s.riskScore}/100 · ${esc(s.overall)}</div>` + s.checks.filter((c) => c.level !== 'na').map((c) => `<div class="chk"><span class="lt l${esc(c.level)}"></span><b>${esc(c.title)}</b> <span class="small muted">${esc(c.detail.slice(0, 140))}</span></div>`).join('');
    } catch (e) { Q('#ccChecks').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  Q('#ccLive').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-k]'); if (tr) detail(tr.dataset.k); });
  Q('#ccSlow').addEventListener('click', (e) => { const d = e.target.closest('[data-k]'); if (d) detail(d.dataset.k); });
  Q('#ccWatch').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-c]'); if (tr) detail(tr.dataset.c + ':' + tr.dataset.a); });
  Q('#ccLiveF').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; liveFilter = b.dataset.f; Q('#ccLiveF').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderLive(); });
  let started = false;
  window.ccShow = function () {
    if (started) return; started = true;
    loadDesks(); loadLive(); renderWatchCC();
    setInterval(() => { if (document.body.dataset.view === 'command') { loadDesks(); loadLive(); renderWatchCC(); } }, 30000);
  };
  if (document.body.dataset.view === 'command') window.ccShow();
})();
