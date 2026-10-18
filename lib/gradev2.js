'use strict';
// Live Alpha Feed grade v2 (2026-10-18). The old A/B grade (weighted flow/participation/upside/similarity/... score) was audited
// against the forward call log: old A picks rugged 88% of the time (n=232 first calls >= 24h old) and hit 2x-without-rug 4.7%,
// below the 5.1% base rate. research/grades/ab_rebuild.py re-tests every call-time feature with a time split (oldest 60% train,
// newest 40% test, Bonferroni) and writes data/grade_rebuild.json. A letter is awarded ONLY from rules in that file that beat the
// base rate out-of-sample on hit rate AND did not raise the rug rate:
//   F = failed a safety veto · A = every passing rule true · B = at least one · U = "Unrated — safety checks only".
// If the file says nothing passes (verdict 'unrated'), every non-vetoed token is U. The legacy grade/score are kept for audit only.
const fs = require('fs');
const path = require('path');

const VETO_INFO = [ // id, label, matcher on the veto text, key in grade_rebuild.json vetoes, strength
  ['top10', 'Top-10 holders concentration', /top-10 wallets hold/i, 'top10_concentration', 'backtested'],
  ['quoteside', 'Fake liquidity (quote side)', /fake liquidity/i, 'fake_liquidity_quote_side', 'backtested'],
  ['honeypot', 'Honeypot signs', /honeypot/i, 'honeypot', 'backtested (small n)'],
  ['liquidity', 'Liquidity under $3K', /liquidity under/i, 'liquidity_under_3k', 'exclusion (too thin to trade)'],
  ['mint', 'Mint authority', /mint authority/i, null, 'unproven (rare)'],
  ['freeze', 'Freeze authority', /freeze authority/i, null, 'unproven (rare)'],
  ['tax', 'Buy/sell tax > 10%', /tax/i, null, 'unproven (rare)'],
  ['rugforecast', 'Rug forecast >= 70', /rug forecast/i, null, 'unproven'],
  ['pulled', 'Liquidity pulled since first seen', /liquidity down/i, 'liquidity_pulled', 'unproven'],
];

function createGradeV2({ DATA_DIR }) {
  const file = path.join(DATA_DIR, 'grade_rebuild.json');
  let G = null, mt = 0;
  function rebuild() {
    try { const st = fs.statSync(file); if (st.mtimeMs !== mt) { G = JSON.parse(fs.readFileSync(file, 'utf8')); mt = st.mtimeMs; } } catch { G = null; }
    return G;
  }
  const getv = (x, feature) => { const [grp, k] = feature.split('.'); const o = grp === 'comps' ? x.components : x.features; const v = o ? o[k] : null; return typeof v === 'number' && isFinite(v) ? v : null; };
  function safety(x) {
    const vt = x.veto || '';
    return VETO_INFO.map(([id, label, rx, gk, strength]) => {
      const failed = rx.test(vt); const s = gk && G?.vetoes?.[gk];
      return { id, label, status: failed ? 'fail' : x.scanned === false && id !== 'liquidity' ? 'not scanned' : 'pass', strength,
        evidence: s && s.n ? `vetoed tokens rugged ${Math.round(s.rugged * 100)}% (n=${s.n}); never hit 2x clean ${Math.round((s.noHit ?? 0) * 100)}%` : null };
    });
  }
  function regrade(x, { rugScore } = {}) {
    const g = rebuild(); const rules = g?.verdict === 'rated' ? (g.rulesPassed || []) : [];
    const legacy = x.legacyGrade || x.grade; const legacyScore = x.legacyScore ?? x.score;
    let grade, why;
    if (x.veto) { grade = 'F'; why = 'Safety veto: ' + x.veto; }
    else if (!rules.length) { grade = 'U'; why = 'Unrated — safety checks only (no feature beat the base rate out-of-sample).'; }
    else {
      const met = rules.filter((r) => { const v = getv(x, r.feature); return v != null && (r.op === '>=' ? v >= r.edge : v <= r.edge); });
      grade = met.length === rules.length ? 'A' : met.length ? 'B' : 'U';
      why = met.length ? `Meets ${met.length}/${rules.length} out-of-sample rule(s): ${met.map((r) => `${r.feature} ${r.op} ${r.edge}`).join(', ')}` : 'Unrated — safety checks only (passes vetoes, meets none of the proven rules).';
      const rs = rugScore ?? x.rug?.score;
      if (grade === 'A' && rs != null && rs >= 45) { grade = 'B'; why += `; capped at B by rug forecast ${rs}`; }
      if (grade === 'A' && x.scanned === false) { grade = 'B'; why += '; capped at B until the contract scan has run (holder/honeypot vetoes not checked yet)'; }
    }
    const ts = g?.after?.[grade];
    return Object.assign(x, { grade, legacyGrade: legacy, legacyScore, gradeModel: 'v2', gradeLabel: grade === 'U' ? 'Unrated — safety checks only' : grade === 'F' ? 'Vetoed' : grade,
      gradeWhy: why, gradeStrength: grade === 'A' || grade === 'B' ? (g?.strength || 'weak') : grade === 'F' ? 'safety veto' : 'n/a',
      gradeStats: ts && ts.n ? { n: ts.n, hit2x: ts.hit2x, rug: ts.rug, period: 'test period', baseHit2x: g?.split?.test?.baseHit2x, baseRug: g?.split?.test?.baseRug } : null,
      safety: safety(x) });
  }
  function info() {
    const g = rebuild(); if (!g) return { model: 'v2', verdict: 'unrated', text: 'data/grade_rebuild.json missing: every non-vetoed token is Unrated.' };
    return { model: 'v2', verdict: g.verdict, strength: g.strength, text: g.verdictText, generatedAt: g.generatedAt, rules: (g.rulesPassed || []).map((r) => ({ feature: r.feature, op: r.op, edge: r.edge, test: r.test })),
      before: g.beforeTest, after: g.after, split: g.split, vetoes: g.vetoes, oldScoreTest: g.oldScoreTest, script: 'research/grades/ab_rebuild.py' };
  }
  return { regrade, info, safety };
}
module.exports = { createGradeV2 };
