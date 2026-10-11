'use strict';
// Pattern Lab EXPANSION (rules 38+ and categories A-J). Serves data/patternlab_ext.json (built by research/patternlab_ext/build.py)
// plus live flags computed on request from the live feed for the rules that only need feed features. Read-only, no paid calls.
const fs = require('fs');
const path = require('path');
function load(DATA_DIR, f) { try { const st = fs.statSync(path.join(DATA_DIR, f)); return { ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) }; } catch { return null; } }

// Same windows as research/patternlab_ext/rules_38_42.py (cohort prior: hours carrying >=60% of baseline volume, max 12)
function priorWindow(DATA_DIR) {
  const h = load(DATA_DIR, 'patterns_hours.json');
  const share = (h && h.baseline_volume_share) || Array(24).fill(1 / 24);
  const order = [...share.keys()].sort((a, b) => share[b] - share[a]); const tot = share.reduce((a, b) => a + b, 0);
  const out = new Set(); let s = 0;
  for (const i of order) { out.add(i); s += share[i]; if (s >= 0.6 * tot || out.size >= 12) break; }
  return out;
}

function liveFlags(DATA_DIR, feed) {
  const items = (feed && feed.items) || [];
  const win = priorWindow(DATA_DIR); const hr = new Date().getUTCHours(); const inWin = win.has(hr);
  const pick = (fn, why, cap = 25) => items.filter((x) => x.features && fn(x.features, x)).slice(0, cap).map((x) => ({ symbol: x.symbol, key: x.key, chain: x.chain, why: why(x.features, x) }));
  return {
    38: pick((f, x) => x.ch1 != null && Math.abs(x.ch1) >= 15 && (f.v1h || 0) > 0, (f, x) => `${x.ch1}% 1h at ${hr}:00 UTC — ${inWin ? 'inside' : 'OUTSIDE (discount)'} the active window`),
    41: pick((f, x) => f.socials === 0 && (f.hVel || 0) >= 20 && Math.abs(x.ch1 || 0) < 15 && (f.bp || 0) >= 0.55, (f, x) => `no socials, holders +${Math.round(f.hVel)}/h, buys ${Math.round((f.bp || 0) * 100)}% of txns, price ${x.ch1}% 1h`),
    47: pick((f) => (f.smart || 0) >= 2, (f) => `${f.smart} smart-money wallets in`),
    56: pick((f) => (f.devPrior || 0) >= 3, (f) => `deployer has ${f.devPrior} prior launches (${f.devGrad || 0} graduated)`),
    G1: pick((f) => (f.themeHeat || 0) >= 0.5, (f) => `theme ${f.theme} heat ${f.themeHeat}`),
    57: pick((f) => f.socials === 0 && (f.ageH ?? 0) >= 1 && (f.ageH ?? 99) <= 24, (f) => `no X / Telegram / website ${Math.round(f.ageH)}h after creation`),
    59: pick((f) => f.ageH != null && f.ageH <= 24 && (() => { const h = new Date(Date.now() - f.ageH * 3600e3).getUTCHours(); return h >= 0 && h < 8; })(), (f) => `created ~${new Date(Date.now() - f.ageH * 3600e3).getUTCHours()}:00 UTC (Asia hours), ${Math.round(f.ageH * 10) / 10}h old`),
    60: pick((f) => (f.boosts || 0) > 0 && (f.ageH ?? 99) <= 2, (f) => `${f.boosts} paid DexScreener boost(s) at ${Math.round(f.ageH * 60)} min old`),
    ...tapeFlags(DATA_DIR, items),
    ...peerValueFlags(items),
    _meta: { utcHour: hr, activeWindowPrior: [...win].sort((a, b) => a - b), inWindow: inWin, feedItems: items.length },
  };
}

