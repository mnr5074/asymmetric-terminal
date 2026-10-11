// Risk infrastructure panel (Command view): oracle manipulation, dependency risk, feed health, OTC flow — /api/riskinfra.
// Also puts a 'STALE' / 'LAGGING' badge on any panel whose feed is red/yellow in /api/feedhealth, so silence isn't mistaken for calm. Additive.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const get = async (u) => (typeof api === 'function' ? api(u) : (await fetch(u)).json());
  const usd = (x) => (x == null ? '—' : x >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + Math.round(x));
  const ago = (t) => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd'; };
  const COL = { green: '#2ecc71', yellow: '#f1c40f', red: '#e74c3c', learning: '#888', static: '#666', event: '#666', high: '#e74c3c', medium: '#f1c40f', low: '#888' };
  const dot = (s) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${COL[s] || '#888'};margin-right:4px"></span>`;
  const css = document.createElement('style');
  css.textContent = '.ri-stale{margin-left:6px;padding:0 5px;border-radius:3px;font-size:10px;font-weight:700;color:#111;cursor:help}.ri-sec{margin:4px 0 8px}.ri-sec h4{margin:2px 0;font-size:11px;letter-spacing:.04em;opacity:.85}.ri-row{font-size:11px;line-height:1.45}';
  document.head.appendChild(css);
  function mount() {
    if (document.querySelector('#riRoot')) return document.querySelector('#riRoot');
    const anchor = document.querySelector('#ccStables') || document.querySelector('#ccPatterns');
    const host = anchor ? anchor.closest('.panel') : null;
    const div = document.createElement('div'); div.className = 'panel';
    div.innerHTML = '<div class="phead"><span>RISK INFRA <span class="muted small">oracles · dependencies · feed health · OTC flow</span></span></div><div id="riRoot" class="pbody scroll small"><div class="empty">Loading…</div></div>';
    if (host && host.parentNode) host.parentNode.insertBefore(div, host.nextSibling); else (document.querySelector('#viewCommand') || document.body).appendChild(div);
    return div.querySelector('#riRoot');
  }
  function badges(panels) {
    document.querySelectorAll('.ri-stale').forEach((b) => b.remove());
    for (const [id, p] of Object.entries(panels || {})) {
      if (p.status !== 'yellow' && p.status !== 'red') continue;
      const el = document.getElementById(id); if (!el) continue;
      const panel = el.classList.contains('panel') ? el : el.closest('.panel'); const head = panel && panel.querySelector('.phead'); if (!head) continue;
      const b = document.createElement('span'); b.className = 'ri-stale'; b.style.background = COL[p.status];
      b.textContent = p.status === 'red' ? 'STALE' : 'LAGGING'; b.title = `${p.feed}: ${p.reason}`;
      (head.querySelector('span') || head).appendChild(b);
    }
  }
  async function render() {
    const box = mount(); let d;
    try { d = await get('/api/riskinfra'); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return; }
    const h = d.feedhealth || {}, o = d.oracles || {}, dp = d.dependencies || {}, x = d.otcflow || {};
    badges(h.panels);
    let s = '';
    const sm = h.summary || {}, rs = h.restarts || {};
    s += `<div class="ri-sec"><h4>FEED HEALTH</h4><div class="ri-row">${['red', 'yellow', 'green', 'learning'].map((k) => `${dot(k)}${sm[k] || 0} ${k}`).join(' &nbsp; ')}</div>`;
    { const sp = rs.supervisor, lu = rs.lastUnplanned, pf = sp && sp.profile;
      s += `<div class="ri-row">${dot(rs.status)}<b>Terminal uptime</b> ${ago(rs.bootAt)} · unplanned restarts ${rs.unplannedLast1h ?? 0}/1h, ${rs.unplannedLast24h ?? 0}/24h · planned ${rs.plannedLast24h ?? 0}/24h${lu ? ` · last unplanned ${ago(lu.t)} ago (${E(lu.reason)}, ${Math.round(lu.downtimeS)}s down)` : ''} · ${sp ? `supervisor ${rs.watchdogAlive ? 'alive' : '<b>not running</b>'}${pf ? `, probe ${pf.probeMs / 1000}s / ${pf.fails} fails` : ''}${sp.mode === 'volatile' ? ` <b>volatile mode</b> <span class="muted">${E(sp.volatileReason || '')}</span>` : ''}` : '<b>supervisor not running</b>'}</div>`; }
    s += `<div class="ri-row">${dot(rs.status)}server up ${ago(rs.bootAt)} · watchdog restarts ${rs.watchdogRestartsLast1h ?? '—'}/1h, ${rs.watchdogRestartsLast24h ?? '—'}/24h · watchdog ${rs.watchdogAlive ? 'alive' : '<b>not running</b>'}${rs.status !== 'green' ? ' · ' + E(rs.reason) : ''}</div>`;
    s += (h.problems || []).slice(0, 10).map((f) => `<div class="ri-row">${dot(f.status)}<b>${E(f.file || f.label || f.id)}</b> <span class="muted">${E(f.reason)}</span></div>`).join('');
    s += '</div>';
    if (o.error) s += `<div class="ri-sec"><h4>ORACLES</h4><div class="muted">${E(o.error)}</div></div>`;
    else {
      const c = o.coverage || {};
      s += `<div class="ri-sec"><h4>ORACLE MANIPULATION <span class="muted">${ago(o.generatedAt)} ago · Chainlink ${c.chainlink} · Pyth ${c.pyth} · RedStone ${c.redstone} · DEX ${c.dexAssets}</span></h4>`;
      s += `<div class="ri-row">${o.summary ? Object.entries(o.summary.byType || {}).map(([k, v]) => `${E(k)} ${v}`).join(' · ') || 'no flags' : ''}</div>`;
      s += (o.flags || []).filter((f) => f.severity !== 'low').slice(0, 10).map((f) => `<div class="ri-row">${dot(f.severity)}<b>${E(f.asset)}</b> ${E(f.type)} <span class="muted">${E(f.detail)}</span></div>`).join('');
      s += '</div>';
    }
    if (dp.error) s += `<div class="ri-sec"><h4>DEPENDENCIES</h4><div class="muted">${E(dp.error)}</div></div>`;
    else {
      const su = dp.summary || {};
      s += `<div class="ri-sec"><h4>DEPENDENCY RISK <span class="muted">${ago(dp.generatedAt)} ago · ${su.nodes} nodes · ${su.red || 0} red / ${su.yellow || 0} yellow stressed · ${su.flaggedDependents || 0} dependents flagged</span></h4>`;
      s += (dp.stressed || []).slice(0, 10).map((n) => `<div class="ri-row">${dot(n.status)}<b>${E(n.name)}</b> <span class="muted">${E(n.type)} · ${E((n.signals[0] || {}).text || '')}</span></div>`).join('');
      const l = Object.entries(dp.lst || {}).map(([k, v]) => `${E(k)} ${v.premiumPct == null ? '—' : (v.premiumPct >= 0 ? '+' : '') + v.premiumPct.toFixed(2) + '%'}`).join(' · ');
      if (l) s += `<div class="ri-row muted">LST/LRT vs NAV: ${l}</div>`;
      s += (dp.dependents || []).filter((q) => q.effective !== 'green').slice(0, 6).map((q) => `<div class="ri-row">↳ ${dot(q.effective)}${E(q.name)} <span class="muted">via ${E((q.via[0] || {}).path || '')}</span></div>`).join('');
      s += '</div>';
    }
    if (x.error) s += `<div class="ri-sec"><h4>OTC FLOW</h4><div class="muted">${E(x.error)}</div></div>`;
    else {
      const t = x.thisRun || {};
      s += `<div class="ri-sec"><h4>DARK POOL / OTC FLOW <span class="muted">${ago(x.generatedAt)} ago · ${(x.window || {}).approxHoursTracked}h tracked tokens · ${(x.window || {}).approxHoursMM}h MM wallets · ${t.events || 0} events, ${usd(t.usdTotal)}</span></h4>`;
      s += (x.flags || []).slice(0, 10).map((e) => `<div class="ri-row">${E(ago(e.t))} <b>${E(e.sym)}</b> ${usd(e.usd)} ${E(e.kinds.join('+'))} <span class="muted">${E(e.fromName || e.fromKind)} → ${E(e.toName || e.toKind)}${e.round && e.round.length ? ' · round' : ''}${e.fanout ? ' · fan-out x' + e.fanout : ''}${e.outcome ? ' · ' + E(e.outcome) + (e.ret60Pct != null ? ' ' + e.ret60Pct + '%/60m' : '') : ''}</span></div>`).join('') || '<div class="muted">no flagged transfers in window</div>';
      s += '</div>';
    }
    s += '<div class="muted">APIs: /api/oracles · /api/dependencies · /api/feedhealth · /api/otcflow · free public data, not financial advice</div>';
    box.innerHTML = s;
  }
  // Command-view banner: unplanned terminal restart in the last hour (/api/health/detail; planned restarts never show)
  async function banner() {
    let d; try { d = await get('/api/health/detail'); } catch { return; }
    const v = document.querySelector('#viewCommand'); if (!v) return;
    let b = document.querySelector('#upBanner');
    if (!d || !d.banner) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'upBanner'; b.style.cssText = 'background:#5c1d14;color:#ffd7cf;border:1px solid #e74c3c;padding:5px 10px;margin:4px;border-radius:4px;font-size:12px'; v.insertBefore(b, v.firstChild); }
    b.innerHTML = `⚠ ${E(d.banner.text)} <span style="opacity:.75">· up again ${ago(d.banner.upAt)} ago · banner clears 1h after the restart</span>`;
  }
  window.addEventListener('load', () => { render(); setInterval(render, 60e3); banner(); setInterval(banner, 30e3); });
})();
