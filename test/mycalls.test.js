'use strict';
// node test/mycalls.test.js : Martin's Calls API serves the scored snapshot (Render path, read-only), lists calls logged since the last
// scoring run as 'not scored yet', drops scores for removed calls, never runs the scorer in RENDER_LITE, and guests are 403'd on
// both /api/mycalls and /mycalls.js (personal, owner-only).
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { createMyCalls } = require('../lib/mycalls');
const { _guestBlock } = require('../lib/auth');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
const call = (id, t) => ({ id, symbol: id.toUpperCase(), chain: 'solana', contract: 'So1' + id, calledAt: t, call: 'waking up', priceAtCall: { usd: 1, how: 'reported' }, gibi: { verdict: 'stay out' } });
fs.writeFileSync(path.join(dir, 'martin_calls.json'), JSON.stringify({ calls: [call('a', 1000), call('b', 2000)] }));
fs.writeFileSync(path.join(dir, 'martin_calls_scored.json'), JSON.stringify({ generatedAt: 5000, scorecard: { strength: 'too few' }, items: [{ id: 'a', calledAt: 1000, h: { '7d': { done: true } } }, { id: 'gone', calledAt: 1500 }] }));
process.env.RENDER_LITE = '1';
const m = createMyCalls({ DATA_DIR: dir, root: dir, now: () => 6000 });
const r = m.api();
assert.deepStrictEqual(r.items.map((x) => x.id), ['b', 'a'], 'newest first, removed call dropped');
assert(r.items[0].unscored && r.items[0].lk === 'd:solana:So1b' && r.items[0].gibiDef.verdict === 'stay out');
assert(r.items[1].h['7d'].done && r.scorecard.strength === 'too few' && r.ageSec === 1);
assert.strictEqual(m.run('test'), false, 'scorer never runs on Render (RENDER_LITE)');
// guests: 403 on the API and the script; owner path untouched
const res = () => ({ code: 0, writeHead(c) { this.code = c; }, end(b) { this.body = b; } });
for (const p of ['/api/mycalls', '/mycalls.js']) { const s = res(); assert.strictEqual(_guestBlock({ method: 'GET' }, s, new URL('http://x' + p)), true, p); assert.strictEqual(s.code, 403); }
assert.strictEqual(_guestBlock({ method: 'GET' }, res(), new URL('http://x/api/waking')), false, 'public desks stay open to guests');
console.log("mycalls api + guest block ok");
