// Stablecoin issuance panel (Command view): /api/stables. Additive; injects its own panel after PATTERN DETECTORS.
'use strict';
(() => {
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const U = (x) => (x == null || isNaN(x) ? '—' : (x < 0 ? '−' : '') + (typeof fUsd === 'function' ? fUsd(Math.abs(x)) : '$' + Math.round(Math.abs(x)).toLocaleString()));
  const S = (x) => (x == null || isNaN(x) ? '—' : `<span class="${x >= 0 ? 'up' : 'dn'}">${x >= 0 ? '+' : '−'}${(typeof fUsd === 'function' ? fUsd(Math.abs(x)) : Math.round(Math.abs(x)))}</span>`);
  const P = (x, d = 2) => (x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const PV = (p) => (p == null ? '–' : p < 0.001 ? '<0.001' : (+p).toFixed(3));
  const NAME = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana', robinhood: 'Robinhood', arbitrum: 'Arbitrum', bsc: 'BSC', tron: 'Tron' };
  function mount() {
    if (document.querySelector('#ccStables')) return document.querySelector('#ccStables');
    const anchor = document.querySelector('#ccPatterns');
    const host = anchor ? anchor.closest('.panel') : null;
    const div = document.createElement('div'); div.className = 'panel';
    div.innerHTML = '<div class="phead"><span>STABLECOIN ISSUANCE <span class="muted small">mint · burn · net per chain · spikes · backtest</span></span></div><div id="ccStables" class="pbody scroll small"></div>';
    if (host && host.parentNode) host.parentNode.insertBefore(div, host.nextSibling); else (document.querySelector('#view-command') || document.body).appendChild(div);
    return div.querySelector('#ccStables');
  }
  async function render() {
    const box = mount(); if (!box) return;
    let d; try { d = await api('/api/stables'); } catch (e) { box.innerHTML = `<div class="empty">${E(e.message || e)}</div>`; return; }
    let h = '';
    const act = d.active_spikes || [];
    h += `<div><b>Active spikes:</b> ${act.length ? act.map((a) => `<span class="up">${E(a.chain || a.pair)} ${U(a.net)} (z ${a.z == null ? '–' : a.z.toFixed(1)}, ${E(a.scope)})</span>`).join(' · ') : 'none'}</div>`;
    // chain table (DefiLlama, USDT+USDC+USDG)
    h += '<table class="tbl"><tr><th>Chain</th><th>Supply</th><th>Net 1d</th><th>Net 7d</th><th>Vel 7d</th><th>Spikes 90d</th></tr>';
    for (const r of d.velocity_ranking || []) {
      const c = d.chains[r.chain] || {};
      h += `<tr><td>${E(NAME[r.chain] || r.chain)} <span class="muted">${E((c.coins || []).join('+'))}</span></td><td>${U(c.supply)}</td><td>${S(c.net_1d)}</td><td>${S(c.net_7d)}</td><td>${P(c.velocity_7d)}</td><td>${(c.spikes_90d || []).length}${c.spike_latest && c.spike_latest.spike ? ' <b class="up">NOW</b>' : ''}</td></tr>`;
    }
    h += '</table>';
    // on-chain gross
    h += '<div class="muted" style="margin-top:4px">On-chain gross (rolling to scan time; primary = excl. CCTP/Gateway cross-chain):</div><table class="tbl"><tr><th>Pair</th><th>24h mint</th><th>24h burn</th><th>24h net</th><th>7d net</th><th>7d primary net</th><th>type</th></tr>';
    for (const [k, o] of Object.entries(d.onchain || {})) {
      const a = (o.windows || {})['24h'], b = (o.windows || {})['7d'];
      h += `<tr><td>${E(k)}</td><td>${a ? U(a.mint) : '—'}</td><td>${a ? U(a.burn) : '—'}</td><td>${a ? S(a.net) : '—'}</td><td>${b ? S(b.net) : '—'}</td><td>${b ? S(b.primary_net) : '—'}</td><td class="muted" title="${E(o.label)}">${o.native ? 'native' : 'bridged'}</td></tr>`;
    }
    h += '</table>';
    const bs = d.base_share || {}, oc = bs.onchain || {};
    const sh = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
    h += `<div><b>Base share of USDC</b> · net 1d: ${sh(bs['1d'] && bs['1d'].base_share_of_global)} of global, ${sh(bs['1d'] && bs['1d'].base_share_of_eth_plus_base)} of ETH+Base · 7d: Base ${U(bs['7d'] && bs['7d'].base_net)} vs ETH ${U(bs['7d'] && bs['7d'].eth_net)}${bs['7d'] && bs['7d'].note ? ` <span class="muted">(${E(bs['7d'].note)})</span>` : ''} · gross-mint share (on-chain) 24h ${sh(oc['24h'] && oc['24h'].base_gross_mint_share)}, 7d ${sh(oc['7d'] && oc['7d'].base_gross_mint_share)}</div>`;
    // backtest
    const bt = d.backtest || {}; const rows = [];
    for (const [ch, v] of Object.entries(bt)) for (const [t, hz] of Object.entries(v.targets || {})) {
      const x = hz['7d'] || {}; const w = x.welch || {};
      rows.push(`<tr><td>${E(NAME[ch] || ch)}</td><td>${E(t.replace(/\(.*\)/, '').trim())}</td><td>${x.n_spike ?? 0}/${x.n_base ?? 0}</td><td>${P(x.mean_spike, 1)}</td><td>${P(x.mean_base, 1)}</td><td>${w.cohen_d == null ? '–' : w.cohen_d.toFixed(2)}</td><td>${PV(w.p)}</td><td>${PV(x.perm_p)}</td></tr>`);
    }
    h += `<div class="muted" style="margin-top:4px">Backtest: net-mint spike day → next 7d log return vs non-spike days (1/3/14d in /api/stables?full=1)</div><table class="tbl"><tr><th>Chain</th><th>Target</th><th>n spike/base</th><th>spike</th><th>base</th><th>d</th><th>Welch p</th><th>perm p</th></tr>${rows.join('')}</table>`;
    h += `<div class="muted">Updated ${E(d.generatedAt)} · DefiLlama + public RPCs (free) · USDT has no native Base deployment; RH USDC/USDe are bridged · not financial advice</div>`;
    box.innerHTML = h;
  }
  window.addEventListener('load', () => { render(); setInterval(render, 300e3); });
})();
