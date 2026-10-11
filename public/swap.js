// ASYMMETRIC·TERMINAL — Swap (wallet-approved) + Sandwich log + Wallet audit.
// The page never sees a private key. Transactions are built by the local server, shown to you with every cost,
// then signed (or rejected) by YOU in Phantom via signTransaction. The terminal submits the signed bytes via the
// route you chose (Jito private by default). It never trades on its own.
'use strict';
(function () {
  const Q = (s, r = document) => r.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sh = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
  const usd = (n) => (n == null || isNaN(n) ? '—' : '$' + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4)));
  const num = (x, d = 6) => (x == null || isNaN(x) ? '—' : Math.abs(x) >= 1e6 ? x.toExponential(3) : (+x).toLocaleString(undefined, { maximumFractionDigits: d }));
  const LSK = { rpc: 'st.rpc.v1', sw: 'st.swap.v1' };
  const WSOL = 'So11111111111111111111111111111111111111112';
  const PRESETS = [['SOL', WSOL], ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'], ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'], ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'], ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263']];
  const pref = Object.assign({ route: 'private', tipSol: 0.0001, slippageBps: 50, dyn: true, source: 'jupiter', prio: 'high' }, JSON.parse(localStorage.getItem(LSK.sw) || '{}'));
  const savePref = () => localStorage.setItem(LSK.sw, JSON.stringify(pref));
  async function call(path, body) {
    const h = { 'content-type': 'application/json' }; const rpc = localStorage.getItem(LSK.rpc); if (rpc) h['x-rpc-url'] = rpc;
    const r = await fetch(path, body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
    const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status); return j;
  }

  // ---------- styles (scoped, injected so style.css stays untouched) ----------
  const st = document.createElement('style');
  st.textContent = `body[data-view=swap] main.grid{display:none} body[data-view=swap] #viewSwap{display:grid;grid-template-columns:minmax(340px,440px) minmax(0,1fr);gap:6px}
  #viewSwap .pbody{padding:8px;overflow:auto} #viewSwap label{display:flex;align-items:center;gap:6px;margin:4px 0;color:#9aa6b8;font-size:12px}
  #viewSwap input,#viewSwap select{background:#0d1220;border:1px solid #2a3342;color:#dfe7f3;padding:4px 6px;font:inherit;font-size:12px}
  #viewSwap .seg{display:inline-flex;border:1px solid #2a3342;border-radius:4px;overflow:hidden} #viewSwap .seg button{background:#121826;color:#9aa6b8;border:0;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px} #viewSwap .seg button.on{background:#1d3a5f;color:#e6f0ff}
  #viewSwap .card2{border:1px solid #2a3342;border-radius:4px;padding:8px;margin:6px 0;background:#0b101b;font-size:12px} #viewSwap .warn{color:#f3c84a} #viewSwap .ok{color:#4ff09a} #viewSwap .bad{color:#ff6b6b}
  #viewSwap table{width:100%;border-collapse:collapse;font-size:12px} #viewSwap td,#viewSwap th{padding:3px 5px;border-bottom:1px solid #1b2230;text-align:left} #viewSwap th{color:#7f8aa0;font-weight:500}
  #viewSwap .stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin:6px 0} #viewSwap .stats div{background:#0b101b;border:1px solid #2a3342;border-radius:4px;padding:6px} #viewSwap .stats b{display:block;font-size:16px}
  #viewSwap select{flex:0 0 auto!important;width:auto!important} #swIn,#swOut,#swAudAddr{flex:1 1 auto!important;min-width:140px;width:auto!important} #viewSwap label>input[type=checkbox]{width:auto!important;flex:0 0 auto!important}
  #viewSwap code{font-size:11px;word-break:break-all} #viewSwap .rightcol{display:flex;flex-direction:column;gap:6px;min-height:0}`;
  document.head.appendChild(st);

  // ---------- markup ----------
  const sec = document.createElement('section'); sec.id = 'viewSwap'; sec.className = 'view';
  sec.innerHTML = `
  <div class="panel"><div class="phead"><h2>Swap</h2><span class="muted small">one-tap · you sign in Phantom · private route by default</span></div>
   <div class="pbody">
    <div class="row" style="gap:6px;align-items:center"><button id="swWallet" class="btn">Connect Phantom</button><span id="swWalletInfo" class="muted small"></span></div>
    <label>From <select id="swInPre"></select><input id="swIn" style="flex:1" placeholder="input mint"></label>
    <label>To <select id="swOutPre"></select><input id="swOut" style="flex:1" placeholder="output mint (or click a token in Terminal)"></label>
    <label>Amount <input id="swAmt" type="number" step="any" min="0" style="width:120px" placeholder="0.0"> <span id="swAmtUnit" class="muted"></span></label>
    <label>Quote source <select id="swSrc"><option value="jupiter">Jupiter (best route)</option><option value="raydium">Raydium trade API</option><option value="both">Compare both</option></select></label>
    <label>Max slippage <input id="swSlip" type="number" min="1" max="5000" style="width:70px"> bps <label style="margin:0"><input id="swDyn" type="checkbox"> Jupiter dynamic slippage</label></label>
    <label>Submission <span class="seg" id="swRoute"><button data-r="private">Private (Jito)</button><button data-r="public">Public mempool</button></span></label>
    <div id="swPrivOpts"><label>Jito tip <input id="swTip" type="number" step="0.00001" min="0.000001" max="0.005" style="width:100px"> SOL <span id="swTipUsd" class="muted"></span></label><div id="swTipFloor" class="muted small"></div></div>
    <div id="swPubOpts" class="hidden"><label>Priority fee <select id="swPrio"><option value="medium">medium</option><option value="high">high</option><option value="veryHigh">very high</option></select> (cap 0.0002 SOL)</label><div class="warn small">Public route: your tx goes to the RPC/leader path in the clear. Higher sandwich risk on thin pools.</div></div>
    <div class="row" style="gap:6px;margin-top:6px"><button id="swQuote" class="btn">Get quote</button></div>
    <div id="swQuoteOut"></div><div id="swBuildOut"></div>
    <details class="card2"><summary>EVM (Rabby): private mempool RPCs (free)</summary><div id="swEvm" class="small"></div></details>
    <div class="muted small" style="margin-top:6px">No keys are requested or stored. The server rejects any signed tx whose fee payer isn't the wallet the quote was built for. No platform fee.</div>
   </div></div>
  <div class="rightcol">
   <div class="panel"><div class="phead"><h2>Sandwich log</h2><span class="muted small">every fill vs its quote · same-slot bracket check</span><span style="margin-left:auto" class="small">tolerance <input id="swTol" type="number" step="0.1" min="0.05" max="20" style="width:60px">% <button id="swTolSave" class="btn mini2">set</button></span></div>
    <div class="pbody"><div id="swStats"></div><div id="swLog"></div></div></div>
   <div class="panel"><div class="phead"><h2>Audit a wallet</h2><span class="muted small">read-only · scans recent swaps for sandwich brackets (public RPC)</span></div>
    <div class="pbody"><div class="row" style="gap:6px"><input id="swAudAddr" style="flex:1" placeholder="Solana address (read-only)"><select id="swAudN"><option>10</option><option selected>20</option><option>40</option></select><button id="swAudGo" class="btn">Audit</button></div><div id="swAudOut" class="small"></div></div></div>
  </div>`;
  document.body.insertBefore(sec, Q('footer.foot'));

  for (const id of ['#swInPre', '#swOutPre']) Q(id).innerHTML = PRESETS.map(([n, m]) => `<option value="${m}">${n}</option>`).join('') + '<option value="">custom…</option>';
  Q('#swIn').value = pref.inMint || WSOL; Q('#swOut').value = pref.outMint || PRESETS[1][1];
  const syncPre = () => { Q('#swInPre').value = PRESETS.some((p) => p[1] === Q('#swIn').value) ? Q('#swIn').value : ''; Q('#swOutPre').value = PRESETS.some((p) => p[1] === Q('#swOut').value) ? Q('#swOut').value : ''; const p = PRESETS.find((x) => x[1] === Q('#swIn').value); Q('#swAmtUnit').textContent = p ? p[0] : 'tokens'; };
  Q('#swInPre').onchange = () => { if (Q('#swInPre').value) Q('#swIn').value = Q('#swInPre').value; syncPre(); };
  Q('#swOutPre').onchange = () => { if (Q('#swOutPre').value) Q('#swOut').value = Q('#swOutPre').value; syncPre(); };
  Q('#swIn').oninput = Q('#swOut').oninput = syncPre; syncPre();
  Q('#swSlip').value = pref.slippageBps; Q('#swDyn').checked = pref.dyn; Q('#swTip').value = pref.tipSol; Q('#swSrc').value = pref.source; Q('#swPrio').value = pref.prio;
  function setRoute(r) { pref.route = r; savePref(); Q('#swRoute').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === r)); Q('#swPrivOpts').classList.toggle('hidden', r !== 'private'); Q('#swPubOpts').classList.toggle('hidden', r !== 'public'); Q('#swBuildOut').innerHTML = ''; }
  Q('#swRoute').onclick = (e) => { const b = e.target.closest('button[data-r]'); if (b) setRoute(b.dataset.r); };
  setRoute(pref.route);

  // ---------- config (tip floor, EVM endpoints) ----------
  let CFG = null, SOLUSD = null;
  async function loadCfg() {
    try {
      CFG = await call('/api/swap/config');
      const f = CFG.jito.tipFloorLamports || {};
      Q('#swTipFloor').innerHTML = f.p50 != null ? `Jito landed tips now: p50 ${(f.p50 / 1e9).toFixed(7)} · p75 ${(f.p75 / 1e9).toFixed(7)} · p95 ${(f.p95 / 1e9).toFixed(7)} SOL. Default 0.0001 SOL is generous; lower = cheaper but may land slower.` : 'Jito tip floor unavailable';
      Q('#swEvm').innerHTML = `${E(CFG.evm.note)}<table>${CFG.evm.endpoints.map((x) => `<tr><td>${E(x.name)}</td><td><code>${E(x.rpcUrl)}</code></td><td><button class="btn mini2" data-copy="${E(x.rpcUrl)}">copy</button></td><td class="muted">${E(x.info)}</td></tr>`).join('')}</table><div class="muted">In Rabby: Settings → Custom RPC → Ethereum → paste. ${E(CFG.evm.l2)}</div>`;
      Q('#swTol').value = (await call('/api/mev/log?limit=1')).settings.tolerancePct;
    } catch (e) { Q('#swTipFloor').textContent = 'config error: ' + e.message; }
  }
  Q('#swEvm').addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'copied'; }); });
  const tipUsd = () => { const t = +Q('#swTip').value; Q('#swTipUsd').textContent = SOLUSD && t ? `≈ ${usd(t * SOLUSD)}` : ''; };
  Q('#swTip').oninput = tipUsd;

  // ---------- Phantom via Wallet Standard (raw-bytes signTransaction, no web3.js needed) ----------
  const WALLETS = [];
  const wsApi = { register: (...ws) => { for (const w of ws) if (!WALLETS.includes(w)) WALLETS.push(w); return () => {}; } };
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(wsApi); } catch {} });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: wsApi })); } catch {}
  let ACC = null, WS = null;
  const injected = () => (window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null);
  function walletInfo() { Q('#swWallet').textContent = ACC ? 'Phantom ' + sh(ACC.address) : 'Connect Phantom'; Q('#swWalletInfo').textContent = ACC ? (WS ? 'Wallet Standard' : 'injected provider') : 'needed only to sign; quotes work without it'; }
  Q('#swWallet').onclick = async () => {
    try {
      if (ACC) { ACC = null; WS = null; return walletInfo(); }
      const w = WALLETS.find((x) => /phantom/i.test(x.name) && x.features['solana:signTransaction']);
      if (w) { const r = await w.features['standard:connect'].connect(); WS = w; ACC = { address: (r.accounts || w.accounts)[0].address, account: (r.accounts || w.accounts)[0] }; }
      else { const p = injected(); if (!p) throw new Error('Phantom not detected. Install phantom.com and reload.'); const r = await p.connect(); ACC = { address: r.publicKey.toString() }; }
      walletInfo();
    } catch (e) { alert('Phantom: ' + e.message); }
  };
  walletInfo();
  const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const bytesToB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function signAll(txsB64) {
    if (WS) {
      const inputs = txsB64.map((t) => ({ account: ACC.account, transaction: b64ToBytes(t), chain: 'solana:mainnet' }));
      const out = await WS.features['solana:signTransaction'].signTransaction(...inputs);
      return out.map((o) => bytesToB64(o.signedTransaction));
    }
    // fallback: injected provider needs web3.js objects (loaded on demand, only in this case)
    const { VersionedTransaction } = await import('https://esm.sh/@solana/web3.js@1.98.0');
    const p = injected(); const v = txsB64.map((t) => VersionedTransaction.deserialize(b64ToBytes(t)));
    const s = v.length > 1 ? await p.signAllTransactions(v) : [await p.signTransaction(v[0])];
    return s.map((x) => bytesToB64(x.serialize()));
  }

  // ---------- quote / build / sign / submit ----------
  let QUOTE = null, BUILD = null;
  function quoteCard(q, tag) {
    return `<div class="card2"><b>${E(tag || q.source)}</b> · ${E(q.route || '')}<br>
      You pay <b>${num(q.inUi)}</b> → receive ≈ <b>${num(q.outUi)}</b> (min <b>${num(q.minOutUi)}</b> at ${(q.slippageBps / 100).toFixed(2)}% max slippage)<br>
      Quoted price: 1 in = ${num(q.quotedPrice, 8)} out · price impact ${(+q.priceImpactPct || 0).toFixed(3)}% · value ${usd(q.inUsd)} → ${usd(q.outUsd)}</div>`;
  }
  Q('#swQuote').onclick = async () => {
    BUILD = null; Q('#swBuildOut').innerHTML = '';
    pref.inMint = Q('#swIn').value.trim(); pref.outMint = Q('#swOut').value.trim(); pref.slippageBps = +Q('#swSlip').value || 50; pref.dyn = Q('#swDyn').checked; pref.tipSol = +Q('#swTip').value || 0.0001; pref.source = Q('#swSrc').value; pref.prio = Q('#swPrio').value; savePref();
    const amt = +Q('#swAmt').value; if (!(amt > 0)) return (Q('#swQuoteOut').innerHTML = '<div class="bad small">Enter an amount.</div>');
    Q('#swQuoteOut').innerHTML = '<div class="empty"><span class="spin"></span> quoting…</div>';
    const qs = (src) => call(`/api/swap/quote?source=${src}&inputMint=${encodeURIComponent(pref.inMint)}&outputMint=${encodeURIComponent(pref.outMint)}&uiAmount=${amt}&slippageBps=${pref.slippageBps}`);
    try {
      let list;
      if (pref.source === 'both') { const r = await Promise.allSettled([qs('jupiter'), qs('raydium')]); list = r.filter((x) => x.status === 'fulfilled').map((x) => x.value); if (!list.length) throw r[0].reason; list.sort((a, b) => b.outUi - a.outUi); }
      else list = [await qs(pref.source)];
      QUOTE = list[0]; SOLUSD = QUOTE.inputMint === WSOL ? QUOTE.inUsdPrice : QUOTE.outputMint === WSOL ? QUOTE.outUsdPrice : SOLUSD; tipUsd();
      Q('#swQuoteOut').innerHTML = list.map((q, i) => quoteCard(q, (list.length > 1 ? (i === 0 ? 'BEST · ' : '') : '') + q.source)).join('') + `<button id="swBuild" class="btn">Build transaction (${E(QUOTE.source)}, ${pref.route})</button> <span class="muted small">builds an unsigned tx + simulates it. Nothing is signed or sent.</span>`;
      Q('#swBuild').onclick = build;
    } catch (e) { Q('#swQuoteOut').innerHTML = `<div class="bad small">${E(e.message)}</div>`; }
  };
  async function build() {
    if (!ACC) return (Q('#swBuildOut').innerHTML = '<div class="warn small">Connect Phantom first: the tx must be built for your wallet (fee payer).</div>');
    Q('#swBuildOut').innerHTML = '<div class="empty"><span class="spin"></span> building + simulating…</div>';
    try {
      BUILD = await call('/api/swap/build', { quoteId: QUOTE.quoteId, userPublicKey: ACC.address, route: pref.route, tipLamports: Math.round(pref.tipSol * 1e9), dynamicSlippage: pref.dyn, priorityLevel: pref.prio });
      const c = BUILD.costs, sim = BUILD.simulation || {};
      const ds = BUILD.dynamicSlippageReport ? ` · dynamic slippage set ${(BUILD.dynamicSlippageReport.slippageBps / 100).toFixed(2)}%` : '';
      Q('#swBuildOut').innerHTML = `<div class="card2"><b>Review before signing</b><br>
        Route: <b>${BUILD.route === 'private' ? 'PRIVATE · Jito Block Engine' : 'PUBLIC · RPC'}</b> (${E(BUILD.submitMode)}) · ${BUILD.transactions.length} tx to sign${ds}<br>
        Costs (paid by your wallet only if it lands): network ${(c.networkBaseFeeLamports / 1e9).toFixed(6)} + priority ${(c.priorityFeeLamports / 1e9).toFixed(6)} + <b>Jito tip ${(c.jitoTipLamports / 1e9).toFixed(6)}</b> = <b>${c.totalSol.toFixed(6)} SOL (${usd(c.totalUsd)})</b><br>
        <span class="muted">${E(c.note)}</span><br>
        Simulation: ${sim.err ? `<span class="bad">${E(JSON.stringify(sim.err))}</span>` : sim.error ? `<span class="warn">${E(sim.error)}</span>` : `<span class="ok">OK</span> (${sim.unitsConsumed} CU)`}<br>
        Fee payer ${E(sh(BUILD.txSummaries[0].feePayer))} · programs: ${BUILD.txSummaries[0].programs.map(sh).join(', ')}<br>
        <label><input type="checkbox" id="swAck"> I've reviewed the amounts and the ${c.totalSol.toFixed(6)} SOL cost</label>
        <button id="swSign" class="btn" disabled>Sign in Phantom &amp; submit</button> <span class="muted small">expires in ~${BUILD.expiresInSec}s</span></div>`;
      Q('#swAck').onchange = () => { Q('#swSign').disabled = !Q('#swAck').checked; };
      Q('#swSign').onclick = signSubmit;
    } catch (e) { Q('#swBuildOut').innerHTML = `<div class="bad small">${E(e.message)}</div>`; }
  }
  async function signSubmit() {
    const btn = Q('#swSign'); btn.disabled = true; btn.textContent = 'waiting for Phantom…';
    try {
      const signed = await signAll(BUILD.transactions);
      btn.textContent = 'submitting…';
      const r = await call('/api/swap/submit', { buildId: BUILD.buildId, signedTransactions: signed });
      Q('#swBuildOut').insertAdjacentHTML('beforeend', `<div class="card2 ok">Submitted via ${E(r.via)}<br><a href="${E(r.solscan)}" target="_blank" rel="noopener">${E(sh(r.signature))} ↗</a>${r.walletModifiedTx ? '<br><span class="warn">Note: Phantom modified the tx before signing (e.g. added its own instructions).</span>' : ''}<br><span class="muted">Fill will be checked against the quote after confirmation (see Sandwich log).</span></div>`);
      BUILD = null; setTimeout(loadLog, 4000); setTimeout(loadLog, 15000); setTimeout(loadLog, 45000);
    } catch (e) { btn.textContent = 'Sign in Phantom & submit'; btn.disabled = false; Q('#swBuildOut').insertAdjacentHTML('beforeend', `<div class="bad small">${E(e.message)} (nothing was sent)</div>`); }
  }

  // ---------- sandwich log ----------
  async function loadLog() {
    try {
      const d = await call('/api/mev/log'); const s = d.stats;
      const pct = (x) => (x == null ? '—' : x.toFixed(1) + '%');
      Q('#swStats').innerHTML = `<div class="stats"><div><span class="muted small">fills checked</span><b>${s.filled}</b></div><div><span class="muted small">suspected sandwiches</span><b class="${s.suspected ? 'bad' : ''}">${s.suspected}</b></div><div><span class="muted small">% of trades</span><b>${pct(s.pctSuspected)}</b></div><div><span class="muted small">$ lost (est.)</span><b>${usd(s.lostUsd)}</b></div><div><span class="muted small">private: suspected / trades</span><b>${s.private.suspected}/${s.private.trades}</b></div><div><span class="muted small">public: suspected / trades</span><b>${s.public.suspected}/${s.public.trades}</b></div></div>`;
      Q('#swLog').innerHTML = d.trades.length ? `<table><tr><th>time</th><th>pair</th><th>size</th><th>route</th><th>quoted</th><th>fill</th><th>shortfall</th><th>$ lost</th><th>bracket</th><th>status</th><th>tx</th></tr>${d.trades.map((t) => `<tr class="${t.suspected ? 'bad' : ''}"><td>${new Date(t.blockTime || t.submittedAt).toLocaleString()}</td><td>${E(sh(t.quote.inputMint))}→${E(sh(t.quote.outputMint))}</td><td>${num(t.quote.inUi)} (${usd(t.quote.inUsd)})</td><td>${E(t.route)}</td><td>${num(t.quote.quotedPrice, 8)}</td><td>${num(t.fillPrice, 8)}</td><td>${t.shortfallPct == null ? '—' : t.shortfallPct.toFixed(2) + '%'}</td><td>${t.lostUsd ? usd(t.lostUsd) : '—'}</td><td>${t.bracket?.bracketed ? 'YES ' + E(sh(t.bracket.hits[0].attacker)) : t.bracket?.checked ? 'no' : '—'}</td><td>${E(t.status)}${t.suspected ? ' ⚠' : ''}</td><td><a href="https://solscan.io/tx/${E(t.signature)}" target="_blank" rel="noopener">${E(sh(t.signature))}</a></td></tr>`).join('')}</table>`
        : `<div class="empty small">No trades have been executed through the terminal yet, so there is nothing to check. Every swap you sign here is logged with quoted vs fill price, shortfall beyond the ${d.settings.tolerancePct}% tolerance (separate from the quote's own price impact / slippage), $ lost, route (private/public) and a same-slot front-run/back-run check. Stored in ${E(d.file)}.</div>`;
    } catch (e) { Q('#swLog').innerHTML = `<div class="bad small">${E(e.message)}</div>`; }
  }
  Q('#swTolSave').onclick = async () => { try { await call('/api/mev/settings', { tolerancePct: +Q('#swTol').value }); loadLog(); } catch (e) { alert(e.message); } };

  // ---------- audit ----------
  Q('#swAudGo').onclick = async () => {
    const a = Q('#swAudAddr').value.trim(); if (!a) return;
    Q('#swAudOut').innerHTML = '<div class="empty"><span class="spin"></span> starting…</div>';
    try {
      let j = await call(`/api/mev/audit?address=${encodeURIComponent(a)}&limit=${Q('#swAudN').value}`);
      while (j.status === 'running') { Q('#swAudOut').innerHTML = `<div class="empty"><span class="spin"></span> ${E(j.progress)} · swaps found ${j.swaps.length}</div>`; await new Promise((r) => setTimeout(r, 2500)); j = await call('/api/mev/audit?job=' + j.id); }
      if (j.status === 'error') throw new Error(j.error);
      const s = j.summary;
      Q('#swAudOut').innerHTML = `<div class="card2">Scanned ${j.scanned} recent txs signed by ${E(sh(j.address))}: <b>${s.swapsFound}</b> swaps, <b class="${s.suspected ? 'bad' : 'ok'}">${s.suspected}</b> suspected sandwiches (${s.pct == null ? '—' : s.pct.toFixed(0)}%), ${s.weak} loose brackets (same-slot opposite trades by one wallet, not adjacent/profitable), est. lost ${usd(s.estLostUsd)} · blocks checked ${s.blocksChecked}. <span class="muted">Only same-slot brackets are detectable here; multi-slot or multi-wallet sandwiches can be missed.</span></div>
        ${j.swaps.length ? `<table><tr><th>time</th><th>sold</th><th>bought</th><th>verdict</th><th>tx</th></tr>${j.swaps.map((x) => { const h = x.bracket?.hits?.[0]; return `<tr class="${x.suspected ? 'bad' : ''}"><td>${x.time ? new Date(x.time).toLocaleString() : '—'}</td><td>${num(x.inUi)} ${E(sh(x.inMint))}</td><td>${num(x.outUi)} ${E(sh(x.outMint))}</td><td>${x.suspected ? `SANDWICH? by ${E(sh(h.attacker))} (front ${h.frontOffset}, back +${h.backOffset})${x.estLostUsd ? ' ~' + usd(x.estLostUsd) : ''}` : x.bracket?.weakBracket ? 'loose bracket' : x.bracket?.checked ? 'clean' : E(x.bracket?.reason || '—')}</td><td><a href="https://solscan.io/tx/${E(x.signature)}" target="_blank" rel="noopener">${E(sh(x.signature))}</a></td></tr>`; }).join('')}</table>` : ''}`;
    } catch (e) { Q('#swAudOut').innerHTML = `<div class="bad small">${E(e.message)}</div>`; }
  };

  // ---------- nav + lazy load ----------
  const nav = Q('#viewNav'); if (nav && !nav.querySelector('[data-v=swap]')) { const b = document.createElement('button'); b.dataset.v = 'swap'; b.textContent = 'Swap'; nav.appendChild(b); }
  let loaded = false;
  function onView() { if (document.body.dataset.view === 'swap' && !loaded) { loaded = true; loadCfg(); loadLog(); } }
  new MutationObserver(onView).observe(document.body, { attributes: true, attributeFilter: ['data-view'] }); onView();
  // prefill output with the token selected in the Terminal (if any)
  window.swapPrefill = (mint) => { Q('#swOut').value = mint; syncPre(); };
})();