function api(DATA_DIR, feed, q) {
  const d = load(DATA_DIR, 'patternlab_ext.json');
  if (!d) return { ok: false, error: 'data/patternlab_ext.json not built yet — run research/patternlab_ext/run.sh' };
  const lf = liveFlags(DATA_DIR, feed);
  const rows = (d.rows || []).map((r) => {
    const live = lf[r.id];
    const merged = live ? [...live, ...(r.live_flags || [])] : (r.live_flags || []);
    const o = { ...r, live_flags: merged.slice(0, 40), n_live_flags: merged.length };
    // Pattern Lab (lib/patternlab.js table()) compatible summary, so public/patternlab_ext.js renders identical columns
    const b = (r.backtest || {})[r.primary_set] || null;
    o.pl = {
      status: r.status === 'not-feasible' ? 'nf' : r.status,
      backtest: b ? { set: r.primary_set, crashed: `${b.flag_crashed}/${b.n_crashed}`, runners: `${b.flag_runners}/${b.n_runners}`, p_crash: b.crash.p_one_sided, p_pump: b.pump.p_one_sided,
        lead_crash_h: b.crash.lead_h_median, lead_pump_h: b.pump.lead_h_median, verdict: b.verdict, false_flag_crash: b.crash.false_flag_rate, false_flag_pump: b.pump.false_flag_rate,
        untestable: b.n_untestable, q_bh: r.q_bh, era_matched: b.era_matched || null } : null,
      live: { count: merged.length, items: merged.slice(0, 12).map((x) => ({ sym: x.symbol, key: x.key, value: x.why })) },
    };
    if (!(q && q.get && q.get('full') === '1')) {
      const other = Object.keys(r.backtest || {}).filter((k) => r.backtest[k] && k !== r.primary_set)[0];
      if (other) { const x = r.backtest[other]; o.other_set = { set: other, crashed: `${x.flag_crashed}/${x.n_crashed}`, runners: `${x.flag_runners}/${x.n_runners}`, p_crash: x.crash.p_one_sided, p_pump: x.pump.p_one_sided, verdict: x.verdict }; }
      delete o.backtest; o.extra_keys = Object.keys(r.extra || {}); delete o.extra;
    }
    return o;
  });
  const id = q && q.get && q.get('id');
  return { ...d, rows: id ? rows.filter((r) => String(r.id) === id) : rows, live_meta: lf._meta };
}

