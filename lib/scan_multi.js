'use strict';
// Non-Solana scanners. Sources (keyless, verified): GoPlus Security (EVM chains, Sui, Tron),
// Honeypot.is (Ethereum, BSC, Base buy/sell simulation), tonapi.io (TON jettons), chain RPC (EVM owner/code).
// HEURISTICS ONLY, not financial advice.
const { cached, getJSON } = require('./util');
const { CHAINS } = require('./chains');

const fmtUsd = (n) => n == null || isNaN(n) ? '?' : '$' + (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2));
const pct = (n, d = 1) => n == null || isNaN(n) ? '?' : (+n).toFixed(d) + '%';
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '?';
const one = (v) => v === '1' || v === 1 || v === true;
const DEAD = /^(0x0{40}|0x0{36}dead|0x000000000000000000000000000000000000dead|T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb)$/i;

async function goplus(chain, addr) {
  const c = CHAINS[chain];
  if (!c.goplus) return null;
  const url = c.kind === 'sui' ? `https://api.gopluslabs.io/api/v1/sui/token_security?contract_addresses=${encodeURIComponent(addr)}`
    : `https://api.gopluslabs.io/api/v1/token_security/${c.goplus}?contract_addresses=${encodeURIComponent(addr)}`;
  const d = await cached('gp:' + chain + ':' + addr.toLowerCase(), 5 * 60e3, () => getJSON(url, {}, 20000));
  if (!d || d.code !== 1 || !d.result) throw new Error('GoPlus: ' + (d?.message || 'no result'));
  const r = d.result[addr] || d.result[addr.toLowerCase()] || Object.values(d.result)[0];
  if (!r || !Object.keys(r).length) throw new Error('GoPlus: token not indexed');
  return r;
}
async function honeypotIs(chain, addr) {
  const id = CHAINS[chain].honeypot;
  if (!id) return null;
  return cached('hp:' + chain + ':' + addr.toLowerCase(), 5 * 60e3, () => getJSON(`https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=${id}`, {}, 20000));
}

