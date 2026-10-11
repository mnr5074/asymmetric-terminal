// ASYMMETRIC·TERMINAL: Tax desk (private). Wallet history + CEX CSV import -> tax lots (FIFO/LIFO/HIFO), wash sales,
// harvesting ideas, Form 8949 CSV + PDF export, federal estimate (Nevada: no state income tax). Estimates, not tax advice.
'use strict';
(function () {
  const Q = (s, r = document) => r.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const qf = (q) => (q == null ? '—' : q >= 1000 ? q.toLocaleString('en-US', { maximumFractionDigits: 2 }) : q >= 1 ? (+q.toFixed(4)).toString() : (+q.toPrecision(4)).toString());
  const cls = (v) => (v < 0 ? 'dn' : v > 0 ? 'up' : '');
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const css = `body[data-view=tax] main.grid{display:none}body[data-view=tax] #viewTax{display:flex}
#viewTax .panel{flex:1}#taxBody{padding:8px;overflow:auto;flex:1;min-height:0}
.txbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line);background:#0b1018}
.txbar label{display:flex;gap:4px;align-items:center;color:#9aa6b8;font-size:11px}.txbar input,.txbar select{width:auto}
.txcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin:6px 0}
.txcard{background:#0f1622;border:1px solid var(--line);border-radius:5px;padding:7px}.txcard b{display:block;font-size:16px;margin-top:3px}
.txnote{border:1px solid #6b4e16;background:#1e1708;color:#f3d38a;border-radius:5px;padding:6px 8px;margin:6px 0;font-size:11px;line-height:1.45}
.txnote.red{border-color:#6b1d1d;background:#1e0c0c;color:#ffb4b4}.txnote.ok{border-color:#1d5b3a;background:#0b1a12;color:#a7f3c9}
.txex{background:#f59e0b;color:#111;font-weight:800;padding:2px 8px;border-radius:3px;letter-spacing:.5px}
.txgrid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}@media(max-width:900px){.txgrid2{grid-template-columns:1fr}}
#taxBody textarea{width:100%;min-height:70px;background:#0a0e14;border:1px solid var(--line);color:var(--txt);font:inherit;padding:6px;border-radius:4px}
#taxBody h3{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#fff;margin:12px 0 4px}
#taxBody table.tbl td,#taxBody table.tbl th{white-space:nowrap}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  let TAB = 'summary', DATA = null, STATE = null, EXAMPLE = false, LAW = null;
  async function j(path, body) {
    const h = { 'content-type': 'application/json' }; const rpc = localStorage.getItem('st.rpc.v1'); if (rpc) h['x-rpc-url'] = rpc;
    const r = await fetch(path, body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
    const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d;
  }
  function shell() {
    const root = Q('#taxRoot'); if (root.dataset.ready) return; root.dataset.ready = 1;
    root.innerHTML = `<div class="panel"><div class="phead"><h2>Tax desk</h2><span class="muted small">private · your data stays in data/tax on this server · federal estimate (Nevada: no state income tax) · not tax advice</span>
      <div class="tabs" id="taxTabs" style="margin-left:auto">${['summary', 'sources', 'ledger', '8949', 'wash', 'harvest', 'law'].map((t) => `<button data-t="${t}">${{ summary: 'Summary', sources: 'Wallets & CSV', ledger: 'Ledger', 8949: 'Form 8949', wash: 'Wash sales', harvest: 'Harvest', law: 'Law & rates' }[t]}</button>`).join('')}</div></div>
      <div class="txbar" id="taxBar">
        <label>Year <select id="txYear"><option>2026</option><option>2025</option></select></label>
        <label>Filing <select id="txFS"><option value="single">Single</option><option value="mfj">Married joint</option><option value="mfs">Married separate</option><option value="hoh">Head of household</option></select></label>
        <label>Other income $ <input id="txInc" type="number" style="width:90px" title="W-2 wages and other ordinary income"></label>
        <label>Lots <select id="txMethod"><option>FIFO</option><option>LIFO</option><option>HIFO</option></select></label>
        <label>Basis <select id="txScope"><option value="wallet">per wallet (2025+ rule)</option><option value="universal">universal</option></select></label>
        <label title="IRC 1091 always applies to stocks/options/tokenized securities. For crypto it is NOT current law.">Apply wash-sale rule to crypto <select id="txWash"><option value="off">off (current law)</option><option value="hr10357">pending bill H.R.10357 scenario</option><option value="on">on (all dates)</option></select></label>
        <label>ST c/o $ <input id="txSTC" type="number" style="width:70px"></label><label>LT c/o $ <input id="txLTC" type="number" style="width:70px"></label>
        <button class="btn mini2" id="txSave">Save &amp; recompute</button>
        <span style="margin-left:auto;display:flex;gap:6px"><button class="btn ghost mini2" id="txExample" title="Fictional demo data, not stored">Load EXAMPLE</button>
        <a class="btn ghost mini2" id="txCsv" href="/api/tax/export.csv">8949 CSV</a><a class="btn ghost mini2" id="txPdf" href="/api/tax/export.pdf">PDF report</a></span>
      </div><div id="taxBody"><div class="empty">Loading…</div></div></div>`;
    Q('#taxTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (b) { TAB = b.dataset.t; render(); } });
    Q('#txSave').onclick = saveSettings;
    Q('#txExample').onclick = () => { EXAMPLE = !EXAMPLE; load(); };
  }
  function fillBar(s) {
    Q('#txYear').value = s.year; Q('#txFS').value = s.filingStatus; Q('#txInc').value = s.otherIncome; Q('#txMethod').value = s.method; Q('#txScope').value = s.scope; Q('#txWash').value = s.washCrypto; Q('#txSTC').value = s.stCarryover; Q('#txLTC').value = s.ltCarryover;
    Q('#txExample').textContent = EXAMPLE ? 'Back to my ledger' : 'Load EXAMPLE';
    Q('#txCsv').href = EXAMPLE ? '/api/tax/sample.csv' : '/api/tax/export.csv?year=' + s.year; Q('#txPdf').href = EXAMPLE ? '/api/tax/sample.pdf' : '/api/tax/export.pdf?year=' + s.year;
    Q('#txSave').disabled = EXAMPLE;
  }
  async function saveSettings() {
    try { await j('/api/tax/settings', { year: +Q('#txYear').value, filingStatus: Q('#txFS').value, otherIncome: +Q('#txInc').value || 0, method: Q('#txMethod').value, scope: Q('#txScope').value, washCrypto: Q('#txWash').value, stCarryover: +Q('#txSTC').value || 0, ltCarryover: +Q('#txLTC').value || 0 }); load(); } catch (e) { alert(e.message); }
  }
  async function load() {
    shell(); const body = Q('#taxBody'); body.innerHTML = '<div class="empty">Computing…</div>';
    try {
      if (!LAW) LAW = await j('/api/tax/law').catch(() => null);
      if (EXAMPLE) { DATA = await j('/api/tax/sample'); STATE = { settings: DATA.settings, wallets: [], events: [], eventCount: 0, imports: [] }; }
      else { STATE = await j('/api/tax/state'); DATA = await j('/api/tax/compute?year=' + STATE.settings.year); }
      fillBar(STATE.settings); render();
    } catch (e) { body.innerHTML = `<div class="txnote red">${E(e.message)}</div>`; }
  }
  function banner() { return EXAMPLE ? `<div class="txnote"><span class="txex">EXAMPLE DATA</span> Fictional trades for demonstration only, not your ledger and not saved. Click "Back to my ledger" to return.</div>` : ''; }
  function washBanner() {
    const m = DATA.washMode;
    return `<div class="txnote ${m === 'off' ? '' : 'red'}"><b>Wash-sale rule (IRC 1091):</b> applied to stocks, options and tokenized securities always. For crypto: <b>${m === 'off' ? 'OFF (current law: crypto is property, not a security)' : m === 'hr10357' ? 'PENDING-BILL SCENARIO (H.R. 10357, crypto loss sales after 2026-09-14)' : 'ON for all crypto (override; not current law)'}</b>.
      H.R. 10357 passed House Ways &amp; Means 9/16/2026 but is <b>not law</b>; as reported it would apply to digital-asset sales after 9/14/2026.${DATA.exposure?.amount ? ` <b>Your exposure if enacted: ${$(DATA.exposure.amount, 2)}</b> of crypto losses would be deferred (${DATA.exposure.sales.length} sale(s)).` : ''}</div>`;
  }
  function render() {
    document.querySelectorAll('#taxTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === TAB));
    const body = Q('#taxBody'); if (!DATA) return;
    body.innerHTML = banner() + ({ summary, sources, ledger, 8949: f8949, wash, harvest, law }[TAB])();
    if (TAB === 'sources') bindSources(); if (TAB === 'harvest') loadHarvest(); if (TAB === 'ledger') bindLedger();
  }
  function summary() {
    const S = DATA.summary, X = DATA.estimate;
    const c = (k, v, color = true) => `<div class="txcard"><span class="muted small">${k}</span><b class="${color ? cls(v) : ''}">${$(v)}</b></div>`;
    return `${washBanner()}<div class="txcards">${c('Net short-term', S.st.net)}${c('Net long-term', S.lt.net)}${c('Net capital gain/loss', S.netTotal)}${c('Wash-sale disallowed', S.washDisallowed, false)}${c('Ordinary income (staking/airdrops)', S.income, false)}${c('Est. federal tax', X.totalFederal, false)}${c('Tax from trading', X.incrementalFromTrading, false)}${c('Nevada state tax', 0, false)}</div>
      <div class="txgrid2"><div><h3>Netting &amp; carryforward (${S.year})</h3><table class="tbl"><tbody>
        <tr><td>ST gains / losses</td><td class="r up">${$(S.st.gains)}</td><td class="r dn">${$(S.st.losses)}</td></tr><tr><td>LT gains / losses</td><td class="r up">${$(S.lt.gains)}</td><td class="r dn">${$(S.lt.losses)}</td></tr>
        <tr><td>Net ST / LT after carryover</td><td class="r">${$(X.netting.netST)}</td><td class="r">${$(X.netting.netLT)}</td></tr>
        <tr><td>Loss deducted vs ordinary income (cap $${X.netting.limit.toLocaleString()})</td><td class="r" colspan="2">${$(-X.netting.deductibleLoss)}</td></tr>
        <tr><td>Carryforward to ${S.year + 1} (ST / LT)</td><td class="r">${$(X.netting.carry.st)}</td><td class="r">${$(X.netting.carry.lt)}</td></tr>
        <tr><td>Disposals (8949 lines)</td><td class="r" colspan="2">${S.count}</td></tr></tbody></table></div>
      <div><h3>Federal estimate (${E(X.filingStatusLabel)})</h3><table class="tbl"><tbody>
        <tr><td>AGI (approx.)</td><td class="r">${$(X.agi)}</td></tr><tr><td>Deduction (standard ${$(X.standardDeduction)})</td><td class="r">${$(-X.deductionUsed)}</td></tr><tr><td>Taxable income</td><td class="r">${$(X.taxableIncome)}</td></tr>
        <tr><td>Ordinary tax (marginal ${(X.marginalOrdinary * 100).toFixed(0)}%)</td><td class="r">${$(X.ordinaryTax)}</td></tr><tr><td>LTCG tax (0%: ${$(X.ltcgBands.at0)} · 15%: ${$(X.ltcgBands.at15)} · 20%: ${$(X.ltcgBands.at20)})</td><td class="r">${$(X.capitalGainsTax)}</td></tr>
        <tr><td>NIIT 3.8%</td><td class="r">${$(X.niit)}</td></tr><tr><td><b>Total federal</b> (without trading: ${$(X.baselineWithoutCrypto)})</td><td class="r"><b>${$(X.totalFederal)}</b></td></tr><tr><td>Nevada</td><td class="r">$0</td></tr></tbody></table>
        <div class="muted small">${E(X.source)}. ${E(X.niitNote)}</div></div></div>
      <h3>Review (${DATA.reviewCount})</h3>${DATA.review.length ? `<div class="small">${DATA.review.slice(0, 40).map((r) => `<div>• ${E(r.msg)}</div>`).join('')}</div>` : '<div class="muted small">Nothing to review.</div>'}
      <h3>Holdings by account</h3>${holdTable(DATA.holdings)}
      <div class="muted small" style="margin-top:8px">${E(X.caveats.join(' '))}</div>`;
  }
  const holdTable = (H) => `<div class="tablewrap"><table class="tbl"><thead><tr><th>Account</th><th>Asset</th><th>Class</th><th class="r">Qty</th><th class="r">Basis</th><th class="r">Wash adj.</th><th>Lots</th><th></th></tr></thead><tbody>${H.slice(0, 200).map((h) => `<tr><td>${E(h.account)}</td><td>${E(h.asset)}</td><td>${E(h.cls)}</td><td class="r">${qf(h.qty)}</td><td class="r">${$(h.cost)}</td><td class="r">${h.washAdj ? $(h.washAdj) : ''}</td><td>${h.lots}</td><td>${h.unknownBasis ? '<span class="chip r">basis unknown</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  function sources() {
    if (EXAMPLE) return '<div class="muted">Sources are disabled while viewing EXAMPLE data.</div>';
    const W = STATE.wallets;
    return `<div class="txgrid2"><div><h3>1. Wallet addresses (public, read-only)</h3>
      <textarea id="txAddrs" placeholder="Paste Solana and/or EVM (0x…) addresses, one per line. EVM addresses are scanned on the chains you tick."></textarea>
      <div class="row small" style="gap:8px;flex-wrap:wrap">${['ethereum', 'base', 'arbitrum', 'bsc', 'optimism', 'polygon', 'avalanche'].map((c) => `<label><input type="checkbox" class="txch" value="${c}" ${['ethereum', 'base', 'arbitrum', 'bsc'].includes(c) ? 'checked' : ''} style="width:auto"> ${c}</label>`).join('')}</div>
      <div class="row"><input id="txLabel" placeholder="label (optional)"><button class="btn" id="txAdd">Add</button></div>
      <table class="tbl"><thead><tr><th>Address</th><th>Chains</th><th>Synced</th><th></th></tr></thead><tbody>${W.map((w) => `<tr><td title="${E(w.address)}">${E(w.label ? w.label + ' · ' : '')}${E(w.address.slice(0, 6) + '…' + w.address.slice(-4))}</td><td>${E(w.chains.join(', '))}</td><td>${w.syncedAt ? day(w.syncedAt) : '—'}</td><td><button class="btn ghost mini2 txrm" data-a="${E(w.address)}">remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No wallets yet.</td></tr>'}</tbody></table>
      <div class="row"><label class="small">max tx / wallet <input id="txMax" type="number" value="300" style="width:80px"></label><button class="btn" id="txSync" ${W.length ? '' : 'disabled'}>Pull history + prices</button><button class="btn ghost" id="txFill">Fill missing prices (${STATE.missingUsd})</button></div>
      <div id="txJob" class="small"></div>
      <div class="muted small">Solana: public RPC getSignaturesForAddress/getTransaction, swaps parsed from balance deltas${STATE.heliusKey ? ' (Helius key detected in env)' : ''}. EVM: ${STATE.etherscanKey ? 'Etherscan V2 (free key) then ' : ''}Blockscout / Routescan keyless APIs. Etherscan's free tier no longer covers Base/BSC/OP; if a chain fails, use the explorer's "Download CSV" and import it on the right as Explorer CSV. Prices: Coinbase / Binance public candles, CoinGecko free, GeckoTerminal.</div></div>
      <div><h3>2. Exchange / broker CSV</h3>
      <div class="row"><select id="txFmt" class="mini"><option value="auto">Auto-detect</option><option value="coinbase">Coinbase transaction history</option><option value="kraken_ledgers">Kraken ledgers.csv</option><option value="kraken_trades">Kraken trades.csv</option><option value="binanceus_tax">Binance.US tax/transaction history</option><option value="binanceus_trades">Binance.US trade history</option><option value="explorer_native">Explorer CSV: transactions (Etherscan/BaseScan/BscScan)</option><option value="explorer_tokens">Explorer CSV: token transfers</option><option value="generic">Generic (map columns)</option></select>
        <input id="txAcct" placeholder="account name (e.g. coinbase, kraken, robinhood)"></div>
      <div class="row hidden" id="txExplorerRow"><input id="txOwner" placeholder="wallet address the explorer CSV is for (0x…)"><select id="txChain" class="mini">${['ethereum', 'base', 'bsc', 'arbitrum', 'optimism', 'polygon', 'avalanche'].map((c) => `<option>${c}</option>`).join('')}</select></div>
      <input type="file" id="txFile" accept=".csv,text/csv" style="width:100%">
      <div class="row hidden" id="txMapRow"><input id="txMap" placeholder='generic mapping JSON, e.g. {"date":"Time","type":"Side","asset":"Symbol","qty":"Qty","usd":"Value","cls":"Class"}'></div>
      <div class="row"><button class="btn ghost" id="txPrev">Preview</button><button class="btn" id="txImp">Import</button></div>
      <div id="txImpOut" class="small"></div>
      <div class="muted small">Re-importing the same file is safe (duplicates skipped). Transfers between your own wallets/exchanges are matched automatically (same tx hash, or same asset and amount within 2% inside 72 h) so they are not counted as sales. Generic types: buy, sell, trade/swap, deposit, withdrawal, staking/airdrop/reward/income, spend. Set a "class" column to stock / option / tokenized_security for brokerage rows (wash-sale always applies to those).</div>
      <h3>Recent imports</h3><div class="small">${(STATE.imports || []).slice().reverse().slice(0, 12).map((i) => `<div>${day(i.at)} · ${E(i.kind)} ${E(i.format || i.chain || '')} ${E(i.account || i.address || '')}: +${i.added}</div>`).join('') || '<span class="muted">none</span>'}</div>
      <div class="row" style="margin-top:12px"><button class="btn ghost mini2" id="txWipe" style="border-color:#7f1d1d;color:#fca5a5">Wipe private ledger…</button></div></div></div>`;
  }
  function bindSources() {
    if (EXAMPLE) return;
    Q('#txAdd').onclick = async () => { try { const chains = [...document.querySelectorAll('.txch:checked')].map((x) => x.value); const r = await j('/api/tax/wallets', { addresses: Q('#txAddrs').value, label: Q('#txLabel').value, chains }); STATE.wallets = r.wallets; render(); } catch (e) { alert(e.message); } };
    document.querySelectorAll('.txrm').forEach((b) => (b.onclick = async () => { const r = await j('/api/tax/wallets', { remove: [b.dataset.a] }); STATE.wallets = r.wallets; render(); }));
    const poll = async (id) => { const out = Q('#txJob'); for (;;) { const s = await j('/api/tax/sync/status?job=' + id).catch((e) => ({ status: 'error', error: e.message })); if (!Q('#txJob')) return; out.innerHTML = s.status === 'running' ? `⏳ ${E(s.progress)}` : s.status === 'error' ? `<span class="dn">${E(s.error)}</span>` : `<pre style="white-space:pre-wrap">${E(JSON.stringify(s.result, null, 1))}</pre>`; if (s.status !== 'running') { if (s.status === 'done') { STATE = await j('/api/tax/state'); DATA = await j('/api/tax/compute?year=' + STATE.settings.year); } return; } await new Promise((r) => setTimeout(r, 2500)); } };
    Q('#txSync').onclick = async () => { try { const r = await j('/api/tax/sync', { max: +Q('#txMax').value || 300 }); poll(r.job); } catch (e) { alert(e.message); } };
    Q('#txFill').onclick = async () => { const r = await j('/api/tax/fillprices', { budget: 400 }); poll(r.job); };
    const fmt = Q('#txFmt'); fmt.onchange = () => { Q('#txExplorerRow').classList.toggle('hidden', !fmt.value.startsWith('explorer')); Q('#txMapRow').classList.toggle('hidden', fmt.value !== 'generic'); };
    const send = async (preview) => {
      const f = Q('#txFile').files[0]; if (!f) return alert('Choose a CSV file');
      let mapping; try { mapping = Q('#txMap').value ? JSON.parse(Q('#txMap').value) : undefined; } catch { return alert('mapping must be JSON'); }
      try { const r = await j('/api/tax/import', { csv: await f.text(), filename: f.name, format: fmt.value, account: Q('#txAcct').value || undefined, owner: Q('#txOwner').value || undefined, chain: Q('#txChain').value, mapping, preview });
        Q('#txImpOut').innerHTML = preview ? `Detected <b>${E(r.format)}</b>: ${r.count} events.${r.mapped ? ' Columns: ' + E(JSON.stringify(r.mapped)) : ''}<br>${r.sample.map((e) => `${day(e.ts)} ${E(e.type)} ${e.out ? '-' + qf(e.out.qty) + ' ' + E(e.out.asset) : ''} ${e.in ? '+' + qf(e.in.qty) + ' ' + E(e.in.asset) : ''} ${e.usd != null ? $(e.usd, 2) : ''}`).join('<br>')}${r.warnings.length ? '<br><span class="muted">' + r.warnings.map(E).join('<br>') + '</span>' : ''}`
          : `<span class="up">Imported ${r.added} new events (${r.duplicates} duplicates) from ${E(r.format)}; ${r.transfersMatched} internal transfers matched.</span>${r.warnings.length ? '<br><span class="muted">' + r.warnings.map(E).join('<br>') + '</span>' : ''}`;
        if (!preview) { STATE = await j('/api/tax/state'); DATA = await j('/api/tax/compute?year=' + STATE.settings.year); }
      } catch (e) { Q('#txImpOut').innerHTML = `<span class="dn">${E(e.message)}</span>`; }
    };
    Q('#txPrev').onclick = () => send(true); Q('#txImp').onclick = () => send(false);
    Q('#txWipe').onclick = async () => { if (prompt('Type DELETE to wipe your private tax ledger (wallet list, imports and overrides; settings kept).') === 'DELETE') { await j('/api/tax/reset', { confirm: 'DELETE' }); load(); } };
  }
  function ledger() {
    if (EXAMPLE) return '<div class="muted">The EXAMPLE ledger is shown in the Form 8949 and Wash sales tabs.</div>';
    const ev = STATE.events;
    return `<div class="muted small">${STATE.eventCount} events (latest 400 shown). Reclassify an event if it was misread, e.g. an unmatched deposit that was really an airdrop (income) or a transfer to someone else (spend).</div>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Account</th><th>Out</th><th>In</th><th class="r">USD</th><th>Match</th><th>Note</th><th>Fix</th></tr></thead><tbody>${ev.map((e) => `<tr><td>${day(e.ts)}</td><td>${E(e.override?.type || e.type)}${e.override ? ' *' : ''}</td><td title="${E(e.account)}">${E(String(e.account).slice(0, 22))}</td><td>${e.out ? qf(e.out.qty) + ' ' + E(e.out.asset) : ''}</td><td>${e.in ? qf(e.in.qty) + ' ' + E(e.in.asset) : ''}</td><td class="r">${e.usd != null ? $(e.usd, 2) : '<span class="dn">?</span>'}</td><td>${e.match ? '↔ ' + E(e.matchBy || '') : ''}</td><td class="muted" title="${E(e.priceSource || '')}">${E(String(e.note || '').slice(0, 40))}</td>
        <td><select class="mini txov" data-id="${E(e.id)}"><option value="">—</option><option value="income">→ income (airdrop/reward)</option><option value="spend">→ spend (disposal)</option><option value="ignore">ignore (spam)</option><option value="usd">set USD value…</option><option value="basis">set basis (deposit)…</option><option value="clear">clear override</option></select></td></tr>`).join('')}</tbody></table></div>`;
  }
  function bindLedger() {
    document.querySelectorAll('.txov').forEach((s) => (s.onchange = async () => {
      const id = s.dataset.id, v = s.value; const b = { id };
      if (v === 'income') { b.type = 'income'; b.incomeKind = 'airdrop'; } else if (v === 'spend') b.type = 'spend'; else if (v === 'ignore') b.ignore = true; else if (v === 'clear') b.clear = true;
      else if (v === 'usd' || v === 'basis') { const x = prompt(v === 'usd' ? 'USD fair market value of this event' : 'Total USD cost basis of these coins'); if (x == null) return; b[v] = +x; if (v === 'basis') { const a = prompt('Original acquisition date (YYYY-MM-DD), blank = deposit date'); if (a) b.acquired = a; } }
      try { await j('/api/tax/override', b); STATE = await j('/api/tax/state'); DATA = await j('/api/tax/compute?year=' + STATE.settings.year); render(); } catch (e) { alert(e.message); }
    }));
  }
  function f8949() {
    const R = DATA.rows; const part = (t) => R.filter((r) => r.term === t);
    const tbl = (rows) => `<div class="tablewrap"><table class="tbl"><thead><tr><th>(a) Description</th><th>(b) Acquired</th><th>(c) Sold</th><th class="r">(d) Proceeds</th><th class="r">(e) Basis</th><th>(f)</th><th class="r">(g) Adj.</th><th class="r">(h) Gain/loss</th><th>Box</th><th>Account</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${E(r.description)}</td><td>${E(r.acquired)}</td><td>${E(r.sold)}</td><td class="r">${$(r.proceeds, 2)}</td><td class="r">${$(r.cost, 2)}</td><td class="${r.code ? 'dn' : ''}">${E(r.code)}</td><td class="r">${r.adj ? $(r.adj, 2) : ''}</td><td class="r ${cls(r.gain)}">${$(r.gain, 2)}</td><td>${E(r.box)}</td><td title="${E(r.account)}">${E(String(r.account).slice(0, 20))}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">none</td></tr>'}</tbody></table></div>`;
    return `<div class="muted small">Boxes: digital assets G/H/I (short) and J/K/L (long) on 2025+ Form 8949 (I/L = no 1099-DA, typical for DEX/self-custody); securities A–F. Verify against your 1099-DA / 1099-B. Code W = wash sale.</div>
      <h3>Part I: short-term (${part('Short-term').length})</h3>${tbl(part('Short-term'))}<h3>Part II: long-term (${part('Long-term').length})</h3>${tbl(part('Long-term'))}
      <h3>Ordinary income at FMV</h3><table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Asset</th><th class="r">Qty</th><th class="r">FMV = income + basis</th><th>Account</th></tr></thead><tbody>${DATA.income.map((i) => `<tr><td>${i.date}</td><td>${E(i.kind)}</td><td>${E(i.asset)}</td><td class="r">${qf(i.qty)}</td><td class="r">${$(i.usd, 2)}</td><td>${E(i.account)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">none</td></tr>'}</tbody></table>`;
  }
  function wash() {
    const W = DATA.washSales;
    return `${washBanner()}<table class="tbl"><thead><tr><th>Asset</th><th>Class</th><th>Loss sale</th><th class="r">Qty</th><th class="r">Loss</th><th>Replacement</th><th class="r">Repl. qty</th><th class="r">Disallowed</th><th>Timing</th><th>Rule</th></tr></thead><tbody>${W.map((w) => `<tr><td>${E(w.asset)}</td><td>${E(w.cls)}</td><td>${w.sold}</td><td class="r">${qf(w.qtySold)}</td><td class="r dn">${$(-w.loss, 2)}</td><td>${w.rebought}</td><td class="r">${qf(w.replacementQty)}</td><td class="r">${$(w.disallowed, 2)}</td><td class="muted">${E(w.timing)}</td><td class="muted">${E(w.rule)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No wash sales under the current settings.</td></tr>'}</tbody></table>
      ${DATA.exposure?.sales?.length ? `<h3>Pending-bill exposure (H.R. 10357 scenario)</h3><table class="tbl"><thead><tr><th>Asset</th><th>Loss sale</th><th>Repurchase</th><th class="r">Qty</th><th class="r">Would be deferred</th></tr></thead><tbody>${DATA.exposure.sales.map((s) => `<tr><td>${E(s.asset)}</td><td>${s.sold}</td><td>${s.rebought}</td><td class="r">${qf(s.qty)}</td><td class="r">${$(s.deferred, 2)}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="muted small">A disallowed loss is not lost: it is added to the replacement lot's basis and the holding period carries over. Substantially identical: same symbol; for securities the stock, its options and tokenized versions are grouped (conservative). Under H.R. 10357, wrapped/tokenized equivalents of a coin would also count.</div>`;
  }
  function harvest() { return `<div id="txHv"><div class="empty">Pricing open positions (Coinbase / Binance public tickers${EXAMPLE ? '' : ', portfolio module for wallet tokens'})…</div></div>`; }
  async function loadHarvest() {
    try {
      const h = EXAMPLE ? DATA.harvest : await j('/api/tax/harvest?year=' + STATE.settings.year); const box = Q('#txHv'); if (!box) return;
      box.innerHTML = `<div class="txnote ok">Nevada resident: no state income tax, so every number here is federal only. Realized net ${h.year} so far: <b>${$(h.realizedNet)}</b>. Harvest target (net gains + $3,000 ordinary offset): <b>${$(h.target)}</b>. Unrealized losses available: ${$(h.harvestable)}. Estimated federal tax ${$(h.estimatedTaxBefore)} → ${$(h.estimatedTaxAfter)} (<b>saves ${$(h.estimatedSavings)}</b>).</div>
        <table class="tbl"><thead><tr><th>Asset</th><th>Class</th><th>Term</th><th>Account</th><th class="r">Qty</th><th class="r">Basis</th><th class="r">Value</th><th class="r">Unrealized</th><th class="r">Tax saved</th></tr></thead><tbody>${h.picks.map((p) => `<tr><td>${E(p.asset)}</td><td>${E(p.cls)}</td><td>${p.term}</td><td title="${E(p.account)}">${E(String(p.account).slice(0, 18))}</td><td class="r">${qf(p.qty)}</td><td class="r">${$(p.cost)}</td><td class="r">${$(p.value)}</td><td class="r dn">${$(p.unrealized)}</td><td class="r up">${$(p.taxSaved)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No open positions with unrealized losses (or no prices).</td></tr>'}</tbody></table>
        ${[...new Set(h.picks.map((p) => p.washNote))].map((n) => `<div class="txnote red">${E(n)}</div>`).join('')}
        ${h.worthless?.length ? `<h3>Near-zero / rug-pulled positions</h3>${h.worthless.map((w) => `<div class="txnote red"><b>${E(w.asset)}</b> (${E(w.account)}): basis ${$(w.cost)}, worth ${$(w.value, 2)}. ${E(w.note)}</div>`).join('')}` : ''}
        ${h.missingPrices?.length ? `<div class="muted small">No live price for: ${h.missingPrices.map(E).join(', ')} (stocks/options need a manual price: /api/tax/harvest?prices={"TSLA":250}).</div>` : ''}
        ${h.reconcile?.length ? `<h3>Ledger vs on-chain balance mismatches</h3><table class="tbl"><thead><tr><th>Account</th><th>Asset</th><th class="r">On-chain</th><th class="r">Ledger</th></tr></thead><tbody>${h.reconcile.map((r) => `<tr><td>${E(r.account.slice(0, 24))}</td><td>${E(r.asset)}</td><td class="r">${qf(r.onchain)}</td><td class="r">${qf(r.ledger)}</td></tr>`).join('')}</tbody></table><div class="muted small">Differences usually mean history beyond the sync limit, or a missing CSV.</div>` : ''}
        <div class="muted small">${h.notes.map(E).join(' ')}</div>`;
    } catch (e) { const box = Q('#txHv'); if (box) box.innerHTML = `<div class="txnote red">${E(e.message)}</div>`; }
  }
  function law() {
    if (!LAW) return '<div class="muted">Law notes unavailable.</div>';
    const t = LAW.tables[2026];
    const br = (s) => t.brackets[s].map(([hi, r], i, a) => `${(r * 100).toFixed(0)}% ${i ? 'over $' + a[i - 1][0].toLocaleString() : ''}${hi ? (i ? ' to ' : 'up to ') + '$' + hi.toLocaleString() : ''}`).join(' · ');
    return `<div class="txnote"><b>Crypto wash sales (as of ${E(LAW.asOf)}):</b> ${E(LAW.washCurrent)}<br>${E(LAW.washPending)}</div>
      <div class="txnote red"><b>Worthless / rug-pulled tokens:</b> holding or abandoning gives an investor no deduction under current law (IRS CCA 202302011 treats it as a miscellaneous itemized deduction; OBBBA sec. 70110 made that suspension permanent). A documented real sale to an unrelated party (even for a fraction of a cent) produces a capital loss. Have your tax pro review.</div>
      <h3>2026 federal brackets (${E(t.source)})</h3><table class="tbl"><tbody>${Object.entries(LAW.statuses).map(([k, v]) => `<tr><td>${E(v)}</td><td class="small">${br(k)}</td></tr>`).join('')}</tbody></table>
      <h3>2026 long-term capital gains / qualified dividends</h3><table class="tbl"><thead><tr><th>Status</th><th class="r">0% up to</th><th class="r">15% up to</th><th>20%</th><th class="r">Std. deduction</th><th class="r">NIIT threshold</th></tr></thead><tbody>${Object.entries(LAW.statuses).map(([k, v]) => `<tr><td>${E(v)}</td><td class="r">$${t.ltcg[k][0].toLocaleString()}</td><td class="r">$${t.ltcg[k][1].toLocaleString()}</td><td>above</td><td class="r">$${t.stdDeduction[k].toLocaleString()}</td><td class="r">$${LAW.niit.threshold[k].toLocaleString()}</td></tr>`).join('')}</tbody></table>
      <div class="muted small">Capital loss limit $3,000 ($1,500 MFS), unlimited carryforward keeping ST/LT character. NIIT 3.8% (not indexed). Nevada: no state income tax.</div>
      <h3>Optional paid tools (not integrated)</h3><table class="tbl"><tbody>${LAW.optionalPaid.map((p) => `<tr><td>${E(p.name)}</td><td>${E(p.cost)}</td></tr>`).join('')}</tbody></table><div class="muted small">${E(LAW.note)}</div>
      <h3>Sources</h3><div class="small">${LAW.sources.map((s) => `<div>${E(s)}</div>`).join('')}</div>`;
  }
  // activate when the Tax view is shown (views.js sets body[data-view])
  const obs = new MutationObserver(() => { if (document.body.dataset.view === 'tax' && !Q('#taxRoot').dataset.loaded) { Q('#taxRoot').dataset.loaded = 1; load(); } });
  obs.observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  if (document.body.dataset.view === 'tax') { Q('#taxRoot').dataset.loaded = 1; load(); }
})();
