// Specialised "desks": each runs its own loop and produces a ranked digest + a rule-based summary of what changed in the last hour.
// No LLM; templates only. The user makes the calls. Not financial advice.
'use strict';
const fs = require('fs');
const path = require('path');

const POS = ['surge', 'soar', 'rally', 'jump', 'record', 'gain', 'rise', 'rises', 'bull', 'approve', 'approval', 'inflow', 'beat', 'upgrade', 'launch', 'partnership', 'adopt', 'buy', 'breakout', 'cut rates', 'rate cut', 'eases', 'recover', 'high', 'boost', 'wins', 'etf'];
const NEG = ['crash', 'plunge', 'drop', 'fall', 'falls', 'slump', 'bear', 'hack', 'exploit', 'lawsuit', 'sue', 'ban', 'outflow', 'miss', 'downgrade', 'liquidat', 'fraud', 'scam', 'rug', 'delist', 'probe', 'sell-off', 'selloff', 'fear', 'warn', 'hike', 'inflation', 'default', 'arrest', 'charges', 'loss', 'low', 'dump'];
const MAJORS = { BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i, XRP: /\b(xrp|ripple)\b/i, BNB: /\b(bnb|binance coin)\b/i, DOGE: /\b(dogecoin|doge)\b/i, ZEC: /\b(zcash|zec)\b/i, HYPE: /\b(hyperliquid|hype)\b/i, SUI: /\bsui\b/i, TON: /\b(toncoin|ton)\b/i };
const COMPANIES = { AAPL: /\bapple\b/i, MSFT: /\bmicrosoft\b/i, NVDA: /\bnvidia\b/i, TSLA: /\btesla\b/i, AMZN: /\bamazon\b/i, META: /\bmeta platforms|\bmeta\b/i, GOOGL: /\b(google|alphabet)\b/i, COIN: /\bcoinbase\b/i, MSTR: /\b(microstrategy|strategy inc)\b/i, HOOD: /\brobinhood\b/i, AMD: /\bamd\b/i, PLTR: /\bpalantir\b/i, JPM: /\bjpmorgan\b/i, BLK: /\bblackrock\b/i };

function sentiment(t) {
  const s = t.toLowerCase(); let p = 0, n = 0;
  for (const w of POS) if (s.includes(w)) p++;
  for (const w of NEG) if (s.includes(w)) n++;
  return { score: p - n, label: p > n ? 'bullish' : n > p ? 'bearish' : 'neutral' };
}

