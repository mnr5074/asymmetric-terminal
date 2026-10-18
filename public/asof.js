// asof.js: "data as of" stamps (2026-10-18). Loaded right after netcache.js. Records the server's x-data-asof header for every
// /api/* response, then puts a chip on each panel / Today card / desk ("as of 6:31 AM PT · 12m old") and a page banner in the top bar.
// On Render (RENDER_LITE) the banner says plainly that everything is a snapshot frozen at deploy time. Times are shown in PT.
'use strict';
(function () {
  const TZ = 'America/Los_Angeles';
  const fmt = (t, withDay) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...(withDay ? { month: 'short', day: 'numeric' } : {}) }).format(new Date(t)) + ' PT';
  const isToday = (t) => fmt(t, true).split(',')[0] === fmt(Date.now(), true).split(',')[0];
  const when = (t) => fmt(t, !isToday(t));
  const age = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + 'm old' : s < 172800 ? (s / 3600).toFixed(s < 36000 ? 1 : 0) + 'h old' : Math.round(s / 86400) + 'd old'; };
  const lvl = (t) => { const h = (Date.now() - t) / 3600e3; return h > 24 ? 'old' : h > 2 ? 'aging' : 'fresh'; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const R = new Map(); let INFO = null;
  window.ASOF = { routes: R, fmt: when, age, info: () => INFO };

  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const p = orig(input, init);
    if (url && /^\/api\//.test(url.replace(location.origin, ''))) p.then((r) => { try {
      const h = r.headers.get('x-data-asof-src'); if (!h) return;
      const route = url.replace(location.origin, '').split('?')[0]; const t = Date.parse(r.headers.get('x-data-asof') || '');
      R.set(route, { t: isFinite(t) ? t : null, src: h, snapshot: r.headers.get('x-data-snapshot') === '1', fetchedAt: Date.now() }); schedule();
    } catch {} }).catch(() => {});
    return p;
  };

  const css = document.createElement('style');
  css.textContent = `.asof{font:10px/1.3 ui-monospace,Menlo,Consolas,monospace;color:#7d889b;border:1px solid #2a3342;border-radius:3px;padding:0 4px;margin-left:6px;white-space:nowrap;font-weight:normal;letter-spacing:0}
.asof.aging{color:#fcd34d;border-color:#7c5e10}.asof.old{color:#fca5a5;border-color:#7f1d1d}.asof.snap{color:#c4b5fd;border-color:#4c3d8f}
#asofBanner{font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;padding:3px 10px;background:#121821;border-bottom:1px solid #2a3342;color:#9aa5b5}
#asofBanner.lite{background:#2a1f05;color:#fcd34d;border-bottom-color:#7c5e10}#asofBanner b{color:#fff}`;
  document.head.appendChild(css);

  function chipFor(route) {
    const r = route && R.get(route);
    if (!r) return null;
    if (r.t) {
      const snap = r.snapshot || INFO?.lite;
      return { cls: snap ? 'snap ' + lvl(r.t) : lvl(r.t), text: `${snap ? 'snapshot · ' : ''}as of ${when(r.t)} · ${age(r.t)}`, title: `Data produced ${fmt(r.t, true)} (${r.src}); fetched ${fmt(r.fetchedAt, true)}${snap ? '. Render serves a frozen deploy-time snapshot.' : ''}` };
    }
    if (r.src === 'computed live') return { cls: 'fresh', text: `live · ${when(r.fetchedAt)}`, title: 'Computed on request from live inputs' };
    const s = INFO?.snapshotAt;
    return { cls: 'snap', text: s ? `snapshot · ≤ ${when(s)}` : 'snapshot · time unknown', title: 'Render snapshot: frozen at deploy time; this payload carries no own timestamp' };
  }
  function routeOf(el) {
    if (el.dataset.provRoute) return el.dataset.provRoute;
    const a = el.querySelector('[data-prov-route]'); if (a) return a.dataset.provRoute;
    const g = el.dataset.provRouteGuess ? el : el.querySelector('[data-prov-route-guess]'); return g ? (g.dataset.provRouteGuess || null) : null;
  }
  function put(host, c) {
    if (!host) return; let s = host.querySelector(':scope > .asof');
    if (!c) { if (s) s.remove(); return; }
    if (!s) { s = document.createElement('span'); s.className = 'asof'; host.appendChild(s); }
    if (s.textContent !== c.text) s.textContent = c.text; const cl = 'asof ' + c.cls; if (s.className !== cl) s.className = cl; s.title = c.title;
  }
  function paint() {
    for (const p of document.querySelectorAll('.panel')) { const h = p.querySelector(':scope > .phead'); if (!h) continue; put(h.firstElementChild && h.firstElementChild.tagName !== 'BUTTON' ? h.firstElementChild : h, chipFor(routeOf(p))); }
    for (const c of document.querySelectorAll('.tcard')) put(c.querySelector('h3'), chipFor(routeOf(c)));
    const dk = R.get('/api/desks');
    for (const d of document.querySelectorAll('#ccDesks .desk')) {
      const t = +d.dataset.updated || null; const h = d.querySelector('.dh'); if (!h) continue;
      put(h, t ? { cls: (INFO?.lite ? 'snap ' : '') + lvl(t), text: `${INFO?.lite ? 'snapshot · ' : ''}as of ${when(t)} · ${age(t)}`, title: 'Desk summary last updated (PT)' } : chipFor('/api/desks'));
    }
    banner();
  }
  let pend = false; function schedule() { if (pend) return; pend = true; setTimeout(() => { pend = false; paint(); }, 300); }
  function banner() {
    if (!INFO) return; let b = document.getElementById('asofBanner');
    if (!b) { b = document.createElement('div'); b.id = 'asofBanner'; const hdr = document.querySelector('header.topbar'); if (hdr) hdr.after(b); else document.body.prepend(b); }
    let h;
    if (INFO.lite) {
      const s = INFO.snapshotAt; const d = INFO.buildAt || INFO.serverStartedAt;
      h = `<b>SNAPSHOT</b> — this Render deploy serves data frozen at deploy time; nothing here updates live. Data last written on the box: <b>${s ? esc(fmt(s, true)) + ' (' + esc(age(s)) + ')' : 'unknown'}</b> · ${INFO.buildAt ? 'built' : 'server started'} ${d ? esc(fmt(d, true)) : '—'}${INFO.commit ? ' · commit ' + esc(INFO.commit) : ''}. Each panel shows its own data time.`;
    } else {
      const ts = [...R.values()].map((r) => r.t).filter(Boolean); const newest = ts.length ? Math.max(...ts) : null, oldest = ts.length ? Math.min(...ts) : null;
      h = `Live box server · page loaded ${esc(fmt(LOADED, true))}${newest ? ` · data on this page from ${esc(when(oldest))} to ${esc(when(newest))}` : ''} · each panel shows when its data was produced (PT) and how old it is.`;
    }
    if (b.innerHTML !== h) b.innerHTML = h; b.className = INFO.lite ? 'lite' : '';
  }
  const LOADED = Date.now();
  orig('/api/asof').then((r) => r.ok ? r.json() : null).then((d) => { if (d) { INFO = d; paint(); } }).catch(() => {});
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(paint, 20e3);
})();