// EVM + Tron (GoPlus EVM schema)
async function evmLike(chain, addr, ctx, add, sources) {
  const c = CHAINS[chain];
  const pairsRaw = await ctx.dsAllPairs(chain, addr).then((x) => { sources.dexscreener = 'ok'; return x; }).catch((e) => { sources.dexscreener = 'failed: ' + e.message; return []; });
  const pairs = (pairsRaw || []).filter((p) => p.baseToken?.address?.toLowerCase() === addr.toLowerCase()).map(ctx.summarizePair).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const main = pairs[0] || null;
  const [gp, hp] = await Promise.all([
    goplus(chain, addr).then((r) => { sources.goplus = 'ok'; return r; }).catch((e) => { sources.goplus = 'failed: ' + e.message; return null; }),
    c.honeypot ? honeypotIs(chain, addr).then((r) => { sources.honeypot_is = r?.simulationSuccess ? 'ok' : 'no simulation: ' + (r?.simulationError || r?.error || 'n/a'); return r; }).catch((e) => { sources.honeypot_is = 'failed: ' + e.message; return null; }) : Promise.resolve(null),
  ]);
  if (!c.honeypot) sources.honeypot_is = 'not supported on ' + c.name;

  // --- honeypot / taxes
  const sim = hp?.simulationSuccess ? hp.simulationResult : null;
  const hpFlag = hp?.honeypotResult?.isHoneypot;
  const gpHoney = gp && one(gp.is_honeypot), cantSell = gp && one(gp.cannot_sell_all), cantBuy = gp && one(gp.cannot_buy);
  if (gp || sim) {
    const lvl = hpFlag || gpHoney || cantSell ? 'red' : cantBuy ? 'amber' : 'green';
    const bits = [];
    if (sim) bits.push(`Honeypot.is simulated a buy+sell: ${hpFlag ? 'SELL FAILED (honeypot)' : 'sell succeeded'} (buy tax ${pct(sim.buyTax)}, sell tax ${pct(sim.sellTax)}).`);
    if (hp?.holderAnalysis?.holders) bits.push(`Sell simulation across ${hp.holderAnalysis.holders} holders: ${hp.holderAnalysis.successful} ok, ${hp.holderAnalysis.failed} failed, highest tax ${pct(hp.holderAnalysis.highestTax)}.`);
    if (gp) bits.push(`GoPlus: honeypot=${gpHoney ? 'YES' : 'no'}${cantSell ? ', cannot sell all' : ''}${cantBuy ? ', cannot buy' : ''}.`);
    add('honeypot', 'Honeypot signs', 'Honeypot / can you sell?', lvl, bits.join(' '), { honeypotIs: hp?.summary || null });
  } else add('honeypot', 'Honeypot signs', 'Honeypot / can you sell?', 'na', 'No GoPlus or Honeypot.is result for this token.');
  const buyTax = sim ? sim.buyTax : gp?.buy_tax !== '' && gp?.buy_tax != null ? gp.buy_tax * 100 : null;
  const sellTax = sim ? sim.sellTax : gp?.sell_tax !== '' && gp?.sell_tax != null ? gp.sell_tax * 100 : null;
  if (buyTax != null || sellTax != null) {
    const m = Math.max(buyTax || 0, sellTax || 0);
    add('tax', 'Honeypot signs', 'Buy / sell tax', m > 10 ? 'red' : m > 3 ? 'amber' : 'green', `Buy tax ${pct(buyTax)}, sell tax ${pct(sellTax)}${gp && one(gp.slippage_modifiable) ? ' · owner CAN change the tax' : ''}${gp && one(gp.personal_slippage_modifiable) ? ' · per-wallet tax can be set' : ''}.`, {}, 15);
  }
  // --- contract / privileges (GoPlus)
  if (gp) {
    const owner = gp.owner_address || '';
    const renounced = !owner || DEAD.test(owner);
    add('code', 'Contract', 'Source code verified', gp.is_open_source === '0' ? 'red' : gp.is_open_source === '1' ? 'green' : 'na', gp.is_open_source === '0' ? 'Contract source is NOT verified; privileged functions cannot be reviewed.' : gp.is_open_source === '1' ? 'Contract source is verified on the explorer.' : 'Unknown.');
    add('owner', 'Contract', 'Ownership', one(gp.hidden_owner) || one(gp.can_take_back_ownership) ? 'red' : renounced ? 'green' : 'amber',
      (renounced ? 'Owner renounced / none.' : `Owner ${owner}.`) + (one(gp.hidden_owner) ? ' Hidden owner detected.' : '') + (one(gp.can_take_back_ownership) ? ' Ownership can be reclaimed after renouncing.' : ''), { owner });
    add('mint', 'Authorities', 'Mint function', one(gp.is_mintable) ? (renounced ? 'amber' : 'red') : 'green', one(gp.is_mintable) ? `Contract can mint new supply${renounced ? ' (owner renounced; check who else can call it)' : ' and has an active owner'}.` : 'No mint function detected.');
    const priv = [];
    if (one(gp.is_proxy)) priv.push('upgradeable proxy (logic can change)');
    if (one(gp.is_blacklisted)) priv.push('blacklist');
    if (one(gp.is_whitelisted)) priv.push('whitelist');
    if (one(gp.transfer_pausable)) priv.push('transfers pausable');
    if (one(gp.trading_cooldown)) priv.push('trading cooldown');
    if (one(gp.anti_whale_modifiable)) priv.push('anti-whale limits modifiable');
    if (one(gp.external_call)) priv.push('external calls');
    if (one(gp.owner_change_balance)) priv.push('OWNER CAN CHANGE BALANCES');
    if (one(gp.selfdestruct)) priv.push('SELFDESTRUCT');
    const hard = one(gp.owner_change_balance) || one(gp.selfdestruct) || (one(gp.transfer_pausable) && !renounced);
    // owner-gated switches (blacklist/pause/limits) are inert once ownership is renounced, unless it is a proxy or has a hidden owner
    const inert = renounced && !one(gp.is_proxy) && !one(gp.hidden_owner) && !one(gp.can_take_back_ownership) && !hard;
    add('freeze', 'Authorities', 'Privileged controls', hard ? 'red' : priv.length ? (inert ? 'green' : 'amber') : 'green',
      priv.length ? `GoPlus flags: ${priv.join(', ')}.` + (inert ? ' Owner is renounced, so owner-only switches should be inert (verify no other admin role).' : '') : 'No proxy / blacklist / pause / balance-edit controls flagged.', { flags: priv });
    if (one(gp.honeypot_with_same_creator)) add('rugcheck', 'Contract', 'Creator history', 'red', `Creator ${short(gp.creator_address)} has deployed honeypots before (GoPlus).`);
    // holders
    const pairsSet = new Set(pairs.map((p) => (p.pairAddress || '').toLowerCase()));
    const hs = (gp.holders || []).map((h) => ({ a: h.address, p: +h.percent * 100, locked: one(h.is_locked), contract: one(h.is_contract), tag: h.tag || '' }));
    const excl = hs.filter((h) => DEAD.test(h.a) || h.locked || pairsSet.has(h.a.toLowerCase()) || /lp|pool|burn|lock/i.test(h.tag));
    const rest = hs.filter((h) => !excl.includes(h));
    const top10 = rest.slice(0, 10).reduce((s, h) => s + h.p, 0);
    if (hs.length) add('top10', 'Holders', 'Holder concentration', top10 > 50 ? 'red' : top10 > 25 ? 'amber' : 'green',
      `Top 10 holders own ${pct(top10)} (excluding ${excl.length} burn/LP/locked accounts holding ${pct(excl.reduce((s, h) => s + h.p, 0))}). Largest: ${rest.slice(0, 3).map((h) => `${short(h.a)}${h.contract ? ' (contract)' : ''} ${pct(h.p)}`).join(', ')}.`, { holders: rest.slice(0, 10) });
    if (gp.holder_count) add('holders', 'Holders', 'Holder count', +gp.holder_count < 200 ? 'red' : +gp.holder_count < 1000 ? 'amber' : 'green', `${(+gp.holder_count).toLocaleString()} holders (GoPlus).`);
    const cp = (+gp.creator_percent || 0) * 100, op = (+gp.owner_percent || 0) * 100;
    add('creator', 'Holders', 'Creator / owner share', Math.max(cp, op) > 10 ? 'red' : Math.max(cp, op) > 3 ? 'amber' : 'green', `Creator ${short(gp.creator_address)} holds ${pct(cp, 2)}; owner holds ${pct(op, 2)}.`);
    // LP lock
    const lps = (gp.lp_holders || []).map((h) => ({ a: h.address, p: +h.percent * 100, locked: one(h.is_locked) || DEAD.test(h.address), tag: h.tag || '' }));
    if (lps.length) {
      const locked = lps.filter((h) => h.locked).reduce((s, h) => s + h.p, 0);
      const concentrated = main && /v3|v4|clmm|cl\b/i.test((main.labels || []).join(' ') + ' ' + main.dexId);
      const mature = main && main.liquidityUsd > 1e6 && main.pairCreatedAt && Date.now() - main.pairCreatedAt > 180 * 864e5;
      let lvl = locked >= 90 ? 'green' : locked >= 50 ? 'amber' : 'red';
      let note = '';
      if (lvl === 'red' && concentrated) { lvl = 'amber'; note = ` Main pool is ${main.dexId} ${(main.labels || []).join('/')} (NFT positions): this figure only covers V2-style pools.`; }
      else if (lvl === 'red' && mature) { lvl = 'amber'; note = ' Unlocked LP on a deep pool older than 180 days: lower pull risk than on a new launch, but liquidity can still be withdrawn.'; }
      add('lplock', 'Liquidity', 'LP burned / locked', lvl, `${pct(locked)} of V2 LP tokens burned or locked across ${gp.lp_holder_count || lps.length} LP holders${lps.find((h) => h.locked && h.tag) ? ' (' + lps.filter((h) => h.locked && h.tag).map((h) => h.tag).slice(0, 2).join(', ') + ')' : ''}.` + note, { lpHolders: lps.slice(0, 5) });
    } else add('lplock', 'Liquidity', 'LP burned / locked', 'na', 'No V2-style LP token holders reported (V3/V4 concentrated liquidity uses NFTs; lock status not available for free).');
  }
  // RPC fallback for EVM when GoPlus has nothing
  if (!gp && c.kind === 'evm' && ctx.evmCallChain) {
    try {
      const code = await ctx.evmCallChain(chain, 'eth_getCode', [addr, 'latest']); sources.rpc = 'ok';
      add('code', 'Contract', 'Contract code', code.length > 2 ? 'green' : 'red', code.length > 2 ? `Contract deployed (${(code.length - 2) / 2} bytes). Source verification unknown (GoPlus has no data).` : 'No contract at this address.');
      if (code.length > 2) {
        let owner = null; try { owner = await ctx.evmCallChain(chain, 'eth_call', [{ to: addr, data: '0x8da5cb5b' }, 'latest']); } catch {}
        const o = owner && owner.length >= 66 ? '0x' + owner.slice(-40) : null;
        add('owner', 'Contract', 'Ownership (owner())', !o || /^0x0{40}$/.test(o) ? 'green' : 'amber', !o ? 'No owner() function.' : /^0x0{40}$/.test(o) ? 'Ownership renounced.' : `Owned by ${o}.`);
      }
    } catch (e) { sources.rpc = 'failed: ' + e.message; }
    add('top10', 'Holders', 'Holder concentration', 'na', `GoPlus has no holder data for this token on ${c.name}.`);
  }
  add('bundle', 'Bundles & insiders', 'Bundled launch / snipers', hp?.holderAnalysis?.snipersSuccess != null ? (hp.holderAnalysis.snipersSuccess > 5 ? 'amber' : 'green') : 'na',
    hp?.holderAnalysis?.snipersSuccess != null ? `Honeypot.is: ${hp.holderAnalysis.snipersSuccess} sniper wallets sold successfully, ${hp.holderAnalysis.snipersFailed} failed.` : 'First-block bundle analysis is Solana-only (needs log indexing on EVM).');
  return { pairs, main, gp, hp, name: gp?.token_name || main?.name, symbol: gp?.token_symbol || main?.symbol };
}

