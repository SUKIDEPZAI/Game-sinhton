'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const jsFiles = ['server.js', 'db/migrate.js', 'public/admin.routes.js', 'public/prompt.routes.js'];
for (const file of jsFiles) execFileSync(process.execPath, ['--check', path.join(root, file)]);
for (const file of ['sprites.json', 'weapon-tuning.json', 'package.json'])
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
const algo = require('../public/prompt.routes.js');
const cases = [
  ['a\nb', 'a\nc'], ['a', 'a\nb'], ['a\nb', 'b'], ['', 'hello'],
  ['one\ntwo\nthree', 'zero\none\nthree\nfour'],
  ['same', 'same'], ['a\nb\nc', ''], ['a\nb', 'x\ny']
];
let seed = 12345;
function rand(n) { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; }
for (let i = 0; i < 300; i++) {
  const a = Array.from({length:rand(10)}, () => String(rand(8))).join('\n');
  const b = Array.from({length:rand(10)}, () => String(rand(8))).join('\n');
  cases.push([a,b]);
}
for (const [before, after] of cases) {
  const delta = algo.compressDelta(algo.myersDiff(before, after));
  assert.equal(algo.applyDelta(before.split('\n'), delta).join('\n'), after,
    `Delta round-trip failed for ${JSON.stringify([before,after])}`);
}
console.log(`PASS: ${jsFiles.length} JS syntax checks, 3 JSON parses, ${cases.length} delta round trips`);
