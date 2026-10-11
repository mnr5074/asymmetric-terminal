'use strict';
// ASYMMETRIC·TERMINAL frontend — read-only. All external strings are HTML-escaped.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeImg = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : '');
const WSOL = 'So11111111111111111111111111111111111111112';
const DEFAULT_WL = [
  ['solana', WSOL], ['solana', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'], ['solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
  ['solana', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'], ['solana', '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2'],
  ['solana', '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx'], ['robinhood', '0x39dBED3a2bd333467115dE45665cC57F813C4571'],
  ['ethereum', '0x6982508145454Ce325dDbE47a25d4ec3d2311933'], ['base', '0x532f27101965dd16442E59d40670FaF5eBB142E4'],
  ['bsc', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'], ['ton', 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT'],
  ['solana', 'EosbW31T1WAQSiHUErogcaNHd8FBZDbjPPgQMJzXARNV'], ['solana', 'HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz'], // QCAT, STRK (Solana SPL)
];
const LS = { wl: 'st.watchlist.v1', sel: 'st.selected.v1', rpc: 'st.rpc.v1', chain: 'st.chain.v1', wchain: 'st.wchain.v1' };
let CHAINS = { solana: { name: 'Solana', short: 'SOL' }, robinhood: { name: 'Robinhood Chain', short: 'RH' } };
let curChain = localStorage.getItem(LS.chain) || 'solana';
let natives = {};
let watch = JSON.parse(localStorage.getItem(LS.wl) || 'null') || DEFAULT_WL;
// one-time additive merge of newly added defaults into saved watchlists (QCAT, STRK)
if (!localStorage.getItem('st.wl.add.qcat-strk')) { for (const t of DEFAULT_WL.slice(-2)) if (!watch.some(([c, a]) => c === t[0] && a === t[1])) watch.push(t); localStorage.setItem(LS.wl, JSON.stringify(watch)); localStorage.setItem('st.wl.add.qcat-strk', '1'); }
let tokenData = {};
let selected = null; // {chain, address, pair}
const params = new URLSearchParams(location.search);

// ---------- formatting ----------
function fUsd(n) { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); return '$' + (a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(a >= 1 ? 2 : 4)); }
function fPrice(p) {
  if (p == null || isNaN(p)) return '—';
  if (p >= 1000) return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (p >= 1) return '$' + p.toFixed(3);
  if (p >= 0.01) return '$' + p.toFixed(4);
  const s = p.toExponential(3); const [m, e] = s.split('e'); const z = -(+e) - 1;
  const digits = m.replace('.', '').replace('-', '').slice(0, 4);
  return `$0.0<sub>${z}</sub>${digits}`;
}
function fPct(n) { if (n == null || isNaN(n)) return '<span class="muted">—</span>'; return `<span class="${n >= 0 ? 'up' : 'dn'}">${n >= 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%</span>`; }
function fAge(ms) { if (!ms) return '—'; const h = (Date.now() - ms) / 3600e3; return h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? h.toFixed(0) + 'h' : h < 24 * 365 ? Math.round(h / 24) + 'd' : (h / 24 / 365).toFixed(1) + 'y'; }
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
function chainTag(c) { return c && c !== 'solana' ? `<span class="ch ch-${esc(c)}" title="${esc(CHAINS[c]?.name || c)}">${esc(CHAINS[c]?.short || c.slice(0, 4).toUpperCase())}</span>` : ''; }

// quick per-token heuristics (not advice)
function flags(p) {
  if (!p) return '';
  const out = [];
  const liq = p.liquidityUsd || 0;
  if (liq < 10000) out.push(['r', 'LIQ<10K']); else if (liq < 50000) out.push(['a', 'LOW LIQ']);
  if (p.pairCreatedAt && Date.now() - p.pairCreatedAt < 24 * 3600e3) out.push(['r', 'NEW<24h']); else if (p.pairCreatedAt && Date.now() - p.pairCreatedAt < 7 * 86400e3) out.push(['a', 'NEW<7d']);
  const fdv = p.fdv || p.marketCap;
  if (fdv && liq) { const r = fdv / liq; if (r > 100 && fdv < 1e8) out.push(['a', `FDV/L ${r.toFixed(0)}x`]); if (r < 1.25) out.push(['r', 'LIQ≈FDV']); }
  if (p.liquidityQuote != null && liq > 0 && /^(USDC|USDT|USDG)$/.test(p.quoteSymbol || '') && p.liquidityQuote / liq < 0.05) out.push(['r', '1-SIDED']);
  if (!out.length) out.push(['g', 'OK']);
  return out.map(([c, t]) => `<span class="chip ${c}" title="heuristic, not advice">${t}</span>`).join('');
}

async function api(path) {
  const h = {}; const rpc = localStorage.getItem(LS.rpc); if (rpc) h['x-rpc-url'] = rpc;
  const r = await fetch(path, { headers: h });
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('login required'); }
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok || j.error) throw new Error(j.error || r.status);
  return j;
}
const inWatch = (c, a) => watch.some(([x, y]) => x === c && y === a);
function toggleWatch(c, a) {
  watch = inWatch(c, a) ? watch.filter(([x, y]) => !(x === c && y === a)) : [...watch, [c, a]];
  localStorage.setItem(LS.wl, JSON.stringify(watch)); refreshWatch(); renderDisc();
}

// ---------- watchlist ----------
async function refreshWatch() {
  $('#refreshDot').className = 'dot busy';
  try {
    const d = await api('/api/tokens?items=' + watch.map(([c, a]) => `${c}:${a}`).join(','));
    tokenData = { ...tokenData, ...d.tokens };
    natives = d.natives || natives;
    const nt = ['BTC', 'ETH'].filter((k) => natives[k]).map((k) => `<span class="muted">${k}</span> ${fPrice(natives[k].usd)} ${fPct(natives[k].change24h)}`).join(' &nbsp;');
    if (d.sol) $('#solTicker').innerHTML = `SOL ${fPrice(d.sol.usdPrice)} ${fPct(d.sol.priceChange24h)} &nbsp;${nt}`;
    $('#lastUpdate').textContent = 'updated ' + new Date().toLocaleTimeString();
    $('#refreshDot').className = 'dot ok';
  } catch (e) { $('#refreshDot').className = 'dot'; $('#lastUpdate').textContent = 'refresh failed: ' + e.message; }
  renderWatch();
}
function renderWatch() {
  const wf = $('#watchChain').value || 'all';
  const rows = watch.filter(([c]) => wf === 'all' || c === wf).map(([c, a]) => {
    const p = tokenData[`${c}:${a}`];
    const price = p?.jupPrice ?? p?.priceUsd;
    const isSel = selected && selected.address === a;
    return `<tr data-c="${c}" data-a="${esc(a)}" class="${isSel ? 'sel' : ''}">
      <td><span class="star on" data-star="1" title="remove">★</span></td>
      <td><div class="tok">${safeImg(p?.imageUrl) ? `<img src="${esc(safeImg(p.imageUrl))}" loading="lazy">` : '<img>'}<b>${esc(p?.symbol || short(a))}</b>${chainTag(c)}</div></td>
      <td class="r">${fPrice(price)}</td><td class="r">${fPct(p?.change?.m5)}</td><td class="r">${fPct(p?.change?.h1)}</td><td class="r">${fPct(p?.change?.h24)}</td>
      <td class="r">${fUsd(p?.volume?.h24)}</td><td class="r">${fUsd(p?.liquidityUsd)}</td><td class="r">${fUsd(p?.fdv || p?.marketCap)}</td><td class="r">${fAge(p?.pairCreatedAt)}</td><td>${flags(p)}</td></tr>`;
  }).join('');
  $('#watchTbl tbody').innerHTML = rows || `<tr><td colspan="11" class="empty">${wf === 'all' ? 'Empty: search to add tokens.' : 'No watchlisted tokens on ' + esc(CHAINS[wf]?.name || wf) + '.'}</td></tr>`;
}
$('#watchTbl').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-a]'); if (!tr) return;
  if (e.target.dataset.star) return toggleWatch(tr.dataset.c, tr.dataset.a);
  select(tr.dataset.c, tr.dataset.a, tokenData[`${tr.dataset.c}:${tr.dataset.a}`]);
});

