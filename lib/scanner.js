'use strict';
// Token risk scanner. HEURISTICS ONLY — not financial advice. Every check returns
// evidence so the user can verify it. Data: Solana RPC, RugCheck public API, DexScreener.
const { cached, getJSON } = require('./util');
const { CHAINS } = require('./chains');
const multi = require('./scan_multi');

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo']);
const BURN = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);
const W = { mint: 25, freeze: 20, top10: 15, creator: 10, liq: 15, quoteside: 20, lplock: 12, insiders: 15, rugcheck: 10, age: 10, fdvliq: 10, wash: 10, spike: 5, honeypot: 20, socials: 5, mutable: 5, ext: 15, holders: 8, bundle: 20, sniper: 10, owner: 10, code: 10 };
const fmtUsd = (n) => n == null || isNaN(n) ? '?' : '$' + (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2));
const pct = (n, d = 1) => n == null || isNaN(n) ? '?' : n.toFixed(d) + '%';
const short = (a) => a ? a.slice(0, 4) + '…' + a.slice(-4) : '?';
const ageStr = (ms) => { const h = ms / 3600e3; return h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(1) + 'h' : Math.round(h / 24) + 'd'; };

function mk() {
  const checks = [];
  const add = (id, group, title, level, detail, evidence = {}, weight = W[id] || 5) => checks.push({ id, group, title, level, detail, evidence, weight });
  return { checks, add };
}
function finalize(checks, meta) {
  let risk = 0;
  for (const c of checks) risk += c.level === 'red' ? c.weight : c.level === 'amber' ? c.weight * 0.4 : 0;
  risk = Math.min(100, Math.round(risk));
  const reds = checks.filter((c) => c.level === 'red').length;
  const ambers = checks.filter((c) => c.level === 'amber').length;
  const overall = risk >= 50 || reds >= 3 ? 'red' : risk >= 25 || reds >= 1 ? 'amber' : 'green';
  return { ...meta, riskScore: risk, overall, counts: { red: reds, amber: ambers, green: checks.filter((c) => c.level === 'green').length, na: checks.filter((c) => c.level === 'na').length }, checks, disclaimer: 'Automated heuristics from public data. Not financial advice. Absence of a red flag is not proof of safety.', scannedAt: Date.now() };
}

