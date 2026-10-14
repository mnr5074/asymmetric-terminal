// 'First posted / Updated' line for pick/setup/alert cards. The server adds `_fs: {f, u, c}` (lib/firstseen.js). Times in Pacific.
(() => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rel = (t) => { const s = (Date.now() - t) / 1000; if (s < 90) return 'just now'; const m = s / 60; if (m < 60) return Math.round(m) + 'm ago'; const h = m / 60; if (h < 48) return Math.round(h) + 'h ago'; return Math.round(h / 24) + 'd ago'; };
  const at = (t) => `${fmt.format(new Date(t))} PT (${rel(t)})`;
  const E = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.fsText = (o) => { const x = o && o._fs; if (!x || !x.f) return ''; return `First posted: ${at(x.f)}` + (x.u && x.u > x.f ? ` · Updated: ${at(x.u)}${x.c ? ` (${x.c})` : ''}` : ''); };
  const P = (v) => (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(3));
  window.fsPrice = (o) => {
    const x = o && o._fs; if (!x || x.p0 == null) return '';
    let h = `Price at alert: $${P(x.p0)}`;
    if (x.pn != null) {
      h += ` · Now: $${P(x.pn)} <span class="${x.pct >= 0 ? 'up' : 'dn'}">${x.pct >= 0 ? '+' : ''}${x.pct.toFixed(1)}%</span> <span class="muted">(price as of ${E(fmt.format(new Date(x.pnAt)))} PT, ${rel(x.pnAt)})</span>`;
      if (x.st === 'invalid') h += ` <span class="fsbadge inv" title="${x.stop != null ? 'fell through walk-away $' + P(x.stop) + ' or a rug/veto flag appeared' : 'rug/veto flag appeared'}">Invalidated</span>`;
      else if (x.st === 'cheaper') h += ` <span class="fsbadge chp" title="below the alert price, thesis still holds${x.stop != null ? ' (above walk-away $' + P(x.stop) + ')' : ''}">Cheaper than alert</span>`;
    }
    return h;
  };
  window.fsLine = (o, inline) => { const t = window.fsText(o), pr = window.fsPrice(o); if (!t && !pr) return ''; const tag = inline ? 'span' : 'div'; return `<${tag} class="fsline muted small">${E(t)}${pr ? `<br>${pr}` : ''}</${tag}>`; };
  const css = document.createElement('style'); css.textContent = '.fsline{font-size:.78em;opacity:.9;margin-top:2px}.fsline .up{color:#3ecf8e}.fsline .dn{color:#ff6b6b}.fsbadge{display:inline-block;border-radius:999px;padding:0 7px;margin-left:4px;font-size:.95em}.fsbadge.chp{background:#12351f;color:#5fe39a}.fsbadge.inv{background:#3a1515;color:#ff8a8a}'; document.head.appendChild(css);
})();