// ---------- selection: chart + scan ----------
function select(chain, address, pair, opts = {}) {
  selected = { chain, address, pair };
  localStorage.setItem(LS.sel, JSON.stringify([chain, address]));
  renderWatch();
  renderChart();
  $('#scanChain').value = chain; $('#scanInput').value = address;
  if (opts.scan !== false) runScan(chain, address, opts.deep);
}
let tf = 'minute:15', candles = [];
$('#tfTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; tf = b.dataset.tf; document.querySelectorAll('#tfTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderChart(true); });
async function renderChart(force) {
  const s = selected; if (!s) return;
  let p = s.pair;
  if (!p || !p.pairAddress) { try { const d = await api(`/api/tokens?items=${s.chain}:${s.address}`); p = d.tokens[`${s.chain}:${s.address}`]; s.pair = p; } catch {} }
  if (!p || !p.pairAddress) { $('#chartBox').innerHTML = '<div class="empty">No DEX pair found for chart.</div>'; return; }
  $('#chartTitle').innerHTML = `${esc(p.symbol)}/${esc(p.quoteSymbol)} <span class="muted small">${esc(p.dexId)} ${esc((p.labels || []).join(' '))}</span>`;
  $('#chartMeta').innerHTML = `${fPrice(p.jupPrice ?? p.priceUsd)} · 24h ${fPct(p.change?.h24)} · vol ${fUsd(p.volume?.h24)} · liq ${fUsd(p.liquidityUsd)} · fdv ${fUsd(p.fdv)} · pool ${esc(short(p.pairAddress))} · <a href="${esc(p.url)}" target="_blank" rel="noopener">dexscreener ↗</a>`;
  if (tf === 'embed') {
    const src = `https://dexscreener.com/${encodeURIComponent(s.chain)}/${encodeURIComponent(p.pairAddress)}?embed=1&trades=0&tabs=0&info=0&theme=dark&chartTheme=dark`;
    $('#chartBox').innerHTML = `<iframe src="${esc(src)}" title="chart"></iframe>`; return;
  }
  const [t, agg] = tf.split(':');
  const key = `${p.pairAddress}:${tf}`;
  if (!force && $('#chartBox canvas') && $('#chartBox').dataset.key === key) return;
  $('#chartBox').dataset.key = key;
  $('#chartBox').innerHTML = '<div class="empty"><span class="spin"></span> loading candles…</div>';
  try { candles = (await api(`/api/ohlcv?chain=${s.chain}&pool=${p.pairAddress}&tf=${t}&agg=${agg}`)).candles; } catch (e) { $('#chartBox').innerHTML = `<div class="empty">OHLC unavailable (${esc(e.message)}). Try DS↗ embed.</div>`; return; }
  if (!candles.length) { $('#chartBox').innerHTML = '<div class="empty">No candles for this pool.</div>'; return; }
  $('#chartBox').innerHTML = '<canvas></canvas>';
  drawCandles();
}
function drawCandles() {
  const cv = $('#chartBox canvas'); if (!cv || !candles.length) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const padR = 62, padB = 16, volH = H * 0.18, plotH = H - padB - volH - 6, plotW = W - padR;
  const n = Math.min(candles.length, Math.floor(plotW / 4)); const cs = candles.slice(-n);
  let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h)); if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (plotH - 6);
  const vmax = Math.max(...cs.map((c) => c.v)) || 1; const bw = plotW / n;
  g.fillStyle = '#05070a'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#141b26'; g.lineWidth = 1; g.font = '10px monospace'; g.fillStyle = '#6b7889';
  for (let i = 0; i <= 5; i++) { const v = lo + ((hi - lo) * i) / 5; const yy = y(v); g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.fillText(fmtAxis(v), plotW + 4, yy + 3); }
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  cs.forEach((c, i) => {
    const x = i * bw + bw / 2, up = c.c >= c.o; const col = up ? '#18d27a' : '#ff4d5e';
    g.strokeStyle = col; g.fillStyle = col; g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const top = y(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(y(c.o) - y(c.c))); g.fillRect(x - Math.max(1, bw * 0.35), top, Math.max(1, bw * 0.7), bh);
    g.globalAlpha = 0.35; const vh = (c.v / vmax) * volH; g.fillRect(x - Math.max(1, bw * 0.35), H - padB - vh, Math.max(1, bw * 0.7), vh); g.globalAlpha = 1;
    if (i % step === 0) { g.fillStyle = '#6b7889'; const d = new Date(c.t); g.fillText(tf.startsWith('day') ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), x - 14, H - 4); }
  });
  const last = cs[cs.length - 1]; const ly = y(last.c);
  g.setLineDash([3, 3]); g.strokeStyle = '#9945ff'; g.beginPath(); g.moveTo(0, ly); g.lineTo(plotW, ly); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#9945ff'; g.fillRect(plotW, ly - 7, padR, 14); g.fillStyle = '#fff'; g.fillText(fmtAxis(last.c), plotW + 4, ly + 3);
  g.fillStyle = '#6b7889'; g.fillText('OHLC: GeckoTerminal · ' + tf.replace(':', ' x'), 6, 14);
}
function fmtAxis(v) { if (v >= 1000) return v.toFixed(0); if (v >= 1) return v.toFixed(3); if (v >= 0.001) return v.toFixed(5); return v.toExponential(2); }
window.addEventListener('resize', drawCandles);