// ---------------- market checks (chain-agnostic, DexScreener) ----------------
function marketChecks(add, pairs, main, ctx, extra = {}) {
  if (!main) { add('liq', 'Liquidity', 'Trading pair', 'red', 'No DexScreener pair found for this token — cannot be traded on indexed DEXes (or not indexed yet).'); return; }
  const liq = main.liquidityUsd || 0;
  const totalLiq = pairs.reduce((s, p) => s + (p.liquidityUsd || 0), 0);
  // quote-side check: is "liquidity" mostly the token itself?
  let quoteUsd = extra.quoteUsd;
  if (quoteUsd == null && main.liquidityQuote != null) {
    if (STABLES.has(main.quoteAddress)) quoteUsd = main.liquidityQuote;
    else if (main.quoteAddress === WSOL && extra.solPrice) quoteUsd = main.liquidityQuote * extra.solPrice;
    else if (/^(USDC|USDT|DAI|USDG|USD1|FDUSD|USDe|BUSD|USDC\.e|USDbC|USDT0|PYUSD|RLUSD)$/i.test(main.quoteSymbol || '')) quoteUsd = main.liquidityQuote;
    else if (extra.quotePrices && extra.quotePrices[(main.quoteSymbol || '').toUpperCase()]) quoteUsd = main.liquidityQuote * extra.quotePrices[main.quoteSymbol.toUpperCase()];
  }
  const effLiq = quoteUsd != null ? Math.min(liq, quoteUsd * 2) : liq;
  add('liq', 'Liquidity', 'Liquidity depth', effLiq < 10000 ? 'red' : effLiq < 50000 ? 'amber' : 'green',
    `Main pool ${main.dexId}${main.labels?.length ? ' ' + main.labels.join('/') : ''} ${main.symbol}/${main.quoteSymbol}: ${fmtUsd(liq)} reported` + (quoteUsd != null ? `, ~${fmtUsd(effLiq)} effective (2× quote side)` : '') + ` · ${pairs.length} pools total ${fmtUsd(totalLiq)}.`, { pair: main.pairAddress, dex: main.dexId });
  if (quoteUsd != null && liq > 0) {
    const share = (quoteUsd / liq) * 100;
    add('quoteside', 'Liquidity', 'Real (quote-side) liquidity', share < 5 ? 'red' : share < 25 ? 'amber' : 'green',
      `${fmtUsd(quoteUsd)} of the ${fmtUsd(liq)} pool is ${main.quoteSymbol} (${pct(share)}); the rest is the token priced at its own pool price.` + (share < 5 ? ' Typical of one-sided / "fake" liquidity: you could not actually sell into it.' : ''), { quoteUsd, share });
  } else add('quoteside', 'Liquidity', 'Real (quote-side) liquidity', 'na', `Quote token ${main.quoteSymbol} is not a stablecoin or the chain's native coin; could not value the quote side.`);

  const fdv = main.fdv || main.marketCap;
  if (fdv && liq) {
    const r = fdv / Math.max(liq, totalLiq);
    let level = r > 100 ? 'red' : r > 30 ? 'amber' : 'green';
    let detail = `FDV ${fmtUsd(fdv)} vs total liquidity ${fmtUsd(Math.max(liq, totalLiq))} → ${r.toFixed(1)}x.`;
    if (r < 1.25) { level = 'red'; detail += ' Liquidity ≈ FDV: nearly the whole supply sits in the pool, a pattern of self-priced, unsellable liquidity.'; }
    add('fdvliq', 'Market', 'FDV / liquidity ratio', level, detail, { ratio: r });
  }
  const created = Math.min(...pairs.map((p) => p.pairCreatedAt || Infinity));
  if (isFinite(created)) {
    const age = Date.now() - created;
    add('age', 'Market', 'Token / pair age', age < 24 * 3600e3 ? 'red' : age < 7 * 86400e3 ? 'amber' : 'green', `Oldest pool created ${ageStr(age)} ago (${new Date(created).toISOString().slice(0, 10)}); main pool ${ageStr(Date.now() - (main.pairCreatedAt || created))} old.`);
  }
  const v24 = main.volume?.h24 || 0;
  const t24 = (main.txns?.h24?.buys || 0) + (main.txns?.h24?.sells || 0);
  if (liq > 0) {
    const vr = v24 / liq;
    let level = vr > 25 ? 'red' : vr > 8 ? 'amber' : 'green';
    let detail = `24h volume ${fmtUsd(v24)} = ${vr.toFixed(2)}x liquidity over ${t24} txns` + (t24 ? ` (avg ${fmtUsd(v24 / t24)}/txn).` : '.');
    if (liq > 1e6 && vr < 0.001) { level = 'red'; detail += ' Huge stated liquidity with almost no trading — the pool is not being used by real traders.'; }
    else if (vr > 8) detail += ' Volume far above liquidity can indicate wash trading / bot churn.';
    detail += ' (Unique-maker counts are not exposed by the free DexScreener API.)';
    add('wash', 'Manipulation', 'Volume vs liquidity (wash trading)', level, detail, { volLiq: vr, txns24: t24 });
  }
  const m5 = main.change?.m5, h1 = main.change?.h1, h24 = main.change?.h24;
  if (m5 != null || h1 != null) {
    const a5 = Math.abs(m5 || 0), a1 = Math.abs(h1 || 0);
    add('spike', 'Manipulation', 'Sudden price moves', a5 > 25 || a1 > 60 ? 'red' : a5 > 10 || a1 > 25 ? 'amber' : 'green', `5m ${pct(m5)} · 1h ${pct(h1)} · 24h ${pct(h24)}.`);
  } else add('spike', 'Manipulation', 'Sudden price moves', 'na', 'No recent price-change data (no trades in window).');
  const b = main.txns?.h24?.buys || 0, s = main.txns?.h24?.sells || 0;
  add('honeypot', 'Honeypot signs', 'Buys vs sells (24h)', b >= 20 && s === 0 ? 'red' : b >= 20 && s / b < 0.15 ? 'amber' : 'green',
    `${b} buys / ${s} sells in 24h` + (b >= 20 && s === 0 ? ' — nobody is selling: possible honeypot (sells blocked).' : b + s < 10 ? ' (too few trades to judge).' : '.'));
  const hasLinks = pairs.some((p) => (p.websites || []).length || (p.socials || []).length);
  add('socials', 'Metadata', 'Website / socials', hasLinks ? 'green' : 'amber', hasLinks ? 'Links listed on DexScreener: ' + [...new Set(pairs.flatMap((p) => [...(p.websites || []).map((w) => w.label || 'web'), ...(p.socials || []).map((x) => x.type)]))].join(', ') : 'No website or socials listed on any DexScreener pair.');
}