function routes({ DATA_DIR, live }) {
  // keep the build-time live flags (39 catalysts, 40/40b majors FDV/TVL, A2, B1, F5, G2) fresh: rebuild every PLX_REBUILD_H (12 h) from caches +
  // free endpoints only (run.sh without --fetch never spends Nansen credits). NO_AUTO_REFRESH=1 or PLX_REBUILD=off disables.
  let rebuilding = false; const H = +(process.env.PLX_REBUILD_H || 12) * 3600e3;
  const rebuild = () => { if (rebuilding || process.env.NO_AUTO_REFRESH === '1' || process.env.PLX_REBUILD === 'off') return; let age = Infinity; try { age = Date.now() - fs.statSync(path.join(DATA_DIR, 'patternlab_ext.json')).mtimeMs; } catch {}
    if (age < H) return; rebuilding = true; const ch = require('child_process').spawn('bash', ['run.sh'], { cwd: path.join(__dirname, '..', 'research', 'patternlab_ext'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
    ch.on('exit', () => { rebuilding = false; fcache.t = 0; }); ch.on('error', () => { rebuilding = false; }); };
  setTimeout(rebuild, 10 * 60e3).unref?.(); setInterval(rebuild, 60 * 60e3).unref?.();
  const feed = () => { try { return live ? live.feed() : JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_feed.json'), 'utf8')); } catch { return null; } };
  return { async '/api/patternlab/ext'(q) { return api(DATA_DIR, feed(), q); } };
}

// ---------- LIVE tape rules (same definitions as research/patternlab_ext/cats_gen.py + rules_38_42.py r42) ----------
// Input: data/patternlab_ext_cache/live_tapes.json = the last <=300 GeckoTerminal swaps per token that lib/fakevolume.js already fetched
// for its live scan (top ~40 live-feed tokens every 20 min; no extra API calls). Differences vs the backtest (stated in every flag):
// GT tapes have no Nansen wallet labels (so 47 smart money uses the live-feed `smart` feature, and 50/51/54 stay backtest-only) and are the
// LATEST 300 swaps, not the first 300; the early-life rules (44, 52, 55) run only when the tape reaches back to pool creation.
function loadTapes(DATA_DIR) { const d = load(DATA_DIR, 'patternlab_ext_cache/live_tapes.json'); if (!d || Date.now() - (d.generatedAt || 0) > 2 * 3600e3) return null; return d; }
const TR = {
  A1(tr) { const b = tr.filter((r) => r.s && r.q > 0); for (let i = 0; i < b.length; i++) { const r = b[i]; const g = new Set(b.slice(i, i + 40).filter((x) => x.t - r.t <= 2 && Math.abs(x.q / r.q - 1) <= 0.05).map((x) => x.w)); if (g.size >= 5) return `${g.size} wallets bought the same size (±5%) within 2 s`; } return null; },
  E1(tr) { const seen = new Map(); for (const r of tr) { if (!r.s || !(r.q > 0) || Math.abs(r.q * 20 - Math.round(r.q * 20)) < 1e-6) continue; const k = +r.q.toPrecision(4); const st = seen.get(k) || new Set(); st.add(r.w); seen.set(k, st); if (st.size >= 3) return `same odd buy size ${k} reused by ${st.size} wallets`; } return null; },
  F1(tr) { let cum = 0; for (let i = 0; i < tr.length; i++) { const r = tr[i]; if (i >= 20 && !r.s && r.usd >= 500 && r.usd >= 0.1 * cum) return `single sell $${Math.round(r.usd)} = ${Math.round(r.usd / cum * 100)}% of prior tape volume`; cum += r.usd; } return null; },
  H1(tr) { let n = 0; for (let i = 0; i < tr.length; i++) { const r = tr[i]; if (!r.s) continue; for (let j = i + 2; j < Math.min(i + 8, tr.length); j++) { const x = tr[j]; if (x.t - r.t > 2) break; if (x.w === r.w && !x.s && tr.slice(i + 1, j).some((y) => y.w !== r.w)) { n++; break; } } if (n >= 3) return `${n} sandwich-shaped buy→sell pairs within 2 s`; } return null; },
  43(tr, ctx) { const dev = ctx.dev; if (!dev) return null; const s = tr.find((r) => !r.s && r.w === dev); return s ? `deployer ${dev.slice(0, 6)}… sold $${Math.round(s.usd)}` : null; },
  44(tr, ctx) { if (!ctx.fromLaunch) return null; const t0 = tr[0].t; const tot = tr.filter((r) => r.s).reduce((a, r) => a + r.usd, 0) || 1; const s = tr.filter((r) => r.s && r.t - t0 <= 5).reduce((a, r) => a + r.usd, 0); return s / tot >= 0.2 ? `${Math.round(s / tot * 100)}% of early buy volume in the first 5 s` : null; },
  45(tr) { const first = new Map(), flips = new Set(); for (const r of tr) { if (r.s && !first.has(r.w)) first.set(r.w, r.t); else if (!r.s && first.has(r.w) && r.t - first.get(r.w) <= 600) flips.add(r.w); } const ws = [...first.keys()].slice(0, 100); if (ws.length < 30) return null; const sh = ws.filter((w) => flips.has(w)).length / ws.length; return sh >= 0.4 ? `${Math.round(sh * 100)}% of first ${ws.length} buyers sold within 10 min` : null; },
  46(tr) { const v = new Map(); for (const r of tr) if (r.s) v.set(r.w, (v.get(r.w) || 0) + r.usd); const tot = [...v.values()].reduce((a, b) => a + b, 0) || 1; const top = [...v.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0); return top / tot >= 0.5 ? `top-5 wallets = ${Math.round(top / tot * 100)}% of buy volume in tape` : null; },
  48(tr) { const q = Math.floor(tr.length / 4); if (q < 10) return null; const s1 = tr.slice(0, q).filter((r) => !r.s).length / q, s4 = tr.slice(-q).filter((r) => !r.s).length / q; return s4 >= 0.55 && s4 >= s1 + 0.15 ? `sell share ${Math.round(s1 * 100)}% → ${Math.round(s4 * 100)}% (first vs last quarter)` : null; },
  49(tr) { const nb = new Map(), ns = new Map(), v = new Map(); for (const r of tr) { (r.s ? nb : ns).set(r.w, ((r.s ? nb : ns).get(r.w) || 0) + 1); v.set(r.w, (v.get(r.w) || 0) + r.usd); } const tot = [...v.values()].reduce((a, b) => a + b, 0) || 1; const w = [...v.keys()].filter((a) => (nb.get(a) || 0) >= 3 && (ns.get(a) || 0) >= 3); const sh = w.reduce((a, k) => a + v.get(k), 0) / tot; return sh >= 0.2 ? `${w.length} wallets with ≥3 buys and ≥3 sells = ${Math.round(sh * 100)}% of volume` : null; },
  52(tr, ctx) { if (!ctx.fromLaunch) return null; const t0 = tr[0].t; const ws = new Set(); for (const r of tr) { if (r.t - t0 > 1800) break; ws.add(r.w); if (ws.size >= 150) return `≥150 distinct wallets in the first 30 min`; } return null; },
  53(tr) { const b = tr.filter((r) => r.s).map((r) => r.usd).sort((a, b) => a - b); if (!b.length) return null; const m = b[Math.floor(b.length / 2)]; return m >= 50 ? `median buy $${Math.round(m)}` : null; },
  55(tr, ctx) { if (!ctx.fromLaunch) return null; const t0 = tr[0].t; const a = tr.filter((r) => r.t - t0 < 600).length, b = tr.filter((r) => r.t - t0 >= 600 && r.t - t0 < 1200).length; if (a < 20 || tr[tr.length - 1].t - t0 < 1200) return null; return b < 0.3 * a ? `trades fell ${a} → ${b} (min 0-10 vs 10-20)` : null; },
};
function tapeFlags(DATA_DIR, items) {
  const D = loadTapes(DATA_DIR); const out = {}; for (const k of [...Object.keys(TR), '42']) out[k] = [];
  if (!D) return out;
  const byKey = new Map(items.map((x) => [x.key, x])); const w2t = new Map(); const tapes = [];
  for (const [key, v] of Object.entries(D.tokens || {})) {
    const tr = (v.trades || []).filter((r) => r.w && r.t).sort((a, b) => a.t - b.t); if (tr.length < 30) continue;
    const x = byKey.get(key) || {}; const fromLaunch = !!(v.poolCreatedAt && tr[0].t * 1000 - v.poolCreatedAt <= 180e3);
    const ctx = { fromLaunch, dev: x.deep?.dev || x.rug?.dev || x.features?.dev || x.creator || null };
    const base = { symbol: x.symbol || v.symbol || null, key, chain: key.split(':')[0], price: x.price ?? null, liq: x.liq ?? null };
    const scope = fromLaunch ? 'launch tape' : `last ${tr.length} swaps`;
    for (const [id, fn] of Object.entries(TR)) { let why = null; try { why = fn(tr, ctx); } catch {} if (why) out[id].push({ ...base, why: `${why} (${scope}, GT)` }); }
    const ws = new Set(tr.map((r) => r.w)); tapes.push({ key, base, ws }); for (const w of ws) { if (!w2t.has(w)) w2t.set(w, new Set()); w2t.get(w).add(key); }
  }
  // 42 closed-loop rotation across the tapes we hold (same wallets in 3-12 of them; >12 = router/aggregator)
  for (const t of tapes) { const rot = [...t.ws].filter((w) => { const n = w2t.get(w).size; return n >= 3 && n <= 12; }); const sh = rot.length / (t.ws.size || 1);
    if (sh >= 0.1 && rot.length >= 5) out['42'].push({ ...t.base, why: `${rot.length} wallets (${Math.round(sh * 100)}%) also trade ≥2 other watched tokens (closed loop, ${tapes.length} live tapes)` }); }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 25);
  return out;
}

// 40 / 40b live, memecoin version (same proxy as the backtest): market cap per $ of cumulative traded volume vs age-matched live peers.
// Cumulative volume for tokens <= 24 h old ~= 24 h volume. Buckets 0-1 h, 1-6 h, 6-24 h; needs >= 8 peers per bucket.
function peerValueFlags(items) {
  const B = [[0, 1], [1, 6], [6, 24]]; const out = { 40: [], '40b': [] };
  for (const [lo, hi] of B) { const xs = items.filter((x) => x.features && x.features.ageH != null && x.features.ageH > lo && x.features.ageH <= hi && (x.mcap || x.fdv) > 0 && (x.vol24 || 0) > 0).map((x) => ({ x, r: (x.mcap || x.fdv) / x.vol24 }));
    if (xs.length < 8) continue; const med = xs.map((o) => o.r).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const { x, r } of xs) { const g = r / med; const base = { symbol: x.symbol, key: x.key, chain: x.chain, price: x.price ?? null, liq: x.liq ?? null };
      if (g >= 3) out[40].push({ ...base, why: `mcap/cum. volume ${r.toFixed(2)} = ${g.toFixed(1)}x the ${lo}-${hi}h peer median (${xs.length} peers)` });
      else if (g <= 1 / 3) out['40b'].push({ ...base, why: `mcap/cum. volume ${r.toFixed(2)} = ${g.toFixed(2)}x the ${lo}-${hi}h peer median (${xs.length} peers)` }); } }
  out[40] = out[40].slice(0, 25); out['40b'] = out['40b'].slice(0, 25); return out;
}

// ---------- composite adjustment + signal-bus plugin ----------
// Weights only for ROBUST rules (BH q<0.10 and era-matched p<0.10 in data/patternlab_ext.json) that can be evaluated live; every other
// firing rule is shown as info (0). Direction from the backtest verdict. Documented in PATTERN_LAB_EXT.md ("Live wiring").
const XW = { '40b': -3, 40: 2, 44: 2, 47: 2, 59: 1 };
let fcache = { t: 0, v: null };
function flagsCached(DATA_DIR, feed) { if (Date.now() - fcache.t < 60e3 && fcache.v) return fcache.v; const d = load(DATA_DIR, 'patternlab_ext.json'); const lf = liveFlags(DATA_DIR, feed);
  const rows = new Map((d?.rows || []).map((r) => [String(r.id), r])); const all = {};
  for (const [id, r] of rows) { const fl = [...(lf[id] || []), ...(r.live_flags || [])]; if (fl.length) all[id] = fl; }
  fcache = { t: Date.now(), v: { rows, all } }; return fcache.v; }
const verdictDir = (r) => { const v = ((r?.backtest || {})[r?.primary_set] || {}).verdict || ''; return /pump/.test(v) ? 'pump' : /crash/.test(v) ? 'crash' : null; };
function compositeFactor(DATA_DIR, feed, { key, sym } = {}) {
  const { rows, all } = flagsCached(DATA_DIR, feed); const S = sym ? String(sym).toUpperCase() : null; const hits = [];
  for (const [id, fl] of Object.entries(all)) { const e = fl.find((x) => (key && x.key && x.key.toLowerCase() === String(key).toLowerCase()) || (!x.key && S && String(x.symbol || '').toUpperCase() === S)); if (e) hits.push({ id, r: rows.get(id), e }); }
  if (!hits.length) return null;
  const adj = Math.max(-6, Math.min(6, hits.reduce((s, h) => s + (h.e.key ? XW[h.id] || 0 : 0), 0)));
  return { adj, value: hits.map((h) => '#' + h.id).join(' '), text: 'Pattern Lab EXT: ' + hits.map((h) => `${h.r?.name || h.id} — ${h.e.why}${XW[h.id] && h.e.key ? ` (${XW[h.id] > 0 ? '+' : ''}${XW[h.id]}, robust ${verdictDir(h.r)} signal)` : ' (info, 0)'}`).join(' · ') + '. PATTERN_LAB_EXT.md' };
}
function signalPlugin(DATA_DIR) {
  return { id: 'plx', name: 'Pattern Lab EXT (rules 38+, A-J)', desk: 'patternlab', claim: 'crash', async live({ live } = {}) {
    let feed = null; try { feed = live ? live.feed() : JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_feed.json'), 'utf8')); } catch {}
    const { rows, all } = flagsCached(DATA_DIR, feed); const out = [];
    for (const [id, fl] of Object.entries(all)) { const r = rows.get(id); const dir = verdictDir(r); if (!dir) continue; // only rules with a tested direction become signals
      for (const x of fl.slice(0, 25)) { if (!x.key && (!x.symbol || id === '40' || id === '40b')) continue; out.push({ detector: 'plx_' + id, claim: dir, severity: r.robust ? 'medium' : 'low', strength: r.robust ? 0.6 : 0.35,
        token: x.key ? { key: x.key, chain: x.key.split(':')[0], address: x.key.split(':').slice(1).join(':'), symbol: x.symbol } : { symbol: x.symbol }, price: x.price ?? null, liq: x.liq ?? null,
        reason: `${x.symbol || ''}: ${r.name} — ${x.why}`, source: 'lib/patternlab_ext.js' }); } }
    return out; } };
}
try { require('./signalbus').register(signalPlugin(path.join(__dirname, '..', 'data'))); } catch { /* signal bus optional */ }
module.exports = { routes, api, liveFlags, tapeFlags, compositeFactor, signalPlugin };
