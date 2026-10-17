// 'First posted / Updated' + 'Price at alert / Now' line for pick/setup/alert cards. The server adds `_fs` (lib/firstseen.js). Times in Pacific.
// 'Now' is always a LIVE price: every rendered card's `_fs.lk` is fetched from /api/liveprice (lib/liveprice.js, free sources, 30 s server
// cache) on page load / view refresh and again every 60 s while the tab is visible, never the frozen snapshot price in the payload.
// Cheaper-than-alert / Invalidated badges are decided here from that live price. No genuine stored alert price -> 'alert price unknown'.
(() => {
  const TZ = 'America/Los_Angeles';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtS = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const rel = (t) => { const s = (Date.now() - t) / 1000; if (s < 90) return 'just now'; const m = s / 60; if (m < 60) return Math.round(m) + 'm ago'; const h = m / 60; if (h < 48) return Math.round(h) + 'h ago'; return Math.round(h / 24) + 'd ago'; };
  const at = (t) => `${fmt.format(new Date(t))} PT (${rel(t)})`;
  const E = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.fsText = (o) => { const x = o && o._fs; if (!x || !x.f) return ''; return `First posted: ${at(x.f)}` + (x.u && x.u > x.f ? ` · Updated: ${at(x.u)}${x.c ? ` (${x.c})` : ''}` : ''); };
  const P = (v) => (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(3));
  const badge = (live, p0, stop, bk) => {
    if (bk || (stop != null && live != null && live < stop)) return ` <span class="fsbadge inv" title="${stop != null ? 'live price fell through walk-away $' + P(stop) + ' or a rug/veto flag appeared' : 'rug/veto flag appeared'}">Invalidated</span>`;
    if (live != null && p0 != null && live < p0) return ` <span class="fsbadge chp" title="live price is below the alert price, thesis still holds${stop != null ? ' (above walk-away $' + P(stop) + ')' : ''}">Cheaper than alert</span>`;
    return '';
  };
  const nowHtml = (v, p0, stop, bk) => {
    if (!v) return 'Now: <span class="muted">fetching live price…</span>';
    if (!(v.p > 0)) return `Now: <span class="muted" title="${E(v.err || '')}">live price unavailable</span>${badge(null, p0, stop, bk)}`;
    const pct = p0 != null ? (v.p / p0 - 1) * 100 : null;
    return `Now: $${P(v.p)}${pct != null ? ` <span class="${pct >= 0 ? 'up' : 'dn'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>` : ''} <span class="muted">(live ${E(v.src || '')}${v.quoteAsOf ? ', quote ' + E(v.quoteAsOf) : ''}, fetched ${E(fmtS.format(new Date(v.at)))} PT)</span>${badge(v.p, p0, stop, bk)}`;
  };
  window.fsPrice = (o) => {
    const x = o && o._fs; if (!x || (x.p0 == null && !x.unk && !x.lk)) return '';
    let h = x.p0 != null ? `Price at alert: $${P(x.p0)}` : 'Price at alert: <span class="muted" title="no price was stored when this pick was first posted">alert price unknown</span>';
    const p0 = x.p0 != null ? x.p0 : '', st = x.stop != null ? x.stop : '';
    if (x.lk) { const c = got(x.lk); h += ` · <span class="lp" data-lk="${E(x.lk)}" data-p0="${p0}" data-stop="${st}" data-bk="${x.bk ? 1 : ''}">${nowHtml(c, x.p0, x.stop, x.bk)}</span>`; }
    else h += ` · ${nowHtml({ err: 'no live source for this item' }, x.p0, x.stop, x.bk)}`;
    return h;
  };
  window.fsLine = (o, inline) => { const t = window.fsText(o), pr = window.fsPrice(o); if (!t && !pr) return ''; const tag = inline ? 'span' : 'div'; return `<${tag} class="fsline muted small">${E(t)}${pr ? `${t ? '<br>' : ''}${pr}` : ''}</${tag}>`; };

  // ---- live price fetcher: batches every unfilled .lp span on the page into /api/liveprice calls ----
  const C = new Map(); // lk -> { v, t } (page-side, 25 s; the server caches 30 s)
  const got = (k) => { const c = C.get(k); return c && Date.now() - c.t < 25e3 ? c.v : null; };
  const fill = (k, v) => document.querySelectorAll(`.lp[data-lk="${CSS.escape(k)}"]`).forEach((el) => { const n = (a) => (el.dataset[a] !== '' && el.dataset[a] != null ? +el.dataset[a] : null); el.innerHTML = nowHtml(v, n('p0'), n('stop'), el.dataset.bk === '1'); el.dataset.st = 'done'; el.dataset.t = String(Date.now()); });
  const tries = new Map(); let busy = false, again = false;
  async function scan(force) {
    if (busy) { again = true; return; } busy = true;
    try {
      const want = new Set();
      const H = innerHeight + 800;
      document.querySelectorAll('.lp[data-lk]').forEach((el) => { const k = el.dataset.lk;
        if (k[0] === 'o') { const r = el.getBoundingClientRect(); if (!r.width || r.bottom < -800 || r.top > H) return; } /* stock options: CBOE chain per underlying is MBs, only cards on/near screen */ const c = got(k); if (c && !force) { if (el.dataset.st !== 'done' || +el.dataset.t < C.get(k).t) fill(k, c); } else if (force || el.dataset.st !== 'done') want.add(k); });
      const ks = [...want];
      for (let i = 0; i < ks.length; i += 150) {
        const part = ks.slice(i, i + 150);
        try {
          const r = await fetch('/api/liveprice?k=' + encodeURIComponent(part.join(','))); const d = await r.json(); const t = Date.now();
          for (const k of part) {
            const v = (d.px || {})[k] || { err: d.error || 'no price' };
            if (v.retry && (tries.get(k) || 0) < 8) { tries.set(k, (tries.get(k) || 0) + 1); setTimeout(() => scan(false), 4000); continue; }
            tries.delete(k); C.set(k, { v, t }); fill(k, v);
          }
        } catch (e) { for (const k of part) fill(k, { err: 'live price request failed' }); }
      }
    } finally { busy = false; if (again) { again = false; setTimeout(() => scan(false), 50); } }
  }
  let deb = null; const kick = () => { clearTimeout(deb); deb = setTimeout(() => scan(false), 250); };
  const start = () => { new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('.lp') || n.querySelector?.('.lp:not([data-st])'))) return kick(); }).observe(document.body, { childList: true, subtree: true }); kick(); };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
  addEventListener('scroll', kick, { passive: true, capture: true });
  setInterval(() => { if (document.visibilityState === 'visible' && document.querySelector('.lp[data-lk]')) scan(true); }, 60e3);
  window.fsLiveRefresh = () => scan(true);

  const css = document.createElement('style'); css.textContent = '.fsline{font-size:.78em;opacity:.9;margin-top:2px}.fsline .up{color:#3ecf8e}.fsline .dn{color:#ff6b6b}.fsbadge{display:inline-block;border-radius:999px;padding:0 7px;margin-left:4px;font-size:.95em}.fsbadge.chp{background:#12351f;color:#5fe39a}.fsbadge.inv{background:#3a1515;color:#ff8a8a}'; document.head.appendChild(css);
})();