// ---------------- Solana ----------------
async function solanaQuick(addr, ctx, add, sources) {
  const rpc = ctx.rpc;
  const [pairsRaw, mintAcc, rc, prices] = await Promise.all([
    ctx.dsAllPairs('solana', addr).then((x) => { sources.dexscreener = 'ok'; return x; }).catch((e) => { sources.dexscreener = 'failed: ' + e.message; return []; }),
    rpc.call('getAccountInfo', [addr, { encoding: 'jsonParsed' }]).then((x) => { sources.rpc = 'ok (' + rpc.label + ')'; return x; }).catch((e) => { sources.rpc = 'failed: ' + e.message; return null; }),
    cached('rugcheck:' + addr, 120000, () => getJSON(`https://api.rugcheck.xyz/v1/tokens/${addr}/report`, {}, 25000)).then((x) => { sources.rugcheck = 'ok'; return x; }).catch((e) => { sources.rugcheck = 'failed: ' + e.message; return null; }),
    ctx.jupPrices([WSOL, addr]).then((x) => { sources.jupiter = 'ok'; return x; }).catch(() => ({})),
  ]);
  const pairs = (pairsRaw || []).filter((p) => p.baseToken?.address === addr).map(ctx.summarizePair).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const main = pairs[0] || null;
  const solPrice = prices[WSOL]?.usdPrice;
  const parsed = mintAcc?.value?.data?.parsed;
  const mi = parsed?.type === 'mint' ? parsed.info : null;
  const tok = mi || rc?.token || null;
  const decimals = tok?.decimals ?? 0;
  const supplyRaw = tok ? Number(tok.supply) : null;
  const supplyUi = supplyRaw != null ? supplyRaw / 10 ** decimals : null;
  const program = mintAcc?.value?.owner || rc?.tokenProgram;
  const ctxOut = { pairs, main, decimals, supplyRaw, supplyUi, rc, solPrice, program };

  if (mintAcc && !mi) add('mint', 'Authorities', 'Mint account', 'red', 'Address is not an SPL token mint account.');
  // authorities
  const src = mi ? 'RPC getAccountInfo' : rc ? 'RugCheck' : null;
  if (tok) {
    const ma = mi ? mi.mintAuthority : rc.mintAuthority;
    const fa = mi ? mi.freezeAuthority : (rc.token?.freezeAuthority ?? null);
    add('mint', 'Authorities', 'Mint authority', ma ? 'red' : 'green', ma ? `ENABLED (${ma}) — supply can be inflated at will.` : 'Revoked — no one can mint new supply.', { authority: ma, source: src });
    add('freeze', 'Authorities', 'Freeze authority', fa ? 'red' : 'green', fa ? `ENABLED (${fa}) — holders' token accounts can be frozen (cannot sell).` : 'Revoked — accounts cannot be frozen.', { authority: fa, source: src });
  } else {
    add('mint', 'Authorities', 'Mint authority', 'na', 'Could not read mint account (RPC and RugCheck unavailable).');
    add('freeze', 'Authorities', 'Freeze authority', 'na', 'Could not read mint account.');
  }
  // token-2022 extensions
  const exts = mi?.extensions || [];
  if (program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' || exts.length) {
    const names = exts.map((e) => e.extension);
    const bad = names.filter((n) => /permanentDelegate|transferHook|nonTransferable|pausable/i.test(n));
    const fee = exts.find((e) => e.extension === 'transferFeeConfig');
    const bps = fee ? +(fee.state?.newerTransferFee?.transferFeeBasisPoints || 0) : (rc?.transferFee?.pct || 0) * 100;
    add('ext', 'Authorities', 'Token-2022 extensions', bad.length || bps > 1000 ? 'red' : bps > 0 || names.length ? 'amber' : 'green',
      `Token-2022 mint. Extensions: ${names.join(', ') || 'none'}. Transfer fee: ${(bps / 100).toFixed(2)}%.` + (bad.length ? ` ${bad.join(', ')} can move/block holders' tokens.` : ''), { extensions: names, transferFeeBps: bps });
  }

  // holders
  const excl = new Set([...pairs.map((p) => p.pairAddress), ...BURN]);
  const knownTypes = {};
  if (rc?.knownAccounts) for (const [k, v] of Object.entries(rc.knownAccounts)) { knownTypes[k] = v; if (/AMM|LOCKER|BURN|BONDING|POOL/i.test(v.type || '') || /pool|curve|locker|vault/i.test(v.name || '')) excl.add(k); }
  for (const m of rc?.markets || []) { excl.add(m.pubkey); if (m.liquidityA) excl.add(m.liquidityA); if (m.liquidityB) excl.add(m.liquidityB); }
  let holders = null, holderSrc = null;
  if (rc?.topHolders?.length) { holders = rc.topHolders.map((h) => ({ owner: h.owner, account: h.address, pct: h.pct, ui: h.uiAmount, insider: h.insider })); holderSrc = 'RugCheck topHolders'; }
  else if (supplyUi) {
    try {
      const la = await rpc.call('getTokenLargestAccounts', [addr]);
      const accs = la.value.slice(0, 20);
      const ma = await rpc.call('getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed' }]);
      holders = accs.map((a, i) => ({ account: a.address, owner: ma.value[i]?.data?.parsed?.info?.owner, ui: +a.uiAmountString, pct: (+a.uiAmountString / supplyUi) * 100 }));
      holderSrc = 'RPC getTokenLargestAccounts';
    } catch (e) { sources.holders = 'RPC largest accounts failed: ' + e.message; }
  }
  ctxOut.excluded = excl;
  if (holders) {
    const isEx = (h) => excl.has(h.owner) || excl.has(h.account) || (h.ui && supplyUi && h.pct > 50 && pairs.some((p) => (p.liquidityBase || 0) >= h.ui * 0.98));
    const exHs = holders.filter(isEx);
    const real = holders.filter((h) => !isEx(h));
    const t10 = real.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    const t20 = real.slice(0, 20).reduce((s, h) => s + (h.pct || 0), 0);
    const exPct = exHs.reduce((s, h) => s + (h.pct || 0), 0);
    add('top10', 'Holders', 'Holder concentration', t10 > 50 ? 'red' : t10 > 30 ? 'amber' : 'green',
      `Top 10 wallets hold ${pct(t10)}, top 20 ${pct(t20)} of supply (excluding ${exHs.length} pool/LP/locker accounts holding ${pct(exPct)}).`,
      { source: holderSrc, top: real.slice(0, 10).map((h) => ({ owner: h.owner, pct: +(h.pct || 0).toFixed(2), insider: !!h.insider, label: knownTypes[h.owner]?.name })), excluded: exHs.map((h) => ({ owner: h.owner, pct: +(h.pct || 0).toFixed(2), label: knownTypes[h.owner]?.name || 'pool/LP' })) });
    ctxOut.top10 = t10;
  } else add('top10', 'Holders', 'Holder concentration', 'na', 'Holder list unavailable (RugCheck down and public RPC rate-limits getTokenLargestAccounts). Add a custom RPC in Settings.');

  if (rc?.creator && supplyRaw) {
    const cPct = (Number(rc.creatorBalance || 0) / supplyRaw) * 100;
    add('creator', 'Holders', 'Dev / creator wallet share', cPct > 5 ? 'red' : cPct > 1 ? 'amber' : 'green', `Creator ${short(rc.creator)} holds ${pct(cPct, 3)} of supply.`, { creator: rc.creator, pct: cPct, source: 'RugCheck' });
  } else add('creator', 'Holders', 'Dev / creator wallet share', 'na', rc ? 'Creator not identified by RugCheck.' : 'RugCheck unavailable.');
  if (rc?.totalHolders != null) add('holders', 'Holders', 'Holder count', rc.totalHolders < 100 ? 'red' : rc.totalHolders < 1000 ? 'amber' : 'green', `${rc.totalHolders.toLocaleString()} holders (RugCheck).`);

  // LP lock
  if (rc?.markets?.length) {
    const mm = rc.markets.map((m) => ({ pubkey: m.pubkey, type: m.marketType, lockedPct: m.lp?.lpLockedPct || 0, lockedUsd: m.lp?.lpLockedUSD || 0, usd: (m.lp?.baseUSD || 0) + (m.lp?.quoteUSD || 0), quoteUSD: m.lp?.quoteUSD, baseUSD: m.lp?.baseUSD, lpMint: m.mintLP }));
    mm.sort((a, b) => b.usd - a.usd);
    const top = mm[0];
    const tot = mm.reduce((s, m) => s + m.usd, 0);
    const lockedUsd = mm.reduce((s, m) => s + m.lockedUsd, 0);
    const lockedShare = tot ? (lockedUsd / tot) * 100 : 0;
    const positionBased = !top.lpMint || top.lpMint === '11111111111111111111111111111111';
    let level, detail;
    if (positionBased) { level = 'amber'; detail = `Largest market (${top.type}, ${fmtUsd(top.usd)}) is position-based (CLMM/DLMM) — no LP token to burn, so lock status can't be determined; the position owner may be able to withdraw.`; }
    else { level = top.lockedPct >= 90 ? 'green' : top.lockedPct >= 50 ? 'amber' : 'red'; detail = `Largest market (${top.type}): ${pct(top.lockedPct)} of LP burned/locked.`; }
    detail += ` Across ${mm.length} markets, ${pct(lockedShare)} of tracked liquidity (${fmtUsd(lockedUsd)}) is locked/burned.`;
    add('lplock', 'Liquidity', 'LP burned / locked', level, detail, { markets: mm.slice(0, 5), source: 'RugCheck markets' });
  } else add('lplock', 'Liquidity', 'LP burned / locked', 'na', 'RugCheck market data unavailable; LP lock status not determinable from free APIs.');

  if (rc) {
    const nets = rc.insiderNetworks || [];
    const held = nets.reduce((s, n) => s + Number(n.currentHolding || 0), 0);
    const hp = supplyRaw ? (held / supplyRaw) * 100 : 0;
    add('insiders', 'Bundles & insiders', 'Insider / linked-wallet networks', hp > 20 ? 'red' : hp > 5 || (rc.graphInsidersDetected || 0) > 50 ? 'amber' : 'green',
      nets.length ? `RugCheck found ${nets.length} linked network(s) with ${rc.graphInsidersDetected || nets.reduce((s, n) => s + (n.size || 0), 0)} wallets (${nets.map((n) => n.type).join(', ')}) currently holding ${pct(hp)} of supply.` : `No insider networks detected by RugCheck (${rc.graphInsidersDetected || 0} flagged wallets).`,
      { networks: nets.map((n) => ({ id: n.id, size: n.size, type: n.type, holdingPct: supplyRaw ? +((Number(n.currentHolding) / supplyRaw) * 100).toFixed(2) : null })), source: 'RugCheck' });
    const risks = rc.risks || [];
    const dangers = risks.filter((r) => r.level === 'danger');
    add('rugcheck', 'Metadata', 'RugCheck flags', dangers.length ? 'red' : risks.length > 1 ? 'amber' : 'green',
      risks.length ? risks.map((r) => `${r.level === 'danger' ? '⛔' : '⚠'} ${r.name}${r.value ? ' (' + r.value + ')' : ''}`).join(' · ') : 'No risks flagged.', { normalisedScore: rc.score_normalised, rugged: rc.rugged, launchpad: rc.launchpad?.name });
    if (rc.tokenMeta) add('mutable', 'Metadata', 'Metadata mutability', rc.tokenMeta.mutable ? 'amber' : 'green', rc.tokenMeta.mutable ? `Mutable — update authority ${short(rc.tokenMeta.updateAuthority)} can change name/symbol/image.` : 'Immutable metadata.', { updateAuthority: rc.tokenMeta.updateAuthority });
  } else add('rugcheck', 'Metadata', 'RugCheck flags', 'na', 'RugCheck API unavailable right now.');

  let quoteUsd = null;
  if (rc?.markets && main) { const m = rc.markets.find((x) => x.pubkey === main.pairAddress); if (m?.lp?.quoteUSD != null) quoteUsd = m.lp.quoteUSD; }
  marketChecks(add, pairs, main, ctx, { solPrice, quoteUsd });
  return ctxOut;
}

