// Airdrop Desk v2 backend (additive): tracker / under-farmed data (research/airdrops_v2.py -> data/airdrop_desk.json),
// My Farms monitor (read-only: address only, never keys), dilution warnings, value estimates.
// Snapshots: data/airdrop_farms.json. All numbers come from public APIs or from what the user typed; estimates, not advice.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cached, getJSON, postJSON } = require('./util');

const YO_TOKEN = '0x1925450f5e5fB974b0AaE1F3408cF5286FBD1A72'; // Base, from @yo-protocol/core YO_TOKEN
const YO_ETH = '0x3A43AEC53490CB9Fa922847385D82fe25d0E9De7'; // yoETH vault (Base + Ethereum), Merkl 'Deposit wETH to YO'
const RPC = { 8453: 'https://base-rpc.publicnode.com', 1: 'https://ethereum-rpc.publicnode.com' };
const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || '');
const isSol = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const num = (x) => (x == null || x === '' || isNaN(+x) ? null : +x);

async function ethCall(chain, to, data) {
  const r = await postJSON(RPC[chain], { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  if (r.error) throw new Error(r.error.message || 'rpc error');
  return BigInt(r.result && r.result !== '0x' ? r.result : '0x0');
}
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
async function llamaTvl(slug) {
  return cached(`ad2:tvl:${slug}`, 30 * 60e3, async () => {
    const d = await getJSON(`https://api.llama.fi/protocol/${slug}`, {}, 30000);
    const s = (d.tvl || []).map((x) => [x.date * 1000, x.totalLiquidityUSD]);
    return { now: s.length ? s[s.length - 1][1] : null, series: s };
  });
}
const tvlAt = (series, t) => { let best = null; for (const [ts, v] of series || []) if (Math.abs(ts - t) < 4 * 86400e3 && (!best || Math.abs(ts - t) < Math.abs(best[0] - t))) best = [ts, v]; return best ? best[1] : null; };

// ---------------- adapters: what can be read automatically per protocol ----------------
const ADAPTERS = {
  yo: {
    name: 'YO Protocol (yoETH / yoUSD / yoBTC vaults)', slug: 'yo-protocol', chains: 'Base, Ethereum, Arbitrum, Solana', unit: 'YO earned', addr: 'evm',
    automated: ['Rank, all-time $YO earned and total wallets on the public YO rewards leaderboard (api.yo.xyz)', 'This week / last week $YO earned (api.yo.xyz)', 'Merkl rewards: earned, claimed and unclaimed $YO (api.merkl.xyz)', 'yoETH balance on Base and Ethereum (public RPC, ERC-4626)', 'Protocol TVL (DefiLlama)', 'Current Merkl campaign size for yoETH (YO per day) and your expected daily YO'],
    manual: [], login: [],
    notes: '$YO already launched (Genesis airdrop closed May 6 2026; YO says it was the last airdrop). What you farm now is $YO streamed via Merkl; claim within 90 days or it may be reassigned. $YO is non-transferable (no market price); value uses YO\'s own reference price $0.09 (FDV $90M).',
    async pull(addr) {
      if (!isEvm(addr)) throw Object.assign(new Error('YO needs an EVM address (0x…)'), { status: 400 });
      const lb = (kind) => cached(`ad2:yo:${kind}`, 9 * 60e3, () => getJSON(`https://api.yo.xyz/api/v1/rewards/${kind}/${YO_TOKEN}`, {}, 20000));
      const [all, wk, me, merkl, opps, tvl] = await Promise.allSettled([lb('all-time'), lb('weekly'), getJSON(`https://api.yo.xyz/api/v1/rewards/user/${addr}/${YO_TOKEN}`),
        getJSON(`https://api.merkl.xyz/v4/users/${addr}/rewards?chainId=8453`, {}, 20000), cached('ad2:yo:opps', 3600e3, () => getJSON('https://api.merkl.xyz/v4/opportunities?mainProtocolId=yo&items=50&campaigns=true', {}, 20000)), llamaTvl('yo-protocol')]);
      const out = { source: {}, extra: {} };
      if (all.status === 'fulfilled') {
        const L = all.value.data.allTimeRewards || []; const i = L.findIndex((x) => x.userAddress.toLowerCase() === addr.toLowerCase());
        out.total_points = L.reduce((s, x) => s + +x.totalRewards.formatted, 0); out.total_users = all.value.data.totalUsers;
        out.points = i >= 0 ? +L[i].totalRewards.formatted : 0; out.rank = i >= 0 ? i + 1 : null;
        out.extra.leaderboard_updated = all.value.data.lastUpdated;
        out.extra.rank_thresholds = [1, 10, 100, 200, 300, 500, 1000].filter((r) => r <= L.length).map((r) => [r, +L[r - 1].totalRewards.formatted]);
        out.source.leaderboard = 'ok';
        if (i < 0) out.extra.leaderboard_note = 'Address not on the all-time leaderboard (it ranks $YO claimed via Merkl; unclaimed rewards may not count yet).';
      } else out.source.leaderboard = 'failed: ' + all.reason.message;
      if (wk.status === 'fulfilled') { const L = wk.value.data.weeklyRewards || []; const i = L.findIndex((x) => x.userAddress.toLowerCase() === addr.toLowerCase()); out.extra.weekly_rank = i >= 0 ? i + 1 : null; out.extra.weekly_users = wk.value.data.totalUsers; out.extra.weekly_yo = i >= 0 ? +L[i].totalRewards.formatted : 0; out.source.weekly = 'ok'; } else out.source.weekly = 'failed';
      if (me.status === 'fulfilled') { const d = me.value.data || {}; out.extra.this_week_yo = +(d.currentWeek?.totalRewards?.formatted || 0); out.extra.last_week_yo = +(d.lastWeek?.totalRewards?.formatted || 0); out.source.user = 'ok'; } else out.source.user = 'failed';
      if (merkl.status === 'fulfilled') {
        const R = (merkl.value[0]?.rewards || []).filter((r) => r.token?.address?.toLowerCase() === YO_TOKEN.toLowerCase());
        const dec = 1e18; const earned = R.reduce((s, r) => s + Number(BigInt(r.amount || 0)) / dec, 0), claimed = R.reduce((s, r) => s + Number(BigInt(r.claimed || 0)) / dec, 0), pending = R.reduce((s, r) => s + Number(BigInt(r.pending || 0)) / dec, 0);
        Object.assign(out.extra, { merkl_earned_yo: earned, merkl_claimed_yo: claimed, merkl_unclaimed_yo: earned - claimed, merkl_pending_yo: pending }); out.source.merkl = 'ok';
      } else out.source.merkl = 'failed';
      let ethUsd = null; try { ethUsd = (await cached('ad2:ethusd', 600e3, () => getJSON('https://coins.llama.fi/prices/current/coingecko:ethereum'))).coins['coingecko:ethereum'].price; } catch {}
      let yoeth = 0;
      for (const ch of [8453, 1]) {
        try {
          const sh = await ethCall(ch, YO_ETH, '0x70a08231' + pad(addr));
          const assets = sh ? await ethCall(ch, YO_ETH, '0x07a2d13a' + sh.toString(16).padStart(64, '0')) : 0n;
          out.extra[`yoETH_${ch === 1 ? 'ethereum' : 'base'}_eth`] = Number(assets) / 1e18; yoeth += Number(assets) / 1e18;
        } catch (e) { out.source[`rpc_${ch}`] = 'failed: ' + e.message; }
      }
      out.extra.yoETH_total_eth = yoeth; out.deposit_usd = ethUsd ? yoeth * ethUsd : null;
      if (opps.status === 'fulfilled') {
        const o = opps.value.filter((x) => x.identifier?.toLowerCase() === YO_ETH.toLowerCase());
        const c = o.map((x) => { const cp = (x.campaigns || [])[0] || {}; const days = (cp.endTimestamp - cp.startTimestamp) / 86400; const yo = Number(BigInt(cp.amount || 0)) / 1e18; return { chainId: x.chainId, tvl: x.tvl, yo_per_day: days ? yo / days : null, start: cp.startTimestamp, end: cp.endTimestamp }; });
        out.extra.yoETH_campaigns = c;
        const base = c.find((x) => x.chainId === 8453);
        if (base && out.deposit_usd && base.tvl) out.extra.expected_yo_per_day_base = base.yo_per_day * Math.min(1, ((out.extra.yoETH_base_eth || 0) * ethUsd) / base.tvl);
      }
      if (tvl.status === 'fulfilled') { out.tvl = tvl.value.now; out.tvl_series = tvl.value.series; }
      const earned = out.extra.merkl_earned_yo != null ? Math.max(out.extra.merkl_earned_yo, out.points || 0) : out.points;
      out.value = { unit_price: 0.09, unit_price_note: `YO reference price used by YO docs and Merkl (non-transferable; no market). Based on ${earned != null ? Math.round(earned).toLocaleString() : '—'} YO earned incl. unclaimed`, usd: earned != null ? earned * 0.09 : null, yo_earned: earned };
      if (out.extra.merkl_unclaimed_yo > 1) out.extra.leaderboard_note = (out.extra.leaderboard_note ? out.extra.leaderboard_note + ' ' : '') + 'The leaderboard counts CLAIMED YO only: claiming your unclaimed YO moves you up.';
      return out;
    },
  },
  townsquare: {
    name: 'TownSquare (Monad lending + USD1/RWA vaults)', slug: 'townsquare', chains: 'Monad, BNB Chain, Base', unit: 'TownSquare points', addr: 'evm',
    automated: ['Mainnet accounts (the number the Ranking page shows; all-environments count incl. testnet kept as extra)', 'Protocol TVL (DefiLlama: Monad lending + loop vaults only)'],
    manual: ['Your points and rank: open app.townsq.xyz/ranking with your wallet, then type them here', 'Total points (not published; leave blank)'],
    login: ['Points/rank endpoints (/api/points/*) need a Bearer token from a wallet-signature login, so they cannot be read from an address alone. We never ask you to sign anything here.'],
    notes: 'Pre-TGE. $TOWN sale closed Jul 27 2026 at $150M/$200M FDV tiers; tokenomics: 10B supply, community pool 31.84% with ~185.6M TOWN (1.86% of supply) unlocked at TGE "to reward existing users". No TGE date announced. Points docs: no guaranteed right to tokens.',
    async pull(addr) {
      const out = { source: {}, extra: {} };
      try { out.extra.registered_users_all = (await cached('ad2:ts:users', 3600e3, () => getJSON('https://action-link-stage.townesquare.xyz/api/users/total-users'))).data.total_users; out.extra.mainnet_users = (await cached('ad2:ts:users:main', 3600e3, () => getJSON('https://action-link-stage.townesquare.xyz/api/users/total-users?is_mainnet=1'))).data.total_users; out.total_users = out.extra.mainnet_users; out.source.users = 'ok'; } catch (e) { out.source.users = 'failed: ' + e.message; }
      try { const t = await llamaTvl('townsquare'); out.tvl = t.now; out.tvl_series = t.series; out.source.defillama = 'ok'; } catch (e) { out.source.defillama = 'failed'; }
      const pool = 185627200, supply = 1e10;
      out.value = { scenarios: [150e6, 200e6, 270e6].map((fdv) => ({ fdv, label: fdv === 270e6 ? 'pre-market (reported, unverified)' : `sale tier $${fdv / 1e6}M`, pool_usd: (pool / supply) * fdv })),
        pool_tokens: pool, note: 'Day-one community unlock (5.83% of the 3.184B pool). How much of it goes to points holders is not published.' };
      return out;
    },
  },
};
function generic(slug) {
  return { name: slug, slug, unit: 'points', addr: 'any', automated: ['Protocol TVL (DefiLlama)'], manual: ['Your points, rank and total points (if the protocol publishes them)'], login: ['Unknown: check whether the protocol has a public leaderboard API'],
    async pull() { const out = { source: {}, extra: {} }; try { const t = await llamaTvl(slug); out.tvl = t.now; out.tvl_series = t.series; out.source.defillama = 'ok'; } catch (e) { out.source.defillama = 'failed: ' + e.message; } return out; } };
}

// ---------------- analysis: accumulation, rank change, dilution ----------------
function analyze(f) {
  const H = (f.history || []).filter((h) => !h.carried); const last = H[H.length - 1]; if (!last) return { warnings: [], notes: ['No points entered yet: type your points/rank from the protocol\'s leaderboard and press Check now.'], windows: [] };
  const back = (days) => { const t = last.t - days * 86400e3; let b = null; for (const h of H) if (h.t <= t + 3600e3) b = h; return b; };
  const res = { warnings: [], notes: [] };
  const win = (p, label) => {
    if (!p || p === last || last.points == null || p.points == null) return null;
    const dd = (last.t - p.t) / 86400e3; if (dd < 0.04) return null;
    const r = { label, days: +dd.toFixed(2), points_per_day: (last.points - p.points) / dd, points_growth: p.points ? last.points / p.points - 1 : null,
      rank_change: last.rank && p.rank ? p.rank - last.rank : null, tvl_growth: last.tvl && p.tvl ? last.tvl / p.tvl - 1 : null,
      total_growth: last.total_points && p.total_points ? last.total_points / p.total_points - 1 : null,
      share_change: last.share != null && p.share ? last.share / p.share - 1 : null };
    return r;
  };
  res.windows = [win(back(1), '24h'), win(back(7), '7d'), win(back(30), '30d'), win(H[0], 'since first')].filter(Boolean);
  const w = res.windows.find((x) => x.label === '7d') || res.windows[res.windows.length - 1];
  if (w) {
    if (w.share_change != null && w.share_change < -0.02) res.warnings.push(`Dilution: your share of all ${f.unit || 'points'} fell ${Math.abs(w.share_change * 100).toFixed(1)}% over ${w.label} (total grew ${(w.total_growth * 100).toFixed(1)}%, yours ${(w.points_growth * 100).toFixed(1)}%).`);
    else if (w.total_growth != null && w.points_growth != null && w.total_growth > w.points_growth + 0.01) res.warnings.push(`Dilution: total ${f.unit || 'points'} grew faster (${(w.total_growth * 100).toFixed(1)}%) than yours (${(w.points_growth * 100).toFixed(1)}%) over ${w.label}.`);
    if (w.total_growth == null) {
      // total points hidden: compare your accrual rate per $ of TVL between the last two check intervals (time-weighted programs accrue ~ deposit x time)
      const P = H.filter((h) => h.points != null && h.tvl);
      if (P.length >= 3) {
        const [a, b, c] = P.slice(-3), D = 86400e3;
        const r1 = (b.points - a.points) / ((b.t - a.t) / D), r2 = (c.points - b.points) / ((c.t - b.t) / D);
        const k1 = r1 / ((a.tvl + b.tvl) / 2), k2 = r2 / ((b.tvl + c.tvl) / 2);
        if (r1 > 0 && r2 >= 0) { res.rate_per_tvl_change = k2 / k1 - 1;
          if (res.rate_per_tvl_change < -0.05) res.warnings.push(`Possible dilution: your points per day per $ of TVL fell ${Math.abs(res.rate_per_tvl_change * 100).toFixed(1)}% between your last two check intervals (rate ${Math.round(r1).toLocaleString()} -> ${Math.round(r2).toLocaleString()}/day while TVL went ${Math.round(a.tvl / 1e6 * 100) / 100}M -> ${Math.round(c.tvl / 1e6 * 100) / 100}M). Total points are not published, so TVL stands in for everyone else's points.`); }
      }
    }
    if (w.rank_change != null && w.rank_change < 0) res.warnings.push(`Rank slipped ${-w.rank_change} places over ${w.label} (now #${last.rank}).`);
    if (w.points_per_day === 0) res.notes.push(`No new ${f.unit || 'points'} over ${w.label}.`);
  } else res.notes.push('Only one snapshot so far: rates, rank change and dilution appear after the next check (auto-refresh hourly while the page is open, or press Check now).');
  if (f.protocol === 'yo' && last.extra?.merkl_unclaimed_yo > 0) res.notes.push(`${last.extra.merkl_unclaimed_yo.toFixed(1)} YO earned on Merkl but not yet claimed. Claim within 90 days of earning or YO may reassign it. The public leaderboard ranks CLAIMED YO only, so claiming also lifts your rank.`);
  return res;
}

function routes({ DATA_DIR, root }) {
  const FARMS = path.join(DATA_DIR, 'airdrop_farms.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FARMS, 'utf8')); } catch { return { farms: {} }; } };
  const save = (d) => { fs.writeFileSync(FARMS + '.tmp', JSON.stringify(d)); fs.renameSync(FARMS + '.tmp', FARMS); };
  let refreshing = false;
  function desk() {
    const f = path.join(DATA_DIR, 'airdrop_desk.json'); let st = null; try { st = fs.statSync(f); } catch {}
    if ((!st || Date.now() - st.mtimeMs > 6 * 3600e3) && !refreshing && process.env.NO_AUTO_REFRESH !== '1') {
      refreshing = true;
      const ch = spawn('python3', ['airdrops_v2.py'], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      ch.on('exit', () => (refreshing = false)); ch.on('error', () => (refreshing = false));
    }
    if (!st) throw Object.assign(new Error('airdrop_desk.json is being generated (takes ~3-4 min), try again shortly'), { status: 503 });
    const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.refreshing = refreshing; d.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000); return d;
  }
  const adapter = (p) => ADAPTERS[p] || (/^[a-z0-9.\-]{2,60}$/.test(p) ? generic(p) : null);
  async function check(q) {
    const protocol = (q.get('protocol') || '').trim().toLowerCase(); const address = (q.get('address') || '').trim();
    const A = adapter(protocol); if (!A) throw Object.assign(new Error('Unknown protocol. Use yo, townsquare, or a DefiLlama slug.'), { status: 400 });
    if (!isEvm(address) && !isSol(address)) throw Object.assign(new Error('Enter a public wallet address (0x… or Solana). Never a seed phrase or private key.'), { status: 400 });
    const id = `${protocol}:${address.toLowerCase()}`;
    const D = load(); const f = D.farms[id] || (D.farms[id] = { id, protocol, address, name: A.name, unit: A.unit, history: [], created: Date.now() });
    const r = await A.pull(address);
    const man = { points: num(q.get('points')), rank: num(q.get('rank')), total_points: num(q.get('total')) };
    const prev = f.history[f.history.length - 1] || {};
    const snap = { t: Date.now(), points: r.points ?? man.points ?? (A.unit !== 'YO earned' ? prev.points ?? null : null), rank: r.rank ?? man.rank ?? prev.rank ?? null,
      total_points: r.total_points ?? man.total_points ?? prev.total_points ?? null, total_users: r.total_users ?? null, tvl: r.tvl ?? null, deposit_usd: r.deposit_usd ?? null,
      manual: Object.values(man).some((v) => v != null), carried: r.points == null && man.points == null && prev.points != null, extra: r.extra };
    snap.share = snap.points != null && snap.total_points ? snap.points / snap.total_points : null;
    if (q.get('deposit')) snap.deposit_usd = num(q.get('deposit'));
    if (snap.share == null && snap.deposit_usd && snap.tvl) snap.capital_share = snap.deposit_usd / snap.tvl;
    // collapse auto snapshots closer than 50 min (keeps history light); manual entries always kept
    if (prev.t && snap.t - prev.t < 50 * 60e3 && !snap.manual && !prev.manual) f.history[f.history.length - 1] = snap; else f.history.push(snap);
    if (f.history.length > 2000) f.history = f.history.slice(-2000);
    if (q.get('label')) f.label = q.get('label').slice(0, 60);
    if (r.value) f.lastValue = r.value; if (r.source) f.lastSources = r.source;
    save(D);
    return view(f, A, r);
  }
  function view(f, A, r) {
    const last = f.history[f.history.length - 1] || {};
    const series = r?.tvl_series || [];
    const first = f.history[0];
    return { ...f, history: f.history.slice(-400).map(({ extra, ...h }) => h), last, analysis: analyze(f), sources: r?.source || f.lastSources, value: r?.value || f.lastValue,
      adapter: { name: A.name, automated: A.automated, manual: A.manual, login: A.login, notes: A.notes, unit: A.unit },
      tvl_since_first: first && series.length ? { at_first: tvlAt(series, first.t), now: series[series.length - 1][1] } : null,
      tvl_weekly: series.filter((_, i) => i % 7 === 0).slice(-60).map(([t, v]) => [new Date(t).toISOString().slice(0, 10), Math.round(v)]) };
  }
  return {
    async '/api/airdrops/desk'() { return desk(); },
    // Airdrop ROI ranking (research/airdrops_roi.py, refreshed weekly by the server scheduler or scripts/airdrop_roi_weekly.sh)
    async '/api/airdrops/roi'() {
      const f = path.join(DATA_DIR, 'airdrop_roi.json'); let st = null; try { st = fs.statSync(f); } catch {}
      if (!st) throw Object.assign(new Error('airdrop_roi.json not built yet (run research/airdrops_roi.py)'), { status: 503 });
      const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000); return d;
    },
    async '/api/airdrops/adapters'() { return Object.fromEntries(Object.entries(ADAPTERS).map(([k, a]) => [k, { name: a.name, chains: a.chains, unit: a.unit, automated: a.automated, manual: a.manual, login: a.login, notes: a.notes }])); },
    async '/api/airdrops/farm'(q) { return check(q); },
    async '/api/airdrops/farms'(q) {
      const D = load(); const out = [];
      for (const f of Object.values(D.farms)) {
        const A = adapter(f.protocol);
        if (q.get('refresh') === '1') { try { out.push(await check(new URLSearchParams({ protocol: f.protocol, address: f.address }))); continue; } catch (e) { /* fall through to stored view */ } }
        let r = null; try { const t = await llamaTvl(A.slug); r = { tvl_series: t.series }; } catch {}
        out.push(view(f, A, r));
      }
      return { farms: out };
    },
    async '/api/airdrops/farm/delete'(q) { const D = load(); const id = q.get('id'); const ok = !!D.farms[id]; delete D.farms[id]; save(D); return { ok }; },
  };
}
module.exports = { routes, analyze, ADAPTERS };