function createDesks({ DATA_DIR, live, calls, rug, macro, nansen, readData, log = () => {} }) {
  const file = path.join(DATA_DIR, 'desks.json');
  let H = {}; try { H = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const D = {};
  const hist = (name, snap) => { const L = (H[name] ||= []); L.push({ t: Date.now(), ...snap }); const cut = Date.now() - 26 * 3600e3; H[name] = L.filter((x) => x.t > cut).slice(-400); };
  const hourAgo = (name) => { const L = H[name] || []; return [...L].reverse().find((x) => Date.now() - x.t >= 55 * 60e3) || L[0]; };
  const persist = () => { try { fs.writeFileSync(file, JSON.stringify(H)); } catch {} };
  const pct = (x) => (x == null ? '?' : (x >= 0 ? '+' : '') + x.toFixed(0) + '%');
  const usd = (n) => (n == null ? '?' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toFixed(0));

  function crypto() {
    const f = live.feed(); const items = f.items || [];
    const A = items.filter((x) => x.grade === 'A'), B = items.filter((x) => x.grade === 'B');
    const prev = hourAgo('crypto');
    const newA = prev ? A.filter((x) => !(prev.aKeys || []).includes(x.key)) : A;
    const vetoed = items.filter((x) => x.veto).length;
    const slow = items.filter((x) => x.rug && x.rug.score >= 45);
    const rc = calls.reportCard().byGrade;
    const lines = [];
    lines.push(`${f.universe || 0} tokens tracked on ${(f.chains || []).length} chains, ${f.scanned || 0} scanned; ${A.length} A, ${B.length} B, ${vetoed} vetoed for rug flags.`);
    if (newA.length) lines.push(`New A in the last hour: ${newA.slice(0, 5).map((x) => `$${x.symbol} (${x.chain}, ${x.score})`).join(', ')}.`); else lines.push('No new A-grade token in the last hour.');
    const mv = [...items].filter((x) => x.ch1 != null && x.liq > 20000).sort((a, b) => b.ch1 - a.ch1)[0];
    if (mv) lines.push(`Top 1h mover with >$20K liquidity: $${mv.symbol} ${pct(mv.ch1)} (grade ${mv.grade}).`);
    if (slow.length) lines.push(`${slow.length} on slow-rug watch (rug forecast >= 45).`);
    const nf = nansen?.enabled ? nansen.netflowTop(5) : []; if (nf.length) lines.push(`Nansen smart-money 24h net buys: ${nf.slice(0, 4).map((r) => `${r.token_symbol} (${r.chain}) +$${Math.round((r.net_flow_24h_usd || 0) / 1000)}K`).join(', ')}.`);
    if (rc.A?.n) lines.push(`Report card: ${rc.A.n} A calls so far, ${rc.A.hit2x != null ? Math.round(rc.A.hit2x * 100) : '?'}% reached 2x, median now ${pct(rc.A.medianNow)}.`);
    hist('crypto', { aKeys: A.map((x) => x.key), n: items.length });
    return { name: 'Crypto Desk', updatedAt: f.generatedAt, summary: lines, top: items.filter((x) => !x.veto).slice(0, 12), slowRug: slow.sort((a, b) => b.rug.score - a.rug.score).slice(0, 10) };
  }
  function options() {
    let d; try { d = readData('options.json'); } catch { return { name: 'Stocks & Options Desk', summary: ['Options data not generated yet.'], top: [] }; }
    const one = []; const seen = new Set(); for (const p of d.picks) if (p.grade === 'A' && p.live_quote && !seen.has(p.underlying) && seen.add(p.underlying)) one.push(p);
    const prev = hourAgo('options'); const newU = prev ? one.filter((p) => !(prev.und || []).includes(p.underlying)).map((p) => p.underlying) : [];
    const lines = [`${d.universe.eligible.toLocaleString()} long options screened (${d.universe.stock_underlyings.length} stocks/ETFs + ${d.universe.derive_priced} Derive crypto options); ${d.grades.A || 0} graded A.`,
      one.length ? `Best A per underlying: ${one.slice(0, 5).map((p) => `${p.underlying} ${p.type} ${p.strike} ${p.expiry} (EV ${pct(p.ev_pct)})`).join('; ')}.` : 'No live-quoted A picks.',
      `${(d.unusual || []).length} unusual-volume contracts (vol >= 1.5x OI).`, newU.length ? `New underlyings with an A pick vs an hour ago: ${newU.join(', ')}.` : 'A-pick underlyings unchanged vs an hour ago.'];
    hist('options', { und: one.map((p) => p.underlying) });
    return { name: 'Stocks & Options Desk', updatedAt: d.generatedAt, summary: lines, top: one.slice(0, 10), unusual: (d.unusual || []).slice(0, 8) };
  }
  let macroSnap = null, newsSnap = null;
  async function refreshMacro() { try { macroSnap = await macro.snapshot(); } catch (e) { log('macro desk: ' + e.message); } }
  async function refreshNews() { try { newsSnap = await macro.news(); } catch (e) { log('news desk: ' + e.message); } }
  function macroDesk() {
    const m = macroSnap; if (!m) return { name: 'Macro/Fed Desk', summary: ['Loading FRED/Fed data…'] };
    const prev = hourAgo('macro');
    const ke = m.fed?.kalshi?.[0]; const k0 = ke?.outcomes?.[0]; const k = k0 ? { q: `${ke.title} ${k0.outcome}`, yes: k0.prob } : null;
    const lines = [`Fed funds target ${m.fed?.target?.lower}-${m.fed?.target?.upper}% (effective ${m.fed?.effective?.v}%); next FOMC ${m.fed?.nextMeeting?.label || '?'}.`,
      `2y ${m.yields?.dgs2?.v}%, 10y ${m.yields?.dgs10?.v}%, 2s10s ${m.yields?.spread2s10s}.`,
      k ? `Market odds (Kalshi): ${k.q} ${Math.round((k.yes || 0) * 100)}%.` : 'No market odds available.',
      `Last jobs: ${m.data?.nfp?.change}K (${m.data?.nfp?.refMonth}); unemployment ${m.data?.unrate?.v}%; CPI y/y ${m.data?.cpi?.yoy?.toFixed(1)}%. Next NFP ${m.calendar?.nfp?.next}, next CPI ${m.calendar?.cpi?.next}.`];
    if (prev && prev.k != null && k && Math.abs((k.yes || 0) - prev.k) >= 0.05) lines.push(`Odds moved ${Math.round(((k.yes || 0) - prev.k) * 100)}pp in the last hour.`);
    hist('macro', { k: k?.yes ?? null });
    return { name: 'Macro/Fed Desk', updatedAt: Date.parse(m.asOf), summary: lines, snapshot: m };
  }
  function newsDesk() {
    const n = newsSnap; if (!n) return { name: 'News Desk', summary: ['Loading headlines…'], items: [] };
    const feed = live.feed().items || [];
    const syms = new Map(); for (const x of feed.slice(0, 300)) if (x.symbol && x.symbol.length >= 3 && !/^(THE|AND|FOR|USD|SOL|ETH|BTC)$/i.test(x.symbol)) syms.set(x.symbol.toUpperCase(), x);
    let opt = []; try { opt = readData('options.json').universe.stock_underlyings; } catch {}
    const items = n.items.map((it) => {
      const s = sentiment(it.title); const m = new Set();
      for (const [k, rx] of Object.entries(MAJORS)) if (rx.test(it.title)) m.add(k);
      for (const [k, rx] of Object.entries(COMPANIES)) if (rx.test(it.title)) m.add(k);
      for (const t of it.title.match(/\$[A-Z]{2,10}|\b[A-Z]{3,6}\b/g) || []) { const u = t.replace('$', ''); if (opt.includes(u) || syms.has(u)) m.add(u); }
      const links = [...m].map((x) => ({ sym: x, feed: syms.get(x) ? { key: syms.get(x).key, grade: syms.get(x).grade } : null, options: opt.includes(x) }));
      return { ...it, sentiment: s, mentions: links };
    });
    const hr = items.filter((x) => x.ts && Date.now() - x.ts < 3600e3); const h6 = items.filter((x) => x.ts && Date.now() - x.ts < 6 * 3600e3);
    const net = (hr.length ? hr : h6).reduce((a, x) => a + x.sentiment.score, 0);
    const cnt = {}; for (const x of items.slice(0, 60)) for (const m of x.mentions) cnt[m.sym] = (cnt[m.sym] || 0) + 1;
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const lines = [`${hr.length} headlines in the last hour (${h6.length} in 6h), net tone ${net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral'} (${net >= 0 ? '+' : ''}${net}, keyword lexicon).`,
      top.length ? `Most mentioned: ${top.map(([k, v]) => `${k} (${v})`).join(', ')}.` : 'No tickers detected.',
      items.find((x) => x.cat === 'fed') ? `Latest Fed item: ${items.find((x) => x.cat === 'fed').title.slice(0, 120)}.` : ''].filter(Boolean);
    return { name: 'News Desk', updatedAt: Date.now(), summary: lines, items: items.slice(0, 60), status: n.status };
  }
  function airdrops() {
    let d; try { d = readData('airdrops.json'); } catch { return { name: 'Airdrop Desk', summary: ['Airdrop data not generated yet.'], top: [] }; }
    const live_ = d.campaigns.filter((c) => !c.claim_live);
    const prev = hourAgo('airdrops'); const nw = prev ? live_.filter((c) => !(prev.keys || []).includes(c.key)) : [];
    const lines = [`${d.count} campaigns ranked; ${live_.filter((c) => c.grade === 'A' || c.grade === 'B').length} graded A/B and still open.`,
      `Top: ${live_.slice(0, 3).map((c) => `${c.name} (${c.grade}${c.raised_usd ? ', raised ' + usd(c.raised_usd) : ''})`).join('; ')}.`, nw.length ? `New since last hour: ${nw.slice(0, 4).map((c) => c.name).join(', ')}.` : 'No new campaigns in the last hour.'];
    hist('airdrops', { keys: live_.map((c) => c.key) });
    return { name: 'Airdrop Desk', updatedAt: d.generatedAt, summary: lines, top: live_.slice(0, 8) };
  }
  function sleeperDesk() {
    let d; try { d = readData('sleepers.json'); } catch { return { name: 'Sleeper Desk', summary: ['Sleeper screen not generated yet.'], top: [] }; }
    const A = d.items.filter((x) => x.grade === 'A' || x.grade === 'B');
    const hot = (d.hotSectors || []).slice(0, 3).map((s) => `${s} ${pct(d.heatmap[s]?.median30d)}`);
    const acc = d.items.filter((x) => x.accumulation?.flag);
    const lines = [`${d.items.length} established tokens deep-scored (of ${d.prescreened} >=50% below ATH); ${A.length} graded A/B.`, hot.length ? `Hottest sectors (30d median): ${hot.join(', ')}.` : '',
      A.length ? `Leaders: ${A.slice(0, 4).map((x) => `${x.symbol} ${x.grade} (${x.drawdown_pct.toFixed(0)}% below ATH)`).join(', ')}.` : '', acc.length ? `Accumulation-phase flags: ${acc.slice(0, 5).map((x) => x.symbol).join(', ')}.` : 'No accumulation-phase flags.',
      d.laggards?.length ? `Laggards in hot sectors: ${d.laggards.slice(0, 4).map((x) => x.symbol).join(', ')}.` : ''].filter(Boolean);
    // Nansen 7d flows for the top sleepers (cached 24h; fetched in the background, max 3 credits/day via sub-cap)
    let smAcc = [];
    if (nansen?.enabled) for (const x of d.items.slice(0, 10)) {
      if (!x.contract) continue; const f = nansen.peekFlow(x.contract.chain, x.contract.address, '7d');
      if (f) { x.nansen7d = f; if (f.smart > 0 && f.smartWallets >= 2) smAcc.push(x.symbol); }
      else if (d.items.indexOf(x) < 3) nansen.flow(x.contract.chain, x.contract.address, '7d', 'flow_sleeper').catch(() => {});
    }
    if (smAcc.length) lines.push(`Nansen: smart money net buying (7d) in ${smAcc.join(', ')}.`);
    return { name: 'Sleeper Desk', updatedAt: d.generatedAt, summary: lines, top: d.items.slice(0, 10), heatmap: d.heatmap };
  }
  async function tick() {
    try {
      D.crypto = crypto(); D.options = options(); D.macro = macroDesk(); D.news = newsDesk(); D.airdrops = airdrops(); D.sleepers = sleeperDesk();
      D.generatedAt = Date.now(); persist();
      try { fs.writeFileSync(path.join(DATA_DIR, 'desks_snapshot.json'), JSON.stringify(D)); } catch {} // served read-only in RENDER_LITE
    } catch (e) { log('desks: ' + e.stack); }
  }
  return {
    start() {
      refreshMacro(); refreshNews();
      setInterval(refreshMacro, 10 * 60e3).unref(); setInterval(refreshNews, 3 * 60e3).unref();
      setTimeout(tick, 8000); setInterval(tick, 60e3).unref();
    },
    all: () => { // RENDER_LITE: no tick loop, so serve the last snapshot written by a full instance (seeded into the image)
      if (!D.generatedAt && process.env.RENDER_LITE === '1') { try { Object.assign(D, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'desks_snapshot.json'), 'utf8')), { snapshot: true }); } catch {} }
      return D;
    }, tick, sentiment,
  };
}
module.exports = { createDesks, sentiment };