// Deep scan: earliest transactions → bundles, snipers, funding sources
async function solanaDeep(addr, ctx, q, add, sources) {
  const rpc = ctx.rpc;
  const maxPages = rpc.isPublic ? 20 : 60;
  let before, all = [], reached = false;
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await rpc.call('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }]);
      all.push(...page);
      if (page.length < 1000) { reached = true; break; }
      before = page[page.length - 1].signature;
    }
  } catch (e) { sources.deep = 'signature paging failed: ' + e.message; }
  const note = q.rc?.insiderNetworks?.length ? ' RugCheck insider-network data (above) is the best available proxy.' : '';
  if (!reached) {
    const msg = all.length ? `History deeper than ${all.length.toLocaleString()} txns; ${rpc.isPublic ? 'public RPC paging cap reached' : 'paging cap reached'} — earliest txns not reachable.${rpc.isPublic ? ' Add a Helius/Triton RPC in Settings to page further.' : ''}` : 'Could not fetch signatures (RPC rate limit).';
    add('bundle', 'Bundles & insiders', 'Bundled launch detection', 'na', msg + note, { sigsScanned: all.length });
    add('sniper', 'Bundles & insiders', 'Snipers / early buyers', 'na', msg, { sigsScanned: all.length });
    return { sigsScanned: all.length, reachedOldest: false };
  }
  const oldest = all.slice().reverse();
  const creationSlot = oldest[0].slot;
  const N = rpc.isPublic ? 35 : 120;
  const sample = oldest.slice(0, N);
  const buyers = new Map(); // wallet -> {slot, sig, amount, accounts:Set}
  let creator = null, txOk = 0, txFail = 0;
  const supplyUi = q.supplyUi;
  for (const s of sample) {
    let tx;
    try { tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); } catch { txFail++; continue; }
    if (!tx) { txFail++; continue; }
    txOk++;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const payer = keys[0];
    if (!creator) creator = payer;
    if (tx.meta?.err) continue;
    const pre = {}, post = {};
    for (const b of tx.meta?.preTokenBalances || []) if (b.mint === addr) pre[b.accountIndex] = b;
    for (const b of tx.meta?.postTokenBalances || []) if (b.mint === addr) post[b.accountIndex] = b;
    for (const idx of new Set([...Object.keys(pre), ...Object.keys(post)])) {
      const a = post[idx] || pre[idx];
      const owner = a.owner;
      const d = +(post[idx]?.uiTokenAmount?.uiAmountString || 0) - +(pre[idx]?.uiTokenAmount?.uiAmountString || 0);
      if (d <= 0 || !owner || q.excluded?.has(owner)) continue;
      if (supplyUi && d >= supplyUi * 0.5) { q.excluded?.add(owner); continue; } // initial supply into curve/pool
      const e = buyers.get(owner) || { wallet: owner, slot: s.slot, sig: s.signature, amount: 0, accounts: new Set(), signer: owner === payer };
      e.amount += d; e.accounts.add(keys[idx]); e.slot = Math.min(e.slot, s.slot);
      buyers.set(owner, e);
    }
  }
  const list = [...buyers.values()].sort((a, b) => a.slot - b.slot);
  const slotCounts = {};
  for (const b of list) slotCounts[b.slot] = (slotCounts[b.slot] || 0) + 1;
  const bundle = list.filter((b) => b.wallet !== creator && (b.slot === creationSlot || (b.slot <= creationSlot + 2 && slotCounts[b.slot] >= 3)));
  const snipers = list.filter((b) => b.wallet !== creator && !bundle.includes(b) && b.slot <= creationSlot + 10);
  const dev = list.find((b) => b.wallet === creator);
  // current holdings of tracked token accounts
  const tracked = [...bundle, ...snipers, ...(dev ? [dev] : [])];
  const accs = [...new Set(tracked.flatMap((b) => [...b.accounts]))].slice(0, 100);
  const balByAcc = {};
  if (accs.length) {
    try {
      const r = await rpc.call('getMultipleAccounts', [accs, { encoding: 'jsonParsed' }]);
      r.value.forEach((v, i) => { balByAcc[accs[i]] = +(v?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0); });
    } catch (e) { sources.deep = 'holdings lookup failed: ' + e.message; }
  }
  for (const b of tracked) { b.current = [...b.accounts].reduce((s, a) => s + (balByAcc[a] || 0), 0); b.boughtPct = supplyUi ? (b.amount / supplyUi) * 100 : null; b.heldPct = supplyUi ? (b.current / supplyUi) * 100 : null; }
  // funding sources (first incoming SOL transfer) for up to 8 early wallets
  const funders = {};
  for (const b of [...bundle, ...snipers].slice(0, 8)) {
    try {
      const sigs = await rpc.call('getSignaturesForAddress', [b.wallet, { limit: 1000 }]);
      if (!sigs.length || sigs.length === 1000) continue;
      const first = sigs[sigs.length - 1];
      const tx = await rpc.call('getTransaction', [first.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const ixs = [...(tx?.transaction?.message?.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap((x) => x.instructions)];
      const t = ixs.find((ix) => ix.program === 'system' && /transfer/.test(ix.parsed?.type || '') && ix.parsed?.info?.destination === b.wallet);
      if (t) { b.funder = t.parsed.info.source; (funders[b.funder] ||= []).push(b.wallet); }
    } catch {}
  }
  const shared = Object.entries(funders).filter(([, ws]) => ws.length >= 2);
  const row = (b) => ({ wallet: b.wallet, slot: b.slot, slotOffset: b.slot - creationSlot, boughtPct: b.boughtPct != null ? +b.boughtPct.toFixed(3) : null, heldPct: b.heldPct != null ? +b.heldPct.toFixed(3) : null, funder: b.funder || null, sig: b.sig });
  const bHeld = bundle.reduce((s, b) => s + (b.heldPct || 0), 0);
  const bBought = bundle.reduce((s, b) => s + (b.boughtPct || 0), 0);
  add('bundle', 'Bundles & insiders', 'Bundled launch detection', bundle.length >= 3 || bHeld > 5 || shared.length ? 'red' : bundle.length ? 'amber' : 'green',
    `${bundle.length} wallet(s) bought in the creation slot ${creationSlot} (or ≥3 buyers in one of the next 2 slots); they bought ${pct(bBought, 2)} and still hold ${pct(bHeld, 2)} of supply.` +
    (shared.length ? ` ${shared.length} common funding source(s): ${shared.map(([f, ws]) => short(f) + '→' + ws.length + ' wallets').join(', ')}.` : ' No shared funding source among checked wallets.') +
    (dev ? ` Dev (${short(creator)}) bought ${pct(dev.boughtPct, 2)}, holds ${pct(dev.heldPct, 2)}.` : ''),
    { creator, creationSlot, creationTime: oldest[0].blockTime ? oldest[0].blockTime * 1000 : null, wallets: bundle.map(row), sharedFunders: shared.map(([f, ws]) => ({ funder: f, wallets: ws })), txsAnalyzed: txOk, txsFailed: txFail, totalSigs: all.length });
  const sHeldN = snipers.filter((b) => (b.current || 0) > 0).length;
  const sHeld = snipers.reduce((s, b) => s + (b.heldPct || 0), 0);
  add('sniper', 'Bundles & insiders', 'Snipers / early buyers', sHeld > 10 ? 'red' : sHeld > 3 || snipers.length > 10 ? 'amber' : 'green',
    `${snipers.length} other wallet(s) bought within 10 slots (~4s) of creation; ${sHeldN} still hold, together ${pct(sHeld, 2)} of supply. First non-pool buyer arrived ${list.find((b) => b.wallet !== creator) ? (list.find((b) => b.wallet !== creator).slot - creationSlot) + ' slots' : 'n/a (none in sample)'} after creation. (Analyzed first ${txOk} txns of ${all.length}.)`,
    { wallets: snipers.map(row), earliestBuyers: list.slice(0, 10).map((b) => ({ wallet: b.wallet, slotOffset: b.slot - creationSlot, boughtPct: b.amount && supplyUi ? +((b.amount / supplyUi) * 100).toFixed(3) : null, isCreator: b.wallet === creator })) });
  return { sigsScanned: all.length, reachedOldest: true, creationSlot };
}

// ---------------- Robinhood Chain (EVM) ----------------
async function evmScan(addr, ctx, add, sources) {
  const pairsRaw = await ctx.dsAllPairs('robinhood', addr).then((x) => { sources.dexscreener = 'ok'; return x; }).catch((e) => { sources.dexscreener = 'failed: ' + e.message; return []; });
  const pairs = (pairsRaw || []).filter((p) => p.baseToken?.address?.toLowerCase() === addr.toLowerCase()).map(ctx.summarizePair).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const main = pairs[0] || null;
  let code = null, owner, ownerErr, supply = null, symbol = null;
  try {
    code = await ctx.evmCall('eth_getCode', [addr, 'latest']); sources.rpc = 'ok (Robinhood Chain public RPC)';
    try { owner = await ctx.evmCall('eth_call', [{ to: addr, data: '0x8da5cb5b' }, 'latest']); } catch (e) { ownerErr = e.message; }
    try { supply = BigInt(await ctx.evmCall('eth_call', [{ to: addr, data: '0x18160ddd' }, 'latest'])); } catch {}
    try { symbol = ctx.decodeAbiString(await ctx.evmCall('eth_call', [{ to: addr, data: '0x95d89b41' }, 'latest'])); } catch {}
  } catch (e) { sources.rpc = 'failed: ' + e.message; }
  if (code != null) add('code', 'Contract', 'Contract code', code.length > 2 ? 'green' : 'red', code.length > 2 ? `Contract deployed (${(code.length - 2) / 2} bytes bytecode). Source verification not checked (Blockscout API is behind a Cloudflare challenge).` : 'No contract code at this address.');
  if (code && code.length > 2) {
    const o = owner && owner.length >= 66 ? '0x' + owner.slice(-40) : null;
    const zero = !o || /^0x0{40}$/.test(o);
    add('owner', 'Contract', 'Ownership (owner())', ownerErr || !owner || owner === '0x' ? 'green' : zero ? 'green' : 'amber',
      ownerErr || !owner || owner === '0x' ? 'No owner() function (no Ownable admin exposed).' : zero ? 'Ownership renounced (owner = 0x0).' : `Owned by ${o} — may hold privileged functions (mint/blacklist/fees). Review the verified source.`, { owner: o });
  }
  const bytecodeHints = [];
  if (code && code.length > 2) {
    const sel = { '40c10f19': 'mint(address,uint256)', 'f9f92be4': 'blacklist(address)', '44337ea1': 'addToBlacklist', '8456cb59': 'pause()', '3f4ba83a': 'unpause()' };
    for (const [s, n] of Object.entries(sel)) if (code.includes(s)) bytecodeHints.push(n);
    add('mint', 'Contract', 'Privileged function selectors in bytecode', bytecodeHints.length ? 'amber' : 'green', bytecodeHints.length ? `Bytecode contains selectors for: ${bytecodeHints.join(', ')} (presence only; may be access-controlled or unreachable).` : 'No mint/blacklist/pause selectors found in bytecode (heuristic; proxies can hide logic).', {}, 10);
  }
  add('top10', 'Holders', 'Holder concentration', 'na', 'No free, key-less holder API verified for Robinhood Chain (Blockscout API returns a Cloudflare challenge). Skipped.');
  add('bundle', 'Bundles & insiders', 'Bundled launch / snipers', 'na', 'Not implemented for EVM in v1 (needs log indexing of first-block transfers).');
  marketChecks(add, pairs, main, ctx, { quoteUsd: null });
  return { pairs, main, supply: supply != null ? supply.toString() : null, symbol };
}

// ---------------- contract vulnerability scan (lib/contractscan.js): additive risk factors ----------------
// Uses the batch result (data/contractscan.json) when present, else an on-demand scan (cached 1h, 20s budget).
// Flags that duplicate checks above (Solana mint/freeze/mutable, GoPlus honeypot/tax/mint/owner/source) are shown with weight 0.
const CS_DUP = { solana: new Set(['mint', 'freeze', 'mutable', 'rugged', 'tfee']), evm: new Set(['honeypot', 'tax', 'mint', 'owner', 'unverified', 'creator']) };
const CS_W = { critical: 25, high: 12, medium: 5, low: 0 };
async function contractChecks(chain, addr, add, sources) {
  let cs; try { cs = require('./contractscan'); } catch { return; }
  let r = cs.lookup(chain, addr), how = 'batch scan';
  if (!r) {
    how = 'on-demand scan';
    r = await cached('cscan:' + chain + ':' + addr, 3600e3, () => Promise.race([cs.scanToken(chain, addr, { simulate: chain === 'solana', noGoplus: true /* GoPlus already fetched by the checks above; avoids double-throttling */ }).then((x) => { x.flags = cs.riskFlags(x); x.riskScore = cs.riskScore(x.flags); return x; }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]));
  }
  if (!r || !r.scannable) { sources.contractscan = r ? 'not scannable: ' + r.reason : 'no result'; return; }
  sources.contractscan = `ok (${how}, ${new Date(r.scannedAt).toISOString().slice(0, 16)}Z)`;
  const dup = CS_DUP[chain === 'solana' ? 'solana' : 'evm'];
  for (const fl of r.flags || []) add('cs_' + fl.id, 'Contract scan', fl.title, fl.sev === 'critical' || fl.sev === 'high' ? 'red' : fl.sev === 'medium' ? 'amber' : 'green', fl.plain, { severity: fl.sev, source: 'lib/contractscan.js', duplicate: dup.has(fl.id) }, dup.has(fl.id) ? 0 : CS_W[fl.sev]);
  const sim = r.evidence?.simulation || r.evidence?.sellSim;
  if (sim) add('cs_sim', 'Contract scan', 'Own sell simulation', r.features?.sim_sell_blocked || r.features?.sim_sell_ok === false ? 'red' : r.features?.sim_sell_blocked === false || r.features?.sim_sell_ok ? 'green' : 'na',
    r.kind === 'evm' ? (sim.runs || []).map((x) => `${x.label}: ${x.ok ? 'ok' + (x.taxPct != null ? ` (${x.taxPct}% lost)` : '') : 'FAILED' + (x.reason ? ' — ' + x.reason : x.error ? ' — ' + x.error.slice(0, 80) : '')}`).join('; ') + (sim.note ? '. ' + sim.note : '') + '. Simulated with eth_call state overrides; nothing was sent.'
      : sim.sellOk ? `A real holder's Jupiter sell route simulated successfully (price impact ${sim.quoteImpactPct != null ? sim.quoteImpactPct.toFixed(2) + '%' : '?'}). Nothing was signed or sent.` : sim.noRoute ? 'Jupiter found no sell route.' : 'Sell simulation inconclusive (holder accounts could not be simulated).', { source: 'lib/contractscan.js' }, 0);
  if (!(r.flags || []).length) add('cs_clean', 'Contract scan', 'Contract scan', 'green', 'No honeypot, hidden-tax, proxy, permanent-delegate, transfer-hook or owner-switch red flags found (current on-chain state).', { source: 'lib/contractscan.js' }, 0);
}

async function scan(chain, addr, deep, ctx) {
  const key = `scan:${chain}:${addr}:${deep ? 1 : 0}:${ctx.rpc.url}`;
  return cached(key, deep ? 15 * 60e3 : 90e3, async () => {
    const t0 = Date.now();
    const { checks, add } = mk();
    const sources = {};
    let meta = { chain, address: addr, deep };
    if (chain === 'solana') {
      const q = await solanaQuick(addr, ctx, add, sources);
      if (deep) { const d = await solanaDeep(addr, ctx, q, add, sources); meta.deepInfo = d; }
      else { add('bundle', 'Bundles & insiders', 'Bundled launch detection', 'na', 'Run deep scan to analyze earliest transactions.'); add('sniper', 'Bundles & insiders', 'Snipers / early buyers', 'na', 'Run deep scan.'); }
      meta = { ...meta, token: { name: q.main?.name || q.rc?.tokenMeta?.name, symbol: q.main?.symbol || q.rc?.tokenMeta?.symbol, supply: q.supplyUi, decimals: q.decimals, program: q.program, launchpad: q.rc?.launchpad?.name || null }, mainPair: q.main, pairCount: q.pairs.length };
    } else {
      const kind = CHAINS[chain].kind;
      const q = kind === 'sui' ? await multi.sui(chain, addr, ctx, add, sources) : kind === 'ton' ? await multi.ton(chain, addr, ctx, add, sources) : await multi.evmLike(chain, addr, ctx, add, sources);
      marketChecks(add, q.pairs, q.main, ctx, { quotePrices: ctx.quotePrices || {} });
      meta = { ...meta, token: { name: q.name, symbol: q.symbol }, mainPair: q.main, pairCount: q.pairs.length };
    }
    try { await contractChecks(chain, addr, add, sources); } catch (e) { sources.contractscan = 'failed: ' + String(e.message || e).slice(0, 120); }
    const order = ['Authorities', 'Contract', 'Contract scan', 'Holders', 'Liquidity', 'Bundles & insiders', 'Manipulation', 'Honeypot signs', 'Metadata', 'Market'];
    checks.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    return finalize(checks, { ...meta, sources, elapsedMs: Date.now() - t0 });
  });
}
module.exports = { scan };