// ---------- search ----------
let sTimer;
$('#search').addEventListener('input', (e) => { clearTimeout(sTimer); const q = e.target.value.trim(); if (!q) return $('#searchResults').classList.add('hidden'); sTimer = setTimeout(() => doSearch(q), 300); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#searchResults').classList.add('hidden'); });
document.addEventListener('click', (e) => { if (!e.target.closest('.searchwrap')) $('#searchResults').classList.add('hidden'); });
async function doSearch(q) {
  const box = $('#searchResults'); box.classList.remove('hidden'); box.innerHTML = '<div class="empty"><span class="spin"></span> searching…</div>';
  try {
    const d = await api('/api/search?q=' + encodeURIComponent(q) + '&chains=' + encodeURIComponent(curChain));
    window._sr = d.pairs;
    box.innerHTML = d.pairs.length ? `<table class="tbl"><thead><tr><th></th><th>Token</th><th>DEX</th><th class="r">Price</th><th class="r">24h</th><th class="r">Liq</th><th class="r">FDV</th><th class="r">Age</th><th>Flags</th></tr></thead><tbody>${d.pairs.map((p, i) => `
      <tr data-i="${i}"><td><span class="star ${inWatch(p.chainId, p.address) ? 'on' : ''}" data-star="1">★</span></td>
      <td><div class="tok">${safeImg(p.imageUrl) ? `<img src="${esc(safeImg(p.imageUrl))}">` : '<img>'}<b>${esc(p.symbol)}</b>${chainTag(p.chainId)}<span class="muted small">${esc(short(p.address))}</span></div></td>
      <td>${esc(p.dexId)} <span class="muted small">/${esc(p.quoteSymbol)}</span></td><td class="r">${fPrice(p.priceUsd)}</td><td class="r">${fPct(p.change?.h24)}</td><td class="r">${fUsd(p.liquidityUsd)}</td><td class="r">${fUsd(p.fdv)}</td><td class="r">${fAge(p.pairCreatedAt)}</td><td>${flags(p)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">No pairs found on ${esc(curChain === 'all' ? 'any chain' : CHAINS[curChain]?.name || curChain)}. Switch the chain selector to "All chains" to widen the search.</div>`;
  } catch (e) { box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`; }
}
$('#searchResults').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]'); if (!tr) return; const p = window._sr[+tr.dataset.i];
  if (e.target.dataset.star) { toggleWatch(p.chainId, p.address); e.target.classList.toggle('on'); return; }
  $('#searchResults').classList.add('hidden');
  if (p.supported === false) { alert(`${p.chainId} is listed by DexScreener but not wired into the scanner/chart yet.`); return; }
  select(p.chainId, p.address, p);
});

// ---------- discovery ----------
let discKind = 'boosts', ecoKind = 'stonkfun', discCache = {};
$('#discTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; discKind = b.dataset.k; document.querySelectorAll('#discTabs button').forEach((x) => x.classList.toggle('on', x === b)); loadDisc(); });
$('#ecoTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ecoKind = b.dataset.e; document.querySelectorAll('#ecoTabs button').forEach((x) => x.classList.toggle('on', x === b)); loadDisc(); });
async function loadDisc() {
  $('#ecoTabs').classList.toggle('hidden', discKind !== 'eco');
  const chain = curChain;
  $('#discChainLbl').textContent = discKind === 'eco' || discKind === 'pump' ? '' : (chain === 'all' ? 'All chains' : CHAINS[chain]?.name || chain);
  const url = discKind === 'pump' ? '/api/pumpfun' : discKind === 'eco' ? `/api/eco/${ecoKind}` : `/api/discover?kind=${discKind}&chain=${chain}`;
  $('#discBody').innerHTML = '<div class="empty"><span class="spin"></span> loading…</div>';
  try { discCache = { url, data: await api(url), chain }; } catch (e) { $('#discBody').innerHTML = `<div class="empty">Feed failed: ${esc(e.message)}</div>`; return; }
  renderDisc();
}
function pairRow(chain, x, i, extra = '') {
  const p = x.pair;
  return `<tr data-i="${i}" data-c="${chain}" data-a="${esc(x.address)}"><td><span class="star ${inWatch(chain, x.address) ? 'on' : ''}" data-star="1">★</span></td>
    <td><div class="tok">${safeImg(p?.imageUrl || x.image) ? `<img src="${esc(safeImg(p?.imageUrl || x.image))}" loading="lazy">` : '<img>'}<b>${esc(p?.symbol || x.symbol || short(x.address))}</b>${chainTag(chain)}</div></td>
    <td class="muted">${esc(p?.dexId || '')}${extra}</td><td class="r">${fPrice(p?.priceUsd)}</td><td class="r">${fPct(p?.change?.h1)}</td><td class="r">${fPct(p?.change?.h24)}</td><td class="r">${fUsd(p?.volume?.h24)}</td><td class="r">${fUsd(p?.liquidityUsd)}</td><td class="r">${fUsd(p?.fdv)}</td><td class="r">${fAge(p?.pairCreatedAt)}</td><td>${flags(p)}</td></tr>`;
}
const PH = '<thead><tr><th></th><th>Token</th><th>DEX</th><th class="r">Price</th><th class="r">1h</th><th class="r">24h</th><th class="r">Vol</th><th class="r">Liq</th><th class="r">FDV</th><th class="r">Age</th><th>Flags</th></tr></thead>';
function renderDisc() {
  const d = discCache.data; if (!d) return; const u = discCache.url; let html = '';
  $('#ecoSrc').textContent = d.source || '';
  if (u.startsWith('/api/discover')) {
    html = `<table class="tbl">${PH}<tbody>${d.items.map((x, i) => pairRow(x.chain || discCache.chain, x, i, x.boost ? ` <span class="chip a">⚡${x.boost}</span>` : x.src === 'gt' ? ' <span class="chip" title="GeckoTerminal">GT</span>' : '')).join('')}</tbody></table><div class="muted small" style="padding:2px 8px">${esc(d.source || '')}</div>`;
    if (!d.items.length) html = '<div class="empty">No tokens for this chain in the feed right now.</div>';
  } else if (u === '/api/pumpfun') {
    html = `<table class="tbl"><thead><tr><th></th><th>Token</th><th>Mint</th><th class="r">Mcap</th><th class="r">Age</th><th>Curve</th><th class="r">Replies</th></tr></thead><tbody>${d.items.map((x, i) => `
      <tr data-i="${i}" data-c="solana" data-a="${esc(x.address)}"><td><span class="star ${inWatch('solana', x.address) ? 'on' : ''}" data-star="1">★</span></td>
      <td><div class="tok">${safeImg(x.image) ? `<img src="${esc(safeImg(x.image))}" loading="lazy">` : '<img>'}<b>${esc(x.symbol)}</b><span class="muted small">${esc((x.name || '').slice(0, 18))}</span></div></td>
      <td class="muted">${esc(short(x.address))}</td><td class="r">${fUsd(x.marketCapUsd)}</td><td class="r">${fAge(x.createdAt)}</td><td>${x.complete ? '<span class="chip g">graduated</span>' : '<span class="chip a">bonding</span>'}</td><td class="r">${x.replies ?? 0}</td></tr>`).join('')}</tbody></table>`;
  } else if (u.includes('stonkfun')) {
    html = `<table class="tbl"><thead><tr><th></th><th>Token</th><th>Paired with</th><th class="r">Price</th><th class="r">24h</th><th class="r">Vol 24h</th><th class="r">Liq</th><th class="r">Mcap</th><th class="r">Age</th><th>Status</th></tr></thead><tbody>${d.items.map((x, i) => `
      <tr data-i="${i}" data-c="solana" data-a="${esc(x.address)}"><td><span class="star ${inWatch('solana', x.address) ? 'on' : ''}" data-star="1">★</span></td>
      <td><div class="tok">${safeImg(x.image) ? `<img src="${esc(safeImg(x.image))}" loading="lazy">` : '<img>'}<b>${esc(x.symbol)}</b></div></td>
      <td>${esc(x.quoteSymbol)} <span class="muted small">${esc(x.quoteCategory || '')}</span></td><td class="r">${fPrice(x.priceUsd)}</td><td class="r">${fPct(x.change24h)}</td><td class="r">${fUsd(x.volume24hUsd)}</td><td class="r">${fUsd(x.liquidityUsd)}</td><td class="r">${fUsd(x.marketCapUsd)}</td><td class="r">${fAge(x.createdAt)}</td>
      <td><span class="chip ${x.status === 'graduated' ? 'g' : 'a'}">${esc(x.status)}</span>${x.transferFeeBps ? `<span class="chip a">fee ${x.transferFeeBps / 100}%</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
  } else if (u.includes('/eco/fourmeme')) {
    html = `<table class="tbl">${PH}<tbody>${d.items.map((x, i) => pairRow('bsc', x, i)).join('')}</tbody></table>`;
  } else if (u.includes('/eco/robinhood')) {
    html = `<table class="tbl">${PH}<tbody>${d.items.map((x, i) => pairRow('robinhood', x, i)).join('')}</tbody></table>`;
  } else if (u.includes('/eco/fomo')) {
    html = d.unavailable ? `<div class="empty">⚠ ${esc(d.note)}</div>` : `<table class="tbl">${PH}<tbody>${d.items.map((x, i) => pairRow(x.chain, x, i, ` <span class="chip g">#${x.fomoRank}</span>`)).join('')}</tbody></table>`;
  } else if (u.includes('/eco/pons')) {
    html = `<div class="kv"><div><span class="muted small">PONS price</span><b>${fPrice(d.ponsMarket?.priceUsd)}</b></div><div><span class="muted small">PONS mcap</span><b>${fUsd(d.ponsMarket?.mcapUsd)}</b></div><div><span class="muted small">launches (last ~${Math.round(d.launchWindowBlocks / 36000)}h)</span><b>${d.launchesLastWindow}</b></div><div><span class="muted small">graduation events (window)</span><b>${d.graduationsInWindow}</b></div></div>
      <table class="tbl">${PH}<tbody>${d.graduated.map((x, i) => pairRow('robinhood', x, i, x.note ? ' <span class="chip g">launchpad token</span>' : ' <span class="chip g">graduated</span>')).join('')}
      ${(d.graduatedNotIndexed || []).map((x) => `<tr data-c="robinhood" data-a="${esc(x.address)}"><td></td><td><div class="tok"><img><b>${esc(x.symbol || short(x.address))}</b><span class="ch">RH</span></div></td><td class="muted">pons curve</td><td class="r">${fPrice(x.ponsapi?.priceUsd || null)}</td><td></td><td></td><td></td><td></td><td class="r">${fUsd(x.ponsapi?.mcapUsd || null)}</td><td></td><td><span class="chip a">not on DexScreener</span></td></tr>`).join('')}
      ${d.recentLaunches.map((x) => `<tr data-c="robinhood" data-a="${esc(x.address)}"><td></td><td><div class="tok"><img><b>${esc(x.symbol || short(x.address))}</b><span class="ch">RH</span></div></td><td class="muted">new launch</td><td colspan="7" class="muted small">${esc(x.address)} · block ${x.block}</td><td><span class="chip a">curve</span></td></tr>`).join('')}</tbody></table>`;
  }
  $('#discBody').innerHTML = html;
}
$('#discBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-a]'); if (!tr) return;
  if (e.target.dataset.star) return toggleWatch(tr.dataset.c, tr.dataset.a);
  const x = discCache.data?.items?.[+tr.dataset.i] || discCache.data?.graduated?.[+tr.dataset.i];
  select(tr.dataset.c, tr.dataset.a, x?.pair || null);
});

// ---------- wallet ----------
$('#walletBtn').addEventListener('click', loadWallet);
$('#walletInput').addEventListener('keydown', (e) => e.key === 'Enter' && loadWallet());
async function loadWallet() {
  const a = $('#walletInput').value.trim(); if (!a) return;
  $('#walletOut').innerHTML = '<div class="empty"><span class="spin"></span> reading balances via RPC…</div>';
  try {
    const d = await api('/api/wallet?address=' + encodeURIComponent(a));
    const nat = (d.natives || []).filter((x) => x.amount || x.error);
    $('#walletOut').innerHTML = `<div class="kv">${nat.slice(0, 6).map((x) => `<div><span class="muted small">${esc(x.symbol)} ${esc(CHAINS[x.chain]?.name || x.chain)}</span><b>${x.amount != null ? x.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '<span class="dn small">rpc error</span>'}</b><span class="muted small">${fUsd(x.valueUsd)}</span></div>`).join('')}<div><span class="muted small">tokens</span><b>${d.tokens.length}</b></div><div><span class="muted small">Total (priced)</span><b>${fUsd(d.totalUsd)}</b></div></div>
    <table class="tbl"><thead><tr><th>Token</th><th>Address</th><th class="r">Amount</th><th class="r">Price</th><th class="r">Value</th></tr></thead><tbody>${d.tokens.map((t) => `
    <tr data-c="${esc(t.chain || 'solana')}" data-a="${esc(t.mint)}"><td><div class="tok">${safeImg(t.icon) ? `<img src="${esc(safeImg(t.icon))}" loading="lazy">` : '<img>'}<b>${esc(t.symbol || '?')}</b>${chainTag(t.chain)}${t.verified ? '<span class="chip g">✓</span>' : ''}</div></td><td class="muted">${esc(short(t.mint))}</td><td class="r">${t.amount != null ? t.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : `<span class="muted small">raw ${esc(String(t.rawAmount).slice(0, 14))}</span>`}</td><td class="r">${fPrice(t.priceUsd)}</td><td class="r">${fUsd(t.valueUsd)}</td></tr>`).join('')}</tbody></table><div class="muted small" style="padding:4px 8px">via ${esc(d.rpc)} · read-only${d.note ? ' · ' + esc(d.note) : ''}</div>`;
  } catch (e) { $('#walletOut').innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`; }
}
$('#walletOut').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-a]'); if (tr && CHAINS[tr.dataset.c]) select(tr.dataset.c, tr.dataset.a, null); });

// ---------- scanner ----------
let scanSeq = 0;
$('#scanBtn').addEventListener('click', () => { const a = $('#scanInput').value.trim(); if (a) select($('#scanChain').value, a, null); });
$('#scanInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('#scanBtn').click());
async function runScan(chain, address, deep = true) {
  const seq = ++scanSeq;
  $('#scanOut').innerHTML = `<div class="empty"><span class="spin"></span> scanning ${esc(CHAINS[chain]?.name || chain)} (${chain === 'solana' ? 'RPC, RugCheck' : 'GoPlus, Honeypot.is, tonapi'}, DexScreener)…</div>`;
  let quick;
  try { quick = await api(`/api/scan?chain=${chain}&address=${encodeURIComponent(address)}`); } catch (e) { if (seq === scanSeq) $('#scanOut').innerHTML = `<div class="empty">Scan failed: ${esc(e.message)}</div>`; return; }
  if (seq !== scanSeq) return;
  renderScan(quick, chain === 'solana' && deep !== false);
  if (chain === 'solana' && deep !== false) {
    try { const full = await api(`/api/scan?chain=${chain}&address=${encodeURIComponent(address)}&deep=1`); if (seq === scanSeq) renderScan(full, false); }
    catch (e) { if (seq === scanSeq) renderScan(quick, false, 'Deep scan failed: ' + e.message); }
  }
}
function evidenceHtml(c) {
  const ev = c.evidence || {};
  const rows = (arr, cols) => `<table><tr>${cols.map((k) => `<th>${esc(k)}</th>`).join('')}</tr>${arr.slice(0, 12).map((r) => `<tr>${cols.map((k) => `<td>${esc(typeof r[k] === 'string' && r[k].length > 30 ? short(r[k]) : r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
  let inner = '';
  if (c.id === 'top10' && ev.top) inner = rows(ev.top, ['owner', 'pct', 'label', 'insider']) + (ev.excluded?.length ? '<div>excluded (pools/LP):</div>' + rows(ev.excluded, ['owner', 'pct', 'label']) : '');
  else if (c.id === 'bundle' && ev.wallets) inner = (ev.wallets.length ? rows(ev.wallets, ['wallet', 'slotOffset', 'boughtPct', 'heldPct', 'funder']) : '') + `<div>creator ${esc(short(ev.creator))} · creation slot ${ev.creationSlot} · ${ev.creationTime ? new Date(ev.creationTime).toLocaleString() : ''} · ${ev.txsAnalyzed} earliest txns analyzed of ${ev.totalSigs}</div>`;
  else if (c.id === 'sniper' && ev.earliestBuyers) inner = (ev.wallets.length ? rows(ev.wallets, ['wallet', 'slotOffset', 'boughtPct', 'heldPct']) : '') + '<div>earliest buyers:</div>' + rows(ev.earliestBuyers, ['wallet', 'slotOffset', 'boughtPct', 'isCreator']);
  else if (c.id === 'lplock' && ev.markets) inner = rows(ev.markets.map((m) => ({ ...m, usd: fUsd(m.usd).replace('$', ''), lockedPct: (m.lockedPct || 0).toFixed(1) })), ['type', 'usd', 'lockedPct', 'pubkey']);
  else if (c.id === 'insiders' && ev.networks?.length) inner = rows(ev.networks, ['id', 'type', 'size', 'holdingPct']);
  else { const flat = Object.entries(ev).filter(([, v]) => v != null && typeof v !== 'object'); if (flat.length) inner = flat.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · '); }
  return inner ? `<details class="ev"><summary>evidence</summary>${inner}</details>` : '';
}
function renderScan(r, deepPending, err) {
  const label = { red: 'HIGH RISK', amber: 'CAUTION', green: 'FEWER RED FLAGS' }[r.overall];
  const t = r.token || {}; const p = r.mainPair;
  let html = `<div class="verdict ${r.overall}"><div class="score">${r.riskScore}</div><div style="flex:1"><div class="lbl">${label} <span class="muted small">risk score /100</span></div>
    <div>${esc(t.symbol || '?')} <span class="muted">${esc(t.name || '')}</span> <span class="muted small">${esc(short(r.address))}${t.launchpad ? ' · ' + esc(t.launchpad) : ''}</span></div>
    <div class="lights"><span class="chip r">● ${r.counts.red} red</span><span class="chip a">● ${r.counts.amber} amber</span><span class="chip g">● ${r.counts.green} green</span><span class="muted">${r.counts.na} n/a</span></div></div></div>`;
  const reds = r.checks.filter((c) => c.level === 'red');
  if (reds.length) html += `<ul class="keyf">${reds.map((c) => `<li><b>${esc(c.title)}</b>: ${esc(c.detail.split(/(?<=\.)\s/)[0])}</li>`).join('')}</ul>`;
  if (p) html += `<div class="muted small">pair ${esc(p.dexId)} ${esc(short(p.pairAddress))} · ${fPrice(p.priceUsd)} · ${r.pairCount} pools</div>`;
  if (deepPending) html += '<div class="muted small"><span class="spin"></span> deep scan running (earliest txns, bundles, snipers, funders)… public RPC is throttled</div>';
  if (err) html += `<div class="dn small">${esc(err)}</div>`;
  let g = '';
  for (const c of r.checks) {
    if (c.group !== g) { g = c.group; html += `<div class="grp">${esc(g)}</div>`; }
    html += `<div class="check"><div class="lamp ${c.level}"></div><div><div class="t">${esc(c.title)}</div><div class="d">${esc(c.detail)}</div>${evidenceHtml(c)}</div></div>`;
  }
  html += `<div class="muted small" style="margin-top:6px">sources: ${Object.entries(r.sources || {}).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ')} · ${r.elapsedMs}ms${r.deep ? ' · deep' : ''}</div><div class="disc">⚠ ${esc(r.disclaimer)}</div>`;
  $('#scanOut').innerHTML = html;
}

// ---------- settings ----------
$('#settingsBtn').addEventListener('click', () => { $('#rpcUrl').value = localStorage.getItem(LS.rpc) || ''; $('#settings').classList.remove('hidden'); });
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').classList.add('hidden'); });
$('#rpcSave').addEventListener('click', () => { const v = $('#rpcUrl').value.trim(); if (v && !/^https:\/\//.test(v)) return alert('RPC URL must start with https://'); v ? localStorage.setItem(LS.rpc, v) : localStorage.removeItem(LS.rpc); $('#settings').classList.add('hidden'); $('#settingsBtn').textContent = v ? '⚙ RPC*' : '⚙ RPC'; });
$('#rpcClear').addEventListener('click', () => { localStorage.removeItem(LS.rpc); $('#rpcUrl').value = ''; $('#settingsBtn').textContent = '⚙ RPC'; });
if (localStorage.getItem(LS.rpc)) $('#settingsBtn').textContent = '⚙ RPC*';

// ---------- lower tabs (wallet / moonshot) ----------
$('#expandBtn').addEventListener('click', (e) => { e.stopPropagation(); document.body.classList.toggle('expand'); drawCandles(); });
$('#lowerTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (!b) return; document.querySelectorAll('#lowerTabs button[data-t]').forEach((x) => x.classList.toggle('on', x === b)); $('#lowerWallet').classList.toggle('hidden', b.dataset.t !== 'wallet'); $('#lowerMoon').classList.toggle('hidden', b.dataset.t !== 'moon'); $('#lowerMacro').classList.toggle('hidden', b.dataset.t !== 'macro'); if (b.dataset.t === 'moon' && window.loadMoon) window.loadMoon(); if (b.dataset.t === 'macro' && window.loadMacro) window.loadMacro(); });

// ---------- boot ----------
(async function boot() {
  try {
    const cd = await api('/api/chains'); natives = cd.natives || {};
    CHAINS = Object.fromEntries(cd.chains.map((c) => [c.id, c]));
    const opts = cd.chains.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#chainSel').innerHTML = opts + '<option value="all">All chains</option>';
    $('#watchChain').innerHTML = '<option value="all">All chains</option>' + opts;
    $('#scanChain').innerHTML = cd.chains.map((c) => `<option value="${esc(c.id)}">${esc(c.short)}</option>`).join('');
  } catch {}
  if (params.get('chain')) curChain = params.get('chain');
  if (!CHAINS[curChain] && curChain !== 'all') curChain = 'solana';
  $('#chainSel').value = curChain;
  $('#watchChain').value = localStorage.getItem(LS.wchain) || 'all';
  $('#chainSel').addEventListener('change', () => { curChain = $('#chainSel').value; localStorage.setItem(LS.chain, curChain); loadDisc(); if (!$('#lowerMoon').classList.contains('hidden')) window.loadMoon(); const q = $('#search').value.trim(); if (q) doSearch(q); });
  $('#watchChain').addEventListener('change', () => { localStorage.setItem(LS.wchain, $('#watchChain').value); renderWatch(); });
  await refreshWatch();
  setInterval(refreshWatch, 15000);
  loadDisc();
  const sp = params.get('scan');
  const [c, a] = sp ? sp.split(':') : JSON.parse(localStorage.getItem(LS.sel) || 'null') || ['solana', 'TDtNdhCcJcarSCiLzYVGiJFcQnHFJcGijVsK6nNiEN1'];
  select(c, a, tokenData[`${c}:${a}`] || null, { deep: params.get('deep') !== '0' });
  if (params.get('wallet')) { $('#walletInput').value = params.get('wallet'); loadWallet(); }
  if (params.get('expand')) document.body.classList.add('expand');
  if (params.get('tab')) { const b = document.querySelector(`#lowerTabs button[data-t="${params.get('tab')}"]`); b && b.click(); }
  if (params.get('wchain')) { $('#watchChain').value = params.get('wchain'); renderWatch(); }
  if (params.get('disc')) { const b = document.querySelector(`#discTabs button[data-k="${params.get('disc')}"]`); b && b.click(); }
})();

// ---------- Moonshot research ----------
window.loadMoon = async function loadMoon() {
  const box = $('#moonOut');
  box.innerHTML = '<div class="empty"><span class="spin"></span> loading research dataset…</div>';
  let a, s, st;
  try { a = await api('/api/moon/analysis'); } catch (e) { st = await api('/api/moon/status').catch(() => ({})); box.innerHTML = `<div class="empty">${esc(e.message)}<pre class="small">${esc(st.log || '')}</pre></div>`; return; }
  try { s = await api('/api/moon/screener'); } catch {}
  const n = a.counts || {};
  const fmtN = (v, k) => v == null ? '—' : /mcap|vol/.test(k) ? fUsd(v) : /secs/.test(k) ? (v < 120 ? v.toFixed(0) + 's' : (v / 60).toFixed(1) + 'm') : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  const bar = (x) => `<div class="bar" style="width:60px;display:inline-block"><i style="width:${Math.round((x || 0) * 100)}%"></i></div>`;
  const BC = a.byChain || {};
  const chainSummary = () => `<div class="grp" style="padding:0 8px">Per-chain cohorts (${a.totalAllChains || a.total} tokens across ${Object.keys(BC).length} chains)</div><table class="tbl"><thead><tr><th>Chain</th><th class="r">tokens</th><th class="r">mooned ≥100x</th><th class="r">died</th><th class="r">middle</th><th class="r">young · fake · >180d</th><th class="r">10-100x</th><th class="r">Median launch mcap M / D</th><th class="r">Median holders now M / D</th><th>Top launchpads/DEX</th></tr></thead><tbody>${Object.entries(BC).map(([ch, b]) => `<tr class="chainrow" data-ch="${esc(ch)}"><td><b>${esc(CHAINS[ch]?.name || ch)}</b></td><td class="r">${b.total}</td><td class="r up">${b.counts.mooned || 0}</td><td class="r dn">${b.counts.died || 0}</td><td class="r">${b.counts.middle || 0}</td><td class="r">${b.counts.too_young || 0} · ${b.counts.suspect_fake || 0} · ${b.counts.out_of_window || 0}</td><td class="r">${b.multipleDist['10-100x'] || 0}</td><td class="r">${fUsd(b.medians.launch_mcap?.mooned)} / ${fUsd(b.medians.launch_mcap?.died)}</td><td class="r">${fmtN(b.medians.holders_now?.mooned)} / ${fmtN(b.medians.holders_now?.died)}</td><td class="muted small">${Object.entries(b.launchpads).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}</td></tr>`).join('')}</tbody></table>`;
  if (curChain !== 'solana' && curChain !== 'all') {
    const b = BC[curChain];
    if (!b) { box.innerHTML = `<div class="empty">No research data for ${esc(CHAINS[curChain]?.name || curChain)}. The dataset covers Solana plus Base, BSC and Ethereum (memecoin chains with free GeckoTerminal history).</div>` + chainSummary(); return; }
    let h2 = `<div class="kv"><div><span class="muted small">${esc(CHAINS[curChain]?.name)} tokens</span><b>${b.total}</b></div><div><span class="muted small">mooned ≥100x</span><b class="up">${b.counts.mooned || 0}</b></div><div><span class="muted small">died / rugged</span><b class="dn">${b.counts.died || 0}</b></div><div><span class="muted small">middle · young · fake · >180d</span><b>${b.counts.middle || 0} · ${b.counts.too_young || 0} · ${b.counts.suspect_fake || 0} · ${b.counts.out_of_window || 0}</b></div></div>
      <div class="muted small" style="padding:0 8px">multiples: ${Object.entries(b.multipleDist).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} · holder/LP snapshot from GoPlus (current state) · <span class="dn">small, feed-biased sample; dead EVM tokens are under-sampled because no free feed lists them</span></div>
      <div class="grp" style="padding:0 8px">Cohort medians (mooned / middle / died)</div><table class="tbl"><tbody>${Object.entries(b.medians).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r up">${fmtN(v.mooned, k)}</td><td class="r">${fmtN(v.middle, k)}</td><td class="r dn">${fmtN(v.died, k)}</td></tr>`).join('')}</tbody></table>
      <div class="grp" style="padding:0 8px">Separating features (mooned vs died)</div><table class="tbl"><thead><tr><th>Feature</th><th>When</th><th class="r">n M/D</th><th class="r">Mooned</th><th class="r">Died</th><th>Separation</th><th>Flags</th></tr></thead><tbody>${b.features.filter((f) => f.type === 'numeric').slice(0, 12).map((f) => `<tr><td>${esc(f.label)}</td><td class="muted">${esc(f.timing)}</td><td class="r">${f.n_mooned}/${f.n_died}</td><td class="r">${fmtN(f.median_mooned, f.feature)}</td><td class="r">${fmtN(f.median_died, f.feature)}</td><td>${bar(f.separation)} ${f.separation.toFixed(2)}</td><td>${(f.flags || []).map((x) => `<span class="chip a" title="${esc(x)}">${esc(x.split(':')[0])}</span>`).join('') || '<span class="chip g">ok</span>'}</td></tr>`).join('') || '<tr><td class="empty">Not enough mooned + died tokens on this chain yet.</td></tr>'}</tbody></table>
      <div class="grp" style="padding:0 8px">Biggest multiples</div><table class="tbl"><thead><tr><th>Token</th><th>Pad/DEX</th><th class="r">Launch mcap</th><th class="r">Peak mcap</th><th class="r">Multiple</th><th class="r">Now</th><th>Cohort</th></tr></thead><tbody>${b.top.map((t) => `<tr data-c="${esc(curChain)}" data-a="${esc(t.mint)}"><td><b>${esc(t.symbol)}</b></td><td class="muted">${esc(t.launchpad)}</td><td class="r">${fUsd(t.launch_mcap)}</td><td class="r">${fUsd(t.peak_mcap)}</td><td class="r up">${t.multiple ? Math.round(t.multiple).toLocaleString() + 'x' : '—'}</td><td class="r">${fUsd(t.cur_mcap)}</td><td>${esc(t.cohort)}</td></tr>`).join('')}</tbody></table>`;
    box.innerHTML = h2 + chainSummary(); return;
  }
  let h = `<div class="kv"><div><span class="muted small">tokens in DB</span><b>${a.total}</b></div><div><span class="muted small">mooned ≥100x</span><b class="up">${n.mooned || 0}</b></div><div><span class="muted small">died / rugged</span><b class="dn">${n.died || 0}</b></div><div><span class="muted small">middle · young · fake · >180d</span><b>${n.middle || 0} · ${n.too_young || 0} · ${n.suspect_fake || 0} · ${n.out_of_window || 0}</b></div></div>`;
  h += `<div class="muted small" style="padding:0 8px">generated ${new Date(a.generatedAt).toLocaleString()} · multiples: ${Object.entries(a.multipleDist || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} · <span class="dn">heuristic research, small biased sample — not predictions</span></div>`;
  h += `<div class="grp" style="padding:0 8px">Features ranked by separation (mooned vs died)</div><table class="tbl"><thead><tr><th>Feature</th><th>When</th><th class="r">n M/D</th><th class="r">Mooned</th><th class="r">Died</th><th>Separation</th><th>Flags</th></tr></thead><tbody>`;
  for (const f of a.features.slice(0, 40)) {
    let m = '', d = '';
    if (f.type === 'numeric') { m = fmtN(f.median_mooned, f.feature); d = fmtN(f.median_died, f.feature); }
    else { const best = (f.levels || []).slice().sort((x, y) => Math.abs((y.rate_mooned || 0) - (y.rate_died || 0)) - Math.abs((x.rate_mooned || 0) - (x.rate_died || 0)))[0]; if (best) { m = `${esc(String(best.level))}: ${((best.rate_mooned || 0) * 100).toFixed(0)}%`; d = `${((best.rate_died || 0) * 100).toFixed(0)}%`; } }
    const weak = (f.flags || []).length;
    h += `<tr title="${esc(f.direction || '')}"><td>${esc(f.label)}</td><td class="muted">${esc(f.timing)}</td><td class="r">${f.n_mooned}/${f.n_died}</td><td class="r">${m}</td><td class="r">${d}</td><td>${bar(f.separation)} ${f.separation != null ? f.separation.toFixed(2) : '—'}${f.z != null ? ` <span class="muted small">z=${f.z.toFixed(1)}</span>` : ''}</td><td>${(f.flags || []).map((x) => `<span class="chip a" title="${esc(x)}">${esc(x.split(':')[0])}</span>`).join('') || '<span class="chip g">ok</span>'}</td></tr>`;
  }
  h += '</tbody></table>';
  const p = a.pathTo100x || {}; const ag = p.aggregate || {};
  h += `<div class="grp" style="padding:0 8px">Path to 100x — ${(p.tokens || []).length} tokens · median launch mcap ${fUsd(ag.launch_mcap?.median)} · median ${fmtN(ag.hours_to_10x?.median)}h to 10x, ${fmtN(ag.hours_to_100x?.median)}h to 100x · median volume to 100x ${fUsd(ag.vol_to_100x?.median)} · round-tripped (now ≤10% of peak): ${p.roundTrip ?? '—'}</div>
  <table class="tbl"><thead><tr><th>Token</th><th>Pad</th><th class="r">Launch mcap</th><th class="r">Peak mcap</th><th class="r">Multiple</th><th class="r">h→10x</th><th class="r">h→100x</th><th class="r">Vol→100x</th><th class="r">Now/peak</th><th class="r">Holders now</th></tr></thead><tbody>
  ${(p.tokens || []).slice(0, 30).map((t) => `<tr data-c="solana" data-a="${esc(t.mint)}"><td><b>${esc(t.symbol)}</b></td><td class="muted">${esc(t.launchpad)}</td><td class="r">${fUsd(t.launch_mcap)}</td><td class="r">${fUsd(t.peak_mcap)}</td><td class="r up">${t.multiple ? Math.round(t.multiple).toLocaleString() + 'x' : '—'}</td><td class="r">${fmtN(t.hours_to_10x)}</td><td class="r">${fmtN(t.hours_to_100x)}</td><td class="r">${fUsd(t.vol_to_100x)}</td><td class="r">${t.cur_vs_peak != null ? (t.cur_vs_peak * 100).toFixed(0) + '%' : '—'}</td><td class="r">${t.holders_now?.toLocaleString() ?? '—'}</td></tr>`).join('')}</tbody></table>
  <div class="muted small" style="padding:2px 8px">${esc(p.note || '')}</div>`;
  if (a.suspectFake?.n) h += `<div class="grp" style="padding:0 8px">Suspect fake-mcap tokens excluded: ${a.suspectFake.n} (${(a.suspectFake.share_of_pump_mcap_feed * 100).toFixed(0)}% of pump.fun's market-cap-sorted feed sampled) · claimed peak mcap total ${fUsd(a.suspectFake.claimed_peak_mcap_sum)}</div>
    <table class="tbl"><thead><tr><th>Token</th><th class="r">Claimed mcap</th><th class="r">Real quote liq</th><th class="r">Lifetime vol</th><th>Why</th></tr></thead><tbody>${a.suspectFake.examples.slice(0, 8).map((t) => `<tr data-c="solana" data-a="${esc(t.mint)}"><td><b>${esc(t.symbol)}</b></td><td class="r">${fUsd(t.cur_mcap)}</td><td class="r">${fUsd(t.quote_liq_usd)}</td><td class="r">${fUsd(t.vol_total)}</td><td class="muted small">${esc((t.quality || '').replace('suspect_fake: ', ''))}</td></tr>`).join('')}</tbody></table>`;
  if (s) h += `<div class="grp" style="padding:0 8px">Live screener — similarity to mooned cohort (model: ${s.model.n_mooned} mooned vs ${s.model.n_died} died) · ${new Date(s.generatedAt).toLocaleTimeString()}</div>
    <table class="tbl"><thead><tr><th>Token</th><th>Pad</th><th class="r">Age</th><th class="r">Mcap</th><th class="r">Sim.</th><th>Top drivers (log-LR)</th><th class="r">Buyers/300tx</th><th class="r">Med buy</th></tr></thead><tbody>${s.tokens.slice(0, 20).map((t) => `<tr data-c="solana" data-a="${esc(t.mint)}"><td><b>${esc(t.symbol)}</b></td><td class="muted">${esc(t.launchpad)}</td><td class="r">${t.age_h.toFixed(1)}h</td><td class="r">${fUsd(t.cur_mcap)}</td><td class="r"><b class="${t.similarity >= 60 ? 'up' : t.similarity < 40 ? 'dn' : ''}">${t.similarity}</b></td><td class="small muted">${t.drivers.map(([k, v]) => `${esc(k)} ${v > 0 ? '+' : ''}${v}`).join(', ')}</td><td class="r">${t.trades?.unique_buyers ?? '—'}</td><td class="r">${fUsd(t.trades?.median_buy_usd)}</td></tr>`).join('')}</tbody></table><div class="disc" style="padding:0 8px">${esc(s.disclaimer)}</div>`;
  if (Object.keys(BC).length > 1) h += chainSummary();
  h += `<details class="ev" style="padding:4px 8px" open><summary>Caveats & data limits</summary><ul>${(a.caveats || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>`;
  box.innerHTML = h;
};
$('#moonOut').addEventListener('click', (e) => {
  const cr = e.target.closest('tr.chainrow'); if (cr) { curChain = cr.dataset.ch; $('#chainSel').value = curChain; localStorage.setItem(LS.chain, curChain); loadDisc(); window.loadMoon(); return; }
  const tr = e.target.closest('tr[data-a]'); if (tr) select(tr.dataset.c || 'solana', tr.dataset.a, null);
});

// ---------- Macro & News ----------
window.loadMacro = async function loadMacro() {
  const box = $('#macroOut');
  box.innerHTML = '<div class="empty"><span class="spin"></span> loading FRED, Fed, Kalshi, news…</div>';
  const [m, n, ev] = await Promise.all([api('/api/macro').catch((e) => ({ error: e.message })), api('/api/news').catch((e) => ({ error: e.message, items: [] })), api('/api/macro/events').catch(() => null)]);
  const pc = (v, d = 2) => (v == null ? '—' : (+v).toFixed(d) + '%');
  const dt = (d) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const days = (d) => { if (!d) return ''; const x = Math.round((Date.parse(d + 'T12:00:00Z') - Date.now()) / 864e5); return x >= 0 ? `in ${x}d` : `${-x}d ago`; };
  let h = '';
  if (m.error) h += `<div class="empty">Macro snapshot failed: ${esc(m.error)}</div>`;
  else {
    const f = m.fed || {}, y = m.yields || {}, dd = m.data || {};
    h += `<div class="kv">
      <div><span class="muted small">Fed funds target</span><b>${f.target ? `${f.target.lower.toFixed(2)}–${f.target.upper.toFixed(2)}%` : '—'}</b><span class="muted small">effective ${pc(f.effective?.v)} (${esc(f.effective?.d || '')})</span></div>
      <div><span class="muted small">Next FOMC</span><b>${esc(f.nextMeeting?.label || '—')}</b><span class="muted small">${dt(f.nextMeeting?.end)} · ${days(f.nextMeeting?.end)}</span></div>
      <div><span class="muted small">2y / 10y Treasury</span><b>${pc(y.dgs2?.v)} / ${pc(y.dgs10?.v)}</b><span class="muted small">2s10s ${y.spread2s10s != null ? (y.spread2s10s >= 0 ? '+' : '') + y.spread2s10s.toFixed(2) : '—'} · ${esc(y.dgs10?.d || '')}</span></div>
      <div><span class="muted small">Payrolls (${esc(dd.nfp?.refMonth || '')})</span><b>${dd.nfp?.change != null ? (dd.nfp.change >= 0 ? '+' : '') + dd.nfp.change + 'K' : '—'}</b><span class="muted small">unemployment ${pc(dd.unrate?.v, 1)}</span></div>
      <div><span class="muted small">CPI y/y (${esc((dd.cpi?.date || '').slice(0, 7))})</span><b>${pc(dd.cpi?.yoy, 1)}</b><span class="muted small">m/m ${pc(dd.cpi?.mom)} · PCE y/y ${pc(dd.pce?.yoy, 1)}</span></div>
      <div><span class="muted small">Real GDP (${esc((dd.gdp?.quarter || '').slice(0, 7))})</span><b>${pc(dd.gdp?.saar, 1)}</b><span class="muted small">q/q annualized</span></div></div>`;
    const k = (f.kalshi || [])[0];
    h += `<div class="macro2"><div><div class="grp">Market-implied odds: next FOMC (Kalshi)</div>${k ? `<div class="muted small">${esc(k.title)}</div>${k.outcomes.map((o) => `<div class="oddrow"><span>${esc(o.outcome)}</span><div class="bar"><i style="width:${Math.round((o.prob || 0) * 100)}%"></i></div><b>${o.prob != null ? Math.round(o.prob * 100) + '%' : '—'}</b></div>`).join('')}` : '<div class="muted small">Kalshi unavailable</div>'}
      ${(f.kalshi || []).slice(1, 3).map((e) => `<div class="muted small" style="margin-top:4px">${esc(e.title)}: ${e.outcomes.slice(0, 2).map((o) => `${esc(o.outcome)} ${Math.round((o.prob || 0) * 100)}%`).join(' · ')}</div>`).join('')}
      ${(f.polymarket || []).slice(0, 1).map((e) => `<div class="muted small" style="margin-top:4px">Polymarket "${esc(e.title)}": ${e.markets.slice(0, 3).map((x) => `${esc(x.q)} ${Math.round(x.yes * 100)}%`).join(' · ')}</div>`).join('')}</div>
      <div><div class="grp">Recent FOMC decisions</div><table class="tbl"><tbody>${(f.recentDecisions || []).slice(0, 6).map((r) => `<tr><td>${esc(r.label)}</td><td class="${/hike/.test(r.decision) ? 'dn' : /cut/.test(r.decision) ? 'up' : 'muted'}">${esc(r.decision)}</td><td class="r">${r.lower.toFixed(2)}–${r.upper.toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>
      <div><div class="grp">Economic calendar (BLS/BEA via FRED)</div><table class="tbl"><tbody>${Object.entries(m.calendar || {}).map(([, c]) => `<tr><td>${esc(c.name.replace(/ \(.*\)/, ''))}</td><td class="r">${dt(c.next)}</td><td class="muted small">${days(c.next)}</td><td class="muted small">last ${dt(c.last)}</td></tr>`).join('')}${f.nextMeeting ? `<tr><td>FOMC decision</td><td class="r">${dt(f.nextMeeting.end)}</td><td class="muted small">${days(f.nextMeeting.end)}</td><td></td></tr>` : ''}</tbody></table></div></div>`;
  }
  if (ev && ev.summary) {
    const S = ev.summary, B = ev.baseline || {};
    const cell = (g, a, hz) => { const x = S[g]?.[a]?.[hz]; return x && x.n ? `<span class="${x.median >= 0 ? 'up' : 'dn'}">${x.median >= 0 ? '+' : ''}${x.median.toFixed(1)}%</span> <span class="muted small">${Math.round(x.pct_up)}%↑ n${x.n}</span>` : '<span class="muted">—</span>'; };
    const rows = [['fomc:cut', 'FOMC cut'], ['fomc:hike', 'FOMC hike'], ['fomc:hold', 'FOMC hold'], ['nfp:hot', 'Jobs report hot'], ['nfp:cold', 'Jobs report cold'], ['cpi:hot', 'CPI hot'], ['cpi:cold', 'CPI cold']];
    h += `<div class="grp" style="padding:0 8px">Macro context: BTC / SOL median move around events (event-day close vs prior close, and +7d) · baseline mean |daily move| BTC ${B.btc_mean_abs_daily_move?.toFixed(1)}%, SOL ${B.sol_mean_abs_daily_move?.toFixed(1)}%</div>
      <table class="tbl"><thead><tr><th>Event</th><th class="r">events</th><th class="r">BTC day</th><th class="r">BTC +7d</th><th class="r">SOL day</th><th class="r">SOL +7d</th><th>window</th></tr></thead><tbody>${rows.map(([g, l]) => `<tr><td>${l}</td><td class="r">${S[g]?.n_events ?? 0}</td><td class="r">${cell(g, 'btc', 'r0')}</td><td class="r">${cell(g, 'btc', 'r7')}</td><td class="r">${cell(g, 'sol', 'r0')}</td><td class="r">${cell(g, 'sol', 'r7')}</td><td class="muted small">${esc(S[g]?.first || '')} → ${esc(S[g]?.last || '')}</td></tr>`).join('')}</tbody></table>
      <details class="ev" style="padding:2px 8px"><summary>Method & small-sample caveats</summary><div class="small">${esc(ev.method)}</div><ul>${ev.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>`;
  } else h += '<div class="muted small" style="padding:4px 8px">Event study not generated yet: run <code>python3 research/macro_events.py</code>.</div>';
  h += `<div class="grp" style="padding:0 8px">Breaking crypto & macro news</div><table class="tbl news"><tbody>${(n.items || []).slice(0, 40).map((x) => `<tr><td class="muted small nowrap">${x.ts ? fAge(x.ts) : ''}</td><td><span class="chip ${x.cat === 'macro' ? 'a' : ''}">${esc(x.source)}</span></td><td><a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a></td></tr>`).join('')}</tbody></table>
    <div class="muted small" style="padding:2px 8px">feeds: ${Object.entries(n.status || {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')} · ${esc(n.note || '')}</div>
    <div class="muted small" style="padding:2px 8px">sources: ${esc(Object.values((m.sources || {})).filter((v) => typeof v === 'string').join(' · '))} · not financial advice</div>`;
  box.innerHTML = h;
};

// Show 'Sign out' when the server is password-protected (SITE_PASSWORD set).
fetch('/api/health').then((r) => r.json()).then((j) => { if (j.auth) document.getElementById('logoutBtn').hidden = false; }).catch(() => {});
