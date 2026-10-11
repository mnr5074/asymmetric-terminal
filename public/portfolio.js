// ASYMMETRIC·TERMINAL — Portfolio aggregation (read-only). Public addresses only; the page never asks for keys.
// Risk flags are pulled from other modules' endpoints when present and silently skipped when not.
'use strict';
(function () {
  const Q = (s) => document.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sh = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
  const usd = (n) => (n == null || isNaN(n) ? '—' : (n < 0 ? '-' : '') + '$' + (Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(1) + 'K' : Math.abs(n).toFixed(2)));
  const px = (p) => (p == null ? '—' : p >= 1 ? '$' + p.toFixed(p >= 1000 ? 0 : 3) : '$' + p.toPrecision(3));
  const amt = (x) => (x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x.toPrecision(4));
  const LS = { w: 'st.pf.wallets.v1', o: 'st.pf.opts.v1', e: 'st.pf.entries.v1', rpc: 'st.rpc.v1' };
  let wallets = JSON.parse(localStorage.getItem(LS.w) || '[]');
  const opts = Object.assign({ threshold: 20, dust: false, unvalued: false }, JSON.parse(localStorage.getItem(LS.o) || '{}'));
  const saveOpts = () => localStorage.setItem(LS.o, JSON.stringify(opts));
  async function call(path, body) {
    const h = { 'content-type': 'application/json' }; const rpc = localStorage.getItem(LS.rpc); if (rpc) h['x-rpc-url'] = rpc;
    const r = await fetch(path, body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
    const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status); return j;
  }
  const st = document.createElement('style');
  st.textContent = `body[data-view=portfolio] main.grid{display:none} body[data-view=portfolio] #viewPortfolio{display:flex;flex-direction:column}
  #viewPortfolio .pbody{padding:8px;overflow:auto;flex:1;min-height:0} #viewPortfolio input,#viewPortfolio select{background:#0d1220;border:1px solid #2a3342;color:#dfe7f3;padding:3px 6px;font:inherit;font-size:12px}
  #viewPortfolio table{width:100%;border-collapse:collapse;font-size:12px} #viewPortfolio td,#viewPortfolio th{padding:3px 5px;border-bottom:1px solid #1b2230;text-align:left;white-space:nowrap} #viewPortfolio th{color:#7f8aa0;font-weight:500;position:sticky;top:0;background:#0b0f18}
  #viewPortfolio td.r,#viewPortfolio th.r{text-align:right} #viewPortfolio .chip{display:inline-block;border-radius:3px;padding:0 4px;margin:0 2px 0 0;font-size:11px;background:#1b2230;color:#9aa6b8} #viewPortfolio .chip.hi{background:#3f1515;color:#ff8b8b} #viewPortfolio .chip.md{background:#3a3414;color:#f3c84a} #viewPortfolio .chip.lo{background:#0f3d24;color:#4ff09a}
  #viewPortfolio .cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin:6px 0} #viewPortfolio .cards div{background:#0b101b;border:1px solid #2a3342;border-radius:4px;padding:6px} #viewPortfolio .cards b{display:block;font-size:16px}
  #viewPortfolio .wl{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0} #viewPortfolio .wl span{border:1px solid #2a3342;border-radius:4px;padding:2px 6px;font-size:12px} #viewPortfolio .warnbox{border:1px solid #6b5a14;background:#221d08;color:#f3c84a;border-radius:4px;padding:6px;margin:6px 0;font-size:12px}
  #viewPortfolio .up{color:#4ff09a} #viewPortfolio .dn{color:#ff6b6b} #viewPortfolio input.entry{width:80px} #pfAddr{flex:1 1 auto!important;min-width:260px} #pfLabel{flex:0 0 110px!important;width:110px!important} #viewPortfolio .filters input[type=checkbox]{width:auto!important}`;
  document.head.appendChild(st);
  const sec = document.createElement('section'); sec.id = 'viewPortfolio'; sec.className = 'view';
  sec.innerHTML = `<div class="panel"><div class="phead"><h2>Portfolio</h2><span class="muted small">read-only aggregation · Solana + EVM · public addresses only, no keys</span>
    <div class="filters"><label class="small">concentration warn &gt; <input id="pfThr" type="number" min="1" max="100" style="width:50px">%</label><label class="small"><input type="checkbox" id="pfDust"> show dust</label><label class="small"><input type="checkbox" id="pfUnv"> include unpriced/spam</label><button id="pfReload" class="btn mini2">refresh</button></div></div>
    <div class="pbody">
      <div class="row" style="gap:6px;flex-wrap:wrap"><button id="pfPhantom" class="btn">+ Phantom</button><button id="pfRabby" class="btn">+ Rabby / EVM wallet</button><input id="pfAddr" style="flex:1;min-width:260px" placeholder="or paste a public Solana / EVM 0x… address"><input id="pfLabel" style="width:110px" placeholder="label"><button id="pfAdd" class="btn">Add</button></div>
      <div id="pfWallets" class="wl"></div>
      <div id="pfSummary"></div><div id="pfWarn"></div><div id="pfTable"></div><div id="pfNotes" class="muted small"></div>
    </div></div>`;
  document.body.insertBefore(sec, Q('footer.foot'));
  Q('#pfThr').value = opts.threshold; Q('#pfDust').checked = opts.dust; Q('#pfUnv').checked = opts.unvalued;

  const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a), isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  function saveWallets() { localStorage.setItem(LS.w, JSON.stringify(wallets)); call('/api/portfolio/wallets', { wallets }).catch(() => {}); renderWallets(); }
  function addWallet(address, label) { address = address.trim(); if (!isSol(address) && !isEvm(address)) return alert('Not a Solana or EVM address'); if (!wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) wallets.push({ address, label: label || '' }); saveWallets(); load(); }
  function renderWallets() {
    Q('#pfWallets').innerHTML = wallets.length ? wallets.map((w, i) => `<span>${isEvm(w.address) ? 'EVM' : 'SOL'} ${E(w.label || sh(w.address))} <code>${E(sh(w.address))}</code>${isSol(w.address) ? ` <a href="#" data-cb="${i}" title="estimate average entry prices from recent swaps (public RPC, ~1 min)">cost basis</a>` : ''} <a href="#" data-rm="${i}">✕</a></span>`).join('') : '<span class="muted">No wallets yet. Add one above (saved in this browser + the local server cache).</span>';
  }
  Q('#pfWallets').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]'), cb = e.target.closest('[data-cb]'); if (!rm && !cb) return; e.preventDefault();
    if (rm) { wallets.splice(+rm.dataset.rm, 1); saveWallets(); return load(); }
    const w = wallets[+cb.dataset.cb]; cb.textContent = 'scanning…';
    try { let j = await call('/api/portfolio/costbasis?address=' + encodeURIComponent(w.address) + '&limit=100'); while (j.status === 'running') { cb.textContent = j.progress; await new Promise((r) => setTimeout(r, 2500)); j = await call('/api/portfolio/costbasis?job=' + j.id); } if (j.status === 'error') throw new Error(j.error); cb.textContent = `cost basis: ${j.swaps} swaps`; cached = {}; load(); }
    catch (er) { cb.textContent = 'cost basis failed'; alert(er.message); }
  });
  Q('#pfAdd').onclick = () => { addWallet(Q('#pfAddr').value, Q('#pfLabel').value); Q('#pfAddr').value = ''; Q('#pfLabel').value = ''; };
  Q('#pfPhantom').onclick = async () => { const p = window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null; if (!p) return alert('Phantom not detected. Install phantom.com and reload, or paste the address manually.'); try { const r = await p.connect(); addWallet(r.publicKey.toString(), 'Phantom'); } catch (e) { alert(e.message); } };
  const evmP = []; window.addEventListener('eip6963:announceProvider', (e) => { if (!evmP.find((p) => p.info.uuid === e.detail.info.uuid)) evmP.push(e.detail); }); window.dispatchEvent(new Event('eip6963:requestProvider'));
  Q('#pfRabby').onclick = async () => { window.dispatchEvent(new Event('eip6963:requestProvider')); await new Promise((r) => setTimeout(r, 150)); const pick = evmP.find((p) => /rabby/i.test(p.info.rdns + p.info.name)) || evmP[0]; const prov = pick?.provider || window.ethereum; if (!prov) return alert('No EVM wallet detected (EIP-6963 / window.ethereum). Paste the address manually.'); try { const a = await prov.request({ method: 'eth_requestAccounts' }); addWallet(a[0], pick?.info?.name || 'EVM'); } catch (e) { alert(e.message); } };
  Q('#pfThr').onchange = () => { opts.threshold = Math.max(1, +Q('#pfThr').value || 20); saveOpts(); render(); };
  Q('#pfDust').onchange = () => { opts.dust = Q('#pfDust').checked; saveOpts(); render(); };
  Q('#pfUnv').onchange = () => { opts.unvalued = Q('#pfUnv').checked; saveOpts(); load(); };
  Q('#pfReload').onclick = () => { ctx = null; load(); };

  // ---------- risk context from other modules (each optional) ----------
  let ctx = null, cached = {};
  async function riskContext() {
    if (ctx) return ctx;
    const get = (p) => call(p).catch(() => null);
    const [comp, unl, perps, pat, narr] = await Promise.all([get('/api/composite'), get('/api/unlocks?all=1'), get('/api/perps'), get('/api/patterns'), get('/api/portfolio/narratives')]);
    const c = { comp: {}, unl: {}, perp: {}, pat: {}, crowded: new Set(), avail: [] };
    if (comp?.tokens) { c.avail.push('composite'); for (const t of comp.tokens) { c.comp[(t.id || '').toLowerCase()] = t; if (t.sym) c.comp['sym:' + t.sym.toUpperCase()] ||= t; } }
    if (unl?.tokens) { c.avail.push('unlocks'); for (const t of unl.tokens) if (t.sym) c.unl[t.sym.toUpperCase()] = t; }
    if (perps?.tokens) { c.avail.push('perps'); for (const t of perps.tokens) if (t.sym) c.perp[t.sym.toUpperCase()] = t; }
    if (pat) { c.avail.push('patterns'); const walk = (o, src, d = 0) => { if (!o || d > 4) return; if (Array.isArray(o)) { for (const x of o) if (x && typeof x === 'object' && (x.symbol || x.key || x.address)) { const k = (x.key || (x.chain && x.address ? x.chain + ':' + x.address : '')).toLowerCase(); const it = { src, why: x.why || x.text || x.reason || src }; if (k) c.pat[k] = it; if (x.symbol) c.pat['sym:' + String(x.symbol).toUpperCase()] ||= it; } return; } for (const [k, v] of Object.entries(o)) if (typeof v === 'object') walk(v, src, d + 1); };
      for (const k of Object.keys(pat)) if (pat[k]?.live) walk(pat[k].live, k); }
    if (narr?.themes) { c.avail.push('narratives'); for (const t of narr.themes) if (t.overcrowded) c.crowded.add(t.id); }
    return (ctx = c);
  }
  const GR = { A: 20, B: 35, C: 50, D: 65, F: 80 };
  function enrich(p, c) {
    const flags = []; const sym = (p.symbol || '').toUpperCase(); const key = (p.chain + ':' + p.mint).toLowerCase();
    let base = null;
    const comp = c.comp[key]; if (comp) { flags.push({ t: 'grade ' + comp.grade, lv: comp.grade <= 'B' ? 'lo' : comp.grade === 'C' ? 'md' : 'hi', why: 'composite grade (lib/composite.js)' }); base = GR[comp.grade]; }
    const rug = cached['rug:' + key]; if (rug) { flags.push({ t: 'rug ' + rug.level, lv: rug.level === 'low' ? 'lo' : rug.level === 'high' ? 'hi' : 'md', why: `rug forecast score ${rug.score}${rug.dump30 ? ', 30d dump risk' : ''}` }); base = base == null ? rug.score : (base + rug.score) / 2; }
    if (base == null) base = p.narratives?.[0]?.id === 'majors' ? (p.mint === 'native' || sym === 'SOL' || sym === 'ETH' ? 15 : 5) : p.verified && (p.liquidityUsd || 0) > 1e6 ? 35 : 55;
    let bump = 0;
    const u = c.unl[sym]; if (u && u.pct30 >= 2) { flags.push({ t: `unlock ${u.pct30.toFixed(0)}% / 30d`, lv: u.pct30 >= 10 ? 'hi' : 'md', why: `${u.level || ''} unlock ${u.pct30.toFixed(1)}% of circulating within 30d (next ${u.dates?.[0]?.date || '?'})` }); bump += u.pct30 >= 10 ? 20 : 8; }
    const pf = c.perp[sym]; if (pf && (Math.abs(pf.fAnn || 0) >= 50 || Math.abs(pf.z || 0) >= 2 || (pf.flags || []).some((f) => f.level === 'alert' || f.level === 'extreme'))) { flags.push({ t: `funding ${Math.round(pf.fAnn)}%/yr${Math.abs(pf.z || 0) >= 2 ? ` (z ${pf.z.toFixed(1)})` : ''}`, lv: 'md', why: (pf.flags || []).map((f) => f.text).join(' ') || `funding z ${pf.z?.toFixed(1)}` }); bump += 10; }
    const pt = c.pat[key] || c.pat['sym:' + sym]; if (pt) { flags.push({ t: 'pattern: ' + pt.src, lv: 'hi', why: pt.why }); bump += 20; }
    const crowd = (p.narratives || []).find((n) => c.crowded.has(n.id)); if (crowd) { flags.push({ t: 'crowded: ' + crowd.name, lv: 'md', why: 'narrative flagged overcrowded (narratives desk)' }); bump += 10; }
    if (p.spam) { flags.push({ t: 'spam?', lv: 'hi', why: 'unverified / no liquid market' }); bump += 20; }
    else if (p.priceNote) flags.push({ t: 'illiquid', lv: 'md', why: p.priceNote });
    if (p.chain === 'solana' && p.audit && (p.audit.mintAuthorityDisabled === false || p.audit.freezeAuthorityDisabled === false)) { flags.push({ t: 'authority live', lv: 'md', why: `${p.audit.mintAuthorityDisabled === false ? 'mint ' : ''}${p.audit.freezeAuthorityDisabled === false ? 'freeze ' : ''}authority not renounced (Jupiter audit)` }); bump += 8; }
    p.flags = flags; p.risk = Math.min(100, Math.round(base + bump));
  }

  // ---------- load + render ----------
  let DATA = null;
  async function load() {
    renderWallets();
    if (!wallets.length) { DATA = null; Q('#pfSummary').innerHTML = ''; Q('#pfTable').innerHTML = ''; Q('#pfWarn').innerHTML = ''; return; }
    Q('#pfTable').innerHTML = '<div class="empty"><span class="spin"></span> reading balances (Solana RPC, EVM multicall over 8 chains, prices)…</div>';
    try {
      const [d, c] = await Promise.all([call('/api/portfolio?wallets=' + wallets.map((w) => w.address).join(',') + (opts.unvalued ? '&all=1' : '')), riskContext()]);
      // manual entries stored in this browser override server ones
      const me = JSON.parse(localStorage.getItem(LS.e) || '{}');
      for (const p of d.positions) { const m = me[p.chain + ':' + p.mint]; if (m) { p.entryPrice = m; p.entrySource = 'manual'; p.unrealizedUsd = p.priceUsd && p.valueUsd != null ? (p.priceUsd - m) * p.amount : null; p.unrealizedPct = p.priceUsd ? (p.priceUsd / m - 1) * 100 : null; } enrich(p, c); }
      DATA = { ...d, ctx: c }; render();
    } catch (e) { Q('#pfTable').innerHTML = `<div class="dn small">${E(e.message)}</div>`; }
  }
  function render() {
    if (!DATA) return; const d = DATA, thr = opts.threshold / 100;
    const rows = d.positions.filter((p) => opts.dust || !p.dust);
    const total = d.totalUsd || 0;
    const valued = d.positions.filter((p) => p.valueUsd != null);
    const wRisk = total ? valued.reduce((s, p) => s + p.valueUsd * p.risk, 0) / total : null;
    const hiShare = total ? valued.filter((p) => p.risk >= 60).reduce((s, p) => s + p.valueUsd, 0) / total : null;
    const pnl = valued.filter((p) => p.unrealizedUsd != null);
    // concentration: token (merged across wallets) and narrative (majors/stables excluded)
    const byTok = {}, byNarr = {};
    for (const p of valued) { const k = p.chain + ':' + (p.native ? 'native' : p.mint); (byTok[k] ||= { sym: p.symbol, chain: p.chain, v: 0 }).v += p.valueUsd; const n = p.narratives?.[0]; const nk = n ? n.id : 'unclassified'; if (nk !== 'majors') (byNarr[nk] ||= { name: n ? n.name : 'unclassified', v: 0 }).v += p.valueUsd; }
    const warns = [];
    for (const t of Object.values(byTok)) if (total && t.v / total > thr) warns.push(`Token <b>${E(t.sym)}</b> (${E(t.chain)}) is ${(100 * t.v / total).toFixed(1)}% of the portfolio`);
    for (const n of Object.values(byNarr)) if (total && n.v / total > thr) warns.push(`Narrative <b>${E(n.name)}</b> is ${(100 * n.v / total).toFixed(1)}% of the portfolio`);
    Q('#pfWarn').innerHTML = warns.length ? `<div class="warnbox">⚠ Concentration above ${opts.threshold}%:<br>${warns.join('<br>')}</div>` : total ? `<div class="muted small">No single token or narrative above ${opts.threshold}%.</div>` : '';
    Q('#pfSummary').innerHTML = `<div class="cards"><div><span class="muted small">total value (liquid, priced)</span><b>${usd(total)}</b></div><div><span class="muted small">holdings shown</span><b>${rows.length}</b><span class="muted small">${d.hidden.spamOrUnpriced} unpriced/spam, ${d.hidden.dust} dust hidden</span></div><div><span class="muted small">weighted risk (0-100)</span><b class="${wRisk >= 60 ? 'dn' : wRisk >= 40 ? '' : 'up'}">${wRisk == null ? '—' : wRisk.toFixed(0)}</b></div><div><span class="muted small">value in high-risk (≥60)</span><b>${hiShare == null ? '—' : (hiShare * 100).toFixed(1) + '%'}</b></div><div><span class="muted small">unrealized P&L (where entry known)</span><b class="${pnl.reduce((s, p) => s + p.unrealizedUsd, 0) >= 0 ? 'up' : 'dn'}">${pnl.length ? usd(pnl.reduce((s, p) => s + p.unrealizedUsd, 0)) : '—'}</b><span class="muted small">${pnl.length} positions with entry</span></div><div><span class="muted small">risk sources live</span><b style="font-size:12px">${E(d.ctx.avail.join(', ') || 'none')}</b><button id="pfRug" class="btn mini2" title="Run the rug forecast on the 10 largest non-major positions">deep risk scan</button></div></div>`;
    Q('#pfRug').onclick = deepRisk;
    Q('#pfTable').innerHTML = rows.length ? `<table><tr><th>token</th><th>chain</th><th>wallet</th><th class="r">amount</th><th class="r">price</th><th class="r">value</th><th class="r">%</th><th class="r">entry</th><th class="r">uP&L</th><th>narrative</th><th class="r">risk</th><th>flags</th><th>sell (private Jito)</th></tr>${rows.map((p) => `<tr><td><b>${E(p.symbol)}</b> <span class="muted small">${E((p.name || '').slice(0, 22))}</span></td><td>${E(p.chain)}</td><td class="muted">${E(sh(p.wallet))}</td><td class="r">${amt(p.amount)}</td><td class="r">${px(p.priceUsd)}</td><td class="r" title="${E(p.priceNote || '')}">${p.valueUsd == null ? '<span class="muted">n/v</span>' : usd(p.valueUsd)}</td><td class="r">${p.valueUsd != null && total ? ((100 * p.valueUsd) / total).toFixed(1) : '—'}</td><td class="r"><input class="entry" data-k="${E(p.chain + ':' + p.mint)}" value="${p.entryPrice != null ? +p.entryPrice.toPrecision(5) : ''}" placeholder="entry $" title="${E(p.entrySource || 'enter your average entry price')}"></td><td class="r ${p.unrealizedUsd >= 0 ? 'up' : 'dn'}">${p.unrealizedUsd == null ? '—' : usd(p.unrealizedUsd) + ` (${p.unrealizedPct.toFixed(0)}%)`}</td><td class="small">${E((p.narratives || []).map((n) => n.name).slice(0, 2).join(', ') || '—')}</td><td class="r ${p.risk >= 60 ? 'dn' : p.risk < 30 ? 'up' : ''}">${p.risk}</td><td>${p.flags.map((f) => `<span class="chip ${f.lv}" title="${E(f.why)}">${E(f.t)}</span>`).join('')}</td><td>${sellBtns(p)}</td></tr>`).join('')}</table>` : '<div class="empty small">No priced positions.</div>';
    Q('#pfNotes').innerHTML = `${d.wallets.map((w) => `${E(sh(w.address))}: ${w.error ? '<span class="dn">' + E(w.error) + '</span>' : E(w.source || '')} ${(w.notes || []).length ? '· ' + E(w.notes.join('; ')) : ''}`).join('<br>')}<br>Values count only tokens with ≥$${d.method.minLiquidityUsd.toLocaleString()} DEX liquidity and positions ≤50% of their pool. Risk 0-100 = composite grade / rug forecast (if available) or a class default, plus bumps for unlocks, funding extremes, live pattern flags, overcrowded narratives, spam and live mint/freeze authority. Entry: ${E(d.method.entry)}. Narrative tags: ${E((d.narrativeSources || []).length ? 'narratives desk + CoinGecko categories (symbol + market-cap match)' : 'unavailable')}. Not financial advice.`;
  }
  // Sell presets: prefill a SELL quote in the Swap tab (you still review costs and sign in Phantom; nothing is sent from here)
  const QUOTE_ASSETS = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
  function sellBtns(p) {
    if (p.chain !== 'solana') return '<span class="muted small" title="EVM sells: use the DEX UI in Rabby with Flashbots Protect / MEV Blocker RPC (Swap tab → EVM)">EVM: DEX + private RPC</span>';
    if (QUOTE_ASSETS.includes(p.mint) || !(p.amount > 0)) return '';
    const i = DATA.positions.indexOf(p);
    return [25, 50, 100].map((x) => `<button class="btn mini2" data-sell="${i}" data-pct="${x}" title="prefill a sell quote for ${x}%">${x}%</button>`).join(' ');
  }
  Q('#pfTable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sell]'); if (!b) return;
    const p = DATA.positions[+b.dataset.sell]; const pct = +b.dataset.pct / 100;
    let amt = p.amount * pct;
    if (p.native || p.symbol === 'SOL') amt = Math.max(0, Math.min(amt, p.amount - 0.01)); // keep 0.01 SOL for fees/rent
    if (!(amt > 0)) return alert('Nothing to sell after the 0.01 SOL fee reserve.');
    if (!window.swapSell) return alert('Swap module not loaded.');
    window.swapSell({ mint: p.native || p.symbol === 'SOL' ? 'So11111111111111111111111111111111111111112' : p.mint, uiAmount: amt, wallet: p.wallet, symbol: p.symbol });
  });
  Q('#pfTable').addEventListener('change', (e) => {
    const i = e.target.closest('input.entry'); if (!i) return;
    const me = JSON.parse(localStorage.getItem(LS.e) || '{}'); const v = i.value.trim();
    if (v === '') delete me[i.dataset.k]; else if (+v > 0) me[i.dataset.k] = +v; else return;
    localStorage.setItem(LS.e, JSON.stringify(me)); call('/api/portfolio/entry', { key: i.dataset.k, price: v === '' ? null : +v }).catch(() => {});
    const p = DATA.positions.find((x) => x.chain + ':' + x.mint === i.dataset.k); if (p) { p.entryPrice = v === '' ? null : +v; p.entrySource = 'manual'; p.unrealizedUsd = p.entryPrice && p.priceUsd && p.valueUsd != null ? (p.priceUsd - p.entryPrice) * p.amount : null; p.unrealizedPct = p.entryPrice && p.priceUsd ? (p.priceUsd / p.entryPrice - 1) * 100 : null; }
    render();
  });
  async function deepRisk() {
    const b = Q('#pfRug'); b.disabled = true;
    const tgt = DATA.positions.filter((p) => p.valueUsd != null && !p.native && p.narratives?.[0]?.id !== 'majors').slice(0, 10);
    let n = 0;
    for (const p of tgt) { b.textContent = `rug ${++n}/${tgt.length}…`; const k = 'rug:' + (p.chain + ':' + p.mint).toLowerCase(); if (!cached[k]) { try { cached[k] = await call(`/api/rug/token?chain=${p.chain}&address=${encodeURIComponent(p.mint)}`); } catch {} } }
    for (const p of DATA.positions) enrich(p, DATA.ctx); render();
  }

  // ---------- nav ----------
  const nav = Q('#viewNav'); if (nav && !nav.querySelector('[data-v=portfolio]')) { const b = document.createElement('button'); b.dataset.v = 'portfolio'; b.textContent = 'Portfolio'; nav.appendChild(b); }
  let loaded = false;
  function onView() { if (document.body.dataset.view === 'portfolio' && !loaded) { loaded = true; if (!wallets.length) call('/api/portfolio/state').then((s) => { if (s.wallets?.length && !wallets.length) { wallets = s.wallets; localStorage.setItem(LS.w, JSON.stringify(wallets)); } load(); }).catch(load); else load(); } }
  new MutationObserver(onView).observe(document.body, { attributes: true, attributeFilter: ['data-view'] }); onView();
})();
