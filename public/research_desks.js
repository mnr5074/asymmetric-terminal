// Developer Activity desk (/api/devactivity) + Insider-privilege scan & Velvet exposé (/api/insider, /api/insider/velvet). Command view.
// Read-only research panels. Not financial advice.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const get = (u) => (typeof api === 'function' ? api(u) : fetch(u).then((r) => r.json()));
  const P = (x) => (x == null ? '—' : (+x).toFixed(3));
  const md = (t) => E(t || '').replace(/^### (.*)$/gm, '<b>$1</b>').replace(/^## (.*)$/gm, '<div style="margin-top:6px"><b style="color:var(--acc)">$1</b></div>').replace(/^# (.*)$/gm, '<div><b>$1</b></div>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  function panel(id, title, after) {
    if (Q('#' + id)) return Q('#' + id + 'Out');
    const a = Q(after) || Q('#agPanel') || Q('#narrPanel') || Q('#ccDesks'); if (!a) return null;
    const el = document.createElement('div'); el.className = 'panel'; el.id = id; el.style.flex = 'none';
    const c = localStorage.getItem(id + 'C') === '1';
    el.innerHTML = `<div class="phead"><span>${title}</span><span><span id="${id}Meta" class="muted small"></span> <button class="btn ghost mini2" data-rdt="${id}">${c ? '▸' : '▾'}</button></span></div><div id="${id}Out" class="pbody scroll" style="max-height:46vh;overflow:auto;${c ? 'display:none' : ''}"><div class="empty">loading…</div></div>`;
    a.insertAdjacentElement('afterend', el); return Q('#' + id + 'Out');
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-rdt]'); if (!b) return; const id = b.dataset.rdt; const o = Q('#' + id + 'Out'); const c = o.style.display !== 'none'; o.style.display = c ? 'none' : ''; b.textContent = c ? '▸' : '▾'; localStorage.setItem(id + 'C', c ? '1' : '0'); });
  let devTab = 'silent', insTab = 'rank';
  async function dev() {
    const o = panel('devPanel', 'DEVELOPER ACTIVITY <span class="muted small">GitHub commits · 2+ wk silence · bursts · backtest vs crashes &amp; runners</span>', '#agPanel'); if (!o) return false;
    let d; try { d = await get('/api/devactivity'); } catch (e) { o.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return true; }
    if (!d.ok) { o.innerHTML = `<div class="empty">${E(d.note || 'not generated')}</div>`; return true; }
    const m = Q('#devPanelMeta'); if (m) m.textContent = `${d.items.length} projects · built ${new Date(d.generatedAt * (d.generatedAt < 1e12 ? 1000 : 1)).toLocaleString()}`;
    const tabs = [['silent', `Went quiet (${d.live_silent.length})`], ['burst', `Commit bursts (${d.live_bursting.length})`], ['all', 'All'], ['bt', 'Backtest']];
    let h = `<div class="sub">${tabs.map(([k, l]) => `<button class="btn small${devTab === k ? ' on' : ''}" data-devt="${k}">${l}</button>`).join(' ')}</div>`;
    const row = (r) => `<tr><td>${E(r.symbol)}</td><td>${E(r.name || r.id)}</td><td class="r">${r.commits_90d ?? '—'}</td><td class="r">${r.contributors_90d ?? '—'}</td><td class="r">${r.days_since_last_commit ?? '—'}d</td><td class="r">${r.frequency_score ?? '—'}</td><td>${r.silence ? `<span class="chip r">${E(r.silence.replace('_', ' '))}</span>` : ''}${r.burst ? ' <span class="chip g">burst</span>' : ''}</td><td class="small muted">${E((r.repos || []).slice(0, 2).map((x) => (typeof x === 'string' ? x : x.full || x.owner + '/' + x.name)).join(', '))}</td></tr>`;
    if (devTab === 'bt') {
      h += '<table class="tbl"><tr><th>Test</th><th class="r">Events</th><th class="r">Hit rate</th><th class="r">Base</th><th class="r">Lift</th><th class="r">Cluster-perm p</th></tr>' + Object.entries(d.tests || {}).map(([k, v]) => `<tr><td>${E(k)}</td><td class="r">${v.n_events}</td><td class="r">${P(v.hit_rate)}</td><td class="r">${P(v.base_rate)}</td><td class="r">${P(v.lift)}</td><td class="r">${P(v.cluster_perm_p_mean)}</td></tr>`).join('') + '</table>';
      for (const [g, v] of Object.entries(d.subgroups || {})) h += `<div class="small" style="margin-top:4px"><b>${E(g)}</b> (${v.projects_with_repo_and_prices} projects): ` + Object.entries(v).filter(([k]) => typeof v[k] === 'object').map(([k, x]) => `${E(k)} → hit ${P(x.hit_rate)} vs base ${P(x.base_rate)}, p ${P(x.cluster_perm_p_mean)}`).join(' · ') + '</div>';
      h += '<div class="small muted">No flag cleared p&lt;0.05, so the composite "dev" factor stays small (weight 0.5, ±12 max). Crashed (≥70% drawdown) and 10x-runner catalog tokens are tested separately.</div>';
    } else {
      const L = devTab === 'silent' ? d.live_silent : devTab === 'burst' ? d.live_bursting : d.items;
      h += `<table class="tbl"><tr><th>Sym</th><th>Project</th><th class="r">Commits 90d</th><th class="r">Devs 90d</th><th class="r">Last</th><th class="r">Freq</th><th>Flags</th><th>Repos</th></tr>${L.slice(0, 120).map(row).join('')}</table>`;
    }
    o.innerHTML = h + `<div class="small muted">${E(d.nfa || '')}</div>`; return true;
  }
  async function ins() {
    const o = panel('insPanel', 'INSIDER-PRIVILEGE SCAN <span class="muted small">hidden vesting sellers · paid promoters · airdrop asymmetry · cosmetic LP locks · Velvet exposé</span>', '#devPanel'); if (!o) return false;
    let d, v; try { [d, v] = await Promise.all([get('/api/insider'), get('/api/insider/velvet')]); } catch (e) { o.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return true; }
    const tabs = [['rank', 'Worst offenders'], ['velvet', 'Velvet exposé'], ['report', 'Full report']];
    let h = `<div class="sub">${tabs.map(([k, l]) => `<button class="btn small${insTab === k ? ' on' : ''}" data-inst="${k}">${l}</button>`).join(' ')}</div>`;
    if (insTab === 'rank') {
      h += `<div class="small muted">${Object.entries(d.patterns || {}).map(([k, x]) => `<b>${k}</b> ${E(x)}`).join(' · ')} (0–3 each, – = not assessed)</div><table class="tbl"><tr><th>#</th><th>Token</th><th>Chain</th><th>P1</th><th>P2</th><th>P3</th><th>P4</th><th>Confidence</th><th>Proof (tx / on-chain)</th></tr>`;
      for (const c of d.candidates || []) h += `<tr><td>${c.rank}</td><td><b>${E(c.token)}</b></td><td>${E(c.chain)}</td>${['P1', 'P2', 'P3', 'P4'].map((k) => `<td>${c.scores[k] ?? '–'}</td>`).join('')}<td class="small">${E(c.confidence)}</td><td class="small" style="white-space:normal;max-width:520px">${E([...(c.nansen_verified || []), ...(c.verified || [])].slice(0, 2).join(' | ')).slice(0, 700)}<details><summary class="muted">all evidence</summary>${['verified', 'nansen_verified', 'reported', 'inferred', 'not_confirmed'].map((k) => (c[k] || []).length ? `<div><b>${k}</b>: ${(c[k] || []).map(E).join('<br>')}</div>` : '').join('')}</details></td></tr>`;
      h += `</table><div class="small muted">${E(d.method || '')} · ${E(d.nfa || '')}</div>`;
    } else if (insTab === 'velvet') {
      const s = v.summary || {}; h += `<div class="card"><b>Verdict:</b> ${E(typeof s.verdict === 'string' ? s.verdict : JSON.stringify(s.verdict))}</div>` + (v.insider_row ? `<div class="small">Insider scan row #${v.insider_row.rank}: ${Object.entries(v.insider_row.scores).map(([k, x]) => `${k}=${x ?? '–'}`).join(' ')}</div>` : '') + `<div class="small" style="white-space:normal">${md(v.report_md)}</div>`;
    } else h += `<div class="small" style="white-space:normal">${md(d.report_md)}</div>`;
    o.innerHTML = h; return true;
  }
  document.addEventListener('click', (e) => { const a = e.target.closest('[data-devt]'); if (a) { devTab = a.dataset.devt; dev(); } const b = e.target.closest('[data-inst]'); if (b) { insTab = b.dataset.inst; ins(); } });
  async function start() { if (!(await dev())) { setTimeout(start, 800); return; } await ins(); setInterval(() => { if (document.body.dataset.view === 'command') { dev(); ins(); } }, 15 * 60e3); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 1200)); else setTimeout(start, 1200);
})();
