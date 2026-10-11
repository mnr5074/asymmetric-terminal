'use strict';
// Minimal dependency-free PDF writer (PDF 1.4, standard Helvetica fonts, WinAnsi). Enough for text, tables, rules,
// filled rectangles and simple bar charts. Letter size, points (1/72 in), origin top-left in this API.
const W_HELV = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333, '{': 334, '|': 260, '}': 334, '~': 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 };
const BOLD_EXTRA = { i: 56, l: 56, j: 56, f: 55, t: 55, r: 56, ' ': 0 };
function textWidth(s, size, bold) { let w = 0; for (const ch of String(s)) { let c = /[0-9]/.test(ch) ? 556 : (W_HELV[ch] ?? 556); if (bold) c += BOLD_EXTRA[ch] ?? (c > 300 ? 55 : 0); w += c; } return w * size / 1000; }
const clean = (s) => String(s ?? '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u2265/g, '>=').replace(/\u2264/g, '<=').replace(/[^\x20-\x7e]/g, '');
const esc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
class PDF {
  constructor({ width = 612, height = 792, margin = 40 } = {}) { this.W = width; this.H = height; this.M = margin; this.pages = []; this.newPage(); }
  newPage() { this.cur = []; this.pages.push(this.cur); this.y = this.M; return this; }
  _c(r, g, b) { return `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`; }
  text(x, y, s, { size = 9, bold = false, color = [20, 24, 32], align = 'left', maxWidth } = {}) {
    let str = clean(s);
    if (maxWidth) while (str.length > 1 && textWidth(str, size, bold) > maxWidth) str = str.slice(0, -2) + '.';
    let xx = x; const w = textWidth(str, size, bold);
    if (align === 'right') xx = x - w; else if (align === 'center') xx = x - w / 2;
    this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${this._c(...color)} rg ${xx.toFixed(2)} ${(this.H - y - size).toFixed(2)} Td (${esc(str)}) Tj ET`);
    return w;
  }
  rect(x, y, w, h, { fill = [240, 240, 240], stroke = null, lw = 0.5 } = {}) {
    let op = '';
    if (fill) op += `${this._c(...fill)} rg `; if (stroke) op += `${this._c(...stroke)} RG ${lw} w `;
    this.cur.push(`${op}${x.toFixed(2)} ${(this.H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }
  line(x1, y1, x2, y2, { color = [180, 186, 196], lw = 0.5 } = {}) { this.cur.push(`${this._c(...color)} RG ${lw} w ${x1.toFixed(2)} ${(this.H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.H - y2).toFixed(2)} l S`); }
  // wrap text into lines that fit width
  wrap(s, width, size = 9, bold = false) {
    const out = []; for (const para of clean(s).split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (textWidth(t, size, bold) > width && line) { out.push(line); line = w; } else line = t; } out.push(line); } return out;
  }
  para(s, { size = 9, bold = false, color, x = this.M, width = this.W - 2 * this.M, gap = 2 } = {}) {
    for (const l of this.wrap(s, width, size, bold)) { this.ensure(size + gap); this.text(x, this.y, l, { size, bold, color }); this.y += size + gap; }
  }
  ensure(h) { if (this.y + h > this.H - this.M - 14) this.newPage(); }
  // table: cols [{key,label,w,align}], rows [obj]; header repeats on new pages
  table(cols, rows, { size = 7.5, rowH = 11, headFill = [30, 41, 59], zebra = [245, 247, 250], x = this.M, fmt = {}, rowColor } = {}) {
    const head = () => { this.ensure(rowH * 2); this.rect(x, this.y, cols.reduce((s, c) => s + c.w, 0), rowH + 2, { fill: headFill }); let cx = x; for (const c of cols) { this.text(c.align === 'right' ? cx + c.w - 3 : cx + 3, this.y + 2, c.label, { size, bold: true, color: [255, 255, 255], align: c.align === 'right' ? 'right' : 'left', maxWidth: c.w - 4 }); cx += c.w; } this.y += rowH + 2; };
    head();
    rows.forEach((r, i) => {
      if (this.y + rowH > this.H - this.M - 14) { this.newPage(); head(); }
      if (i % 2 && zebra) this.rect(x, this.y, cols.reduce((s, c) => s + c.w, 0), rowH, { fill: zebra });
      let cx = x;
      for (const c of cols) { const v = fmt[c.key] ? fmt[c.key](r[c.key], r) : r[c.key]; const col = rowColor ? rowColor(r, c) : undefined; this.text(c.align === 'right' ? cx + c.w - 3 : cx + 3, this.y + 2, v ?? '', { size, align: c.align === 'right' ? 'right' : 'left', maxWidth: c.w - 4, color: col, bold: !!r._bold }); cx += c.w; }
      this.y += rowH;
    });
    this.y += 4;
  }
  footer(fn) { this.pages.forEach((p, i) => { this.cur = p; fn(this, i + 1, this.pages.length); }); }
  build(meta = {}) {
    const objs = []; const add = (s) => { objs.push(s); return objs.length; };
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1; objs.push(null);
    const kids = [];
    for (const p of this.pages) {
      const content = p.join('\n'); const cId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cId} 0 R >>`));
    }
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${esc(meta.title || 'Report')}) /Producer (Asymmetric Terminal Tax desk) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
module.exports = { PDF, textWidth };