async function sui(chain, addr, ctx, add, sources) {
  const pairsRaw = await ctx.dsAllPairs(chain, addr).then((x) => { sources.dexscreener = 'ok'; return x; }).catch((e) => { sources.dexscreener = 'failed: ' + e.message; return []; });
  const pairs = (pairsRaw || []).filter((p) => p.baseToken?.address === addr).map(ctx.summarizePair).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const main = pairs[0] || null;
  let gp = null;
  try { gp = await goplus(chain, addr); sources.goplus = 'ok'; } catch (e) { sources.goplus = 'failed: ' + e.message; }
  if (gp) {
    const v = (x) => x?.value;
    add('mint', 'Authorities', 'Mintable (TreasuryCap)', v(gp.mintable) === '1' ? 'amber' : 'green', v(gp.mintable) === '1' ? `Supply can still be minted (cap owner: ${gp.mintable.cap_owner || '?'}).` : 'TreasuryCap not usable for minting.');
    add('freeze', 'Authorities', 'Blacklist / deny list', v(gp.blacklist) === '1' ? 'red' : 'green', v(gp.blacklist) === '1' ? `Deny-list capability present (owner ${gp.blacklist.cap_owner || '?'}).` : 'No deny-list capability.');
    add('owner', 'Contract', 'Upgradeable package', v(gp.contract_upgradeable) === '1' ? 'amber' : 'green', v(gp.contract_upgradeable) === '1' ? `Package can be upgraded (cap owner ${gp.contract_upgradeable.cap_owner || '?'}).` : 'Package not upgradeable.');
    add('mutable', 'Metadata', 'Metadata modifiable', v(gp.metadata_modifiable) === '1' ? 'amber' : 'green', `metadata_modifiable=${v(gp.metadata_modifiable)} (cap owner ${gp.metadata_modifiable?.cap_owner || '?'}).`);
    const hs = (gp.holders || []).map((h) => ({ a: h.address, p: +h.percent * (+h.percent <= 1 ? 100 : 1) }));
    const top10 = hs.slice(0, 10).reduce((s, h) => s + h.p, 0);
    if (hs.length) add('top10', 'Holders', 'Holder concentration', top10 > 50 ? 'red' : top10 > 25 ? 'amber' : 'green', `Top 10 holders own ${pct(top10)} (LP/pool accounts not separated on Sui).`);
    if (gp.holder_count) add('holders', 'Holders', 'Holder count', gp.holder_count < 200 ? 'red' : gp.holder_count < 1000 ? 'amber' : 'green', `${(+gp.holder_count).toLocaleString()} holders (GoPlus).`);
    if (gp.trusted_token === '1') add('rugcheck', 'Contract', 'Trusted token list', 'green', 'Listed as a trusted token by GoPlus.');
  }
  add('honeypot', 'Honeypot signs', 'Sell simulation', 'na', 'No free honeypot simulator for Sui.');
  add('bundle', 'Bundles & insiders', 'Bundled launch / snipers', 'na', 'Not available for Sui with free data.');
  return { pairs, main, gp, name: gp?.name || main?.name, symbol: gp?.symbol || main?.symbol };
}

async function ton(chain, addr, ctx, add, sources) {
  const pairsRaw = await ctx.dsAllPairs(chain, addr).then((x) => { sources.dexscreener = 'ok'; return x; }).catch((e) => { sources.dexscreener = 'failed: ' + e.message; return []; });
  const pairs = (pairsRaw || []).map(ctx.summarizePair).filter((p) => p.address).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  const main = pairs[0] || null;
  let j = null, hold = null;
  try { j = await cached('tonj:' + addr, 5 * 60e3, () => getJSON(`https://tonapi.io/v2/jettons/${encodeURIComponent(addr)}`, {}, 15000)); sources.tonapi = 'ok'; } catch (e) { sources.tonapi = 'failed: ' + e.message; }
  try { hold = await cached('tonh:' + addr, 5 * 60e3, () => getJSON(`https://tonapi.io/v2/jettons/${encodeURIComponent(addr)}/holders?limit=20`, {}, 15000)); } catch {}
  if (j) {
    add('mint', 'Authorities', 'Mintable', j.mintable ? 'amber' : 'green', j.mintable ? 'Jetton master still allows minting (admin not revoked).' : 'Minting disabled.');
    add('rugcheck', 'Contract', 'tonapi verification', j.verification === 'blacklist' ? 'red' : j.verification === 'whitelist' ? 'green' : 'amber', `tonapi verification status: ${j.verification || 'none'}.`);
    if (j.holders_count) add('holders', 'Holders', 'Holder count', j.holders_count < 200 ? 'red' : j.holders_count < 1000 ? 'amber' : 'green', `${j.holders_count.toLocaleString()} holders (tonapi).`);
    const sup = +j.total_supply;
    if (hold?.addresses?.length && sup) {
      const rows = hold.addresses.map((h) => ({ a: h.owner?.address || h.address, p: (+h.balance / sup) * 100, wallet: h.owner?.is_wallet, name: h.owner?.name || '' }));
      const ex = rows.filter((r) => r.wallet === false || /pool|dedust|ston|burn|lock/i.test(r.name));
      const rest = rows.filter((r) => !ex.includes(r));
      const top10 = rest.slice(0, 10).reduce((s, r) => s + r.p, 0);
      add('top10', 'Holders', 'Holder concentration', top10 > 50 ? 'red' : top10 > 25 ? 'amber' : 'green', `Top 10 wallet holders own ${pct(top10)} (excluding ${ex.length} contract/pool accounts with ${pct(ex.reduce((s, r) => s + r.p, 0))}).`);
    }
  }
  add('honeypot', 'Honeypot signs', 'Sell simulation', 'na', 'No free honeypot simulator for TON (GoPlus does not support TON).');
  add('bundle', 'Bundles & insiders', 'Bundled launch / snipers', 'na', 'Not available for TON with free data.');
  return { pairs, main, name: j?.metadata?.name || main?.name, symbol: j?.metadata?.symbol || main?.symbol };
}

module.exports = { evmLike, sui, ton, goplus, honeypotIs };
