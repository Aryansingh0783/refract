'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The helper's C# is compiled at runtime by Add-Type; a duplicate member makes the whole
// helper fail to start (no session tracking, overlay focus, display modes or looks).
test('winhelper C# declares each native import once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'winhelper.ps1'), 'utf8');
  const m = src.match(/@"\r?\n([\s\S]*?)\r?\n"@/);
  assert.ok(m, 'found the Add-Type here-string');
  const cs = m[1];
  const sigs = [...cs.matchAll(/static\s+extern\s+[\w.]+\s+(\w+)\s*\(([^)]*)\)/g)]
    .map(m => m[1] + '(' + m[2].split(',').map(p => p.trim().split(/\s+/).slice(0, -1).join(' ')).join(',') + ')');
  assert.ok(sigs.length > 5, 'found the P/Invoke block');
  const dupes = sigs.filter((s, i) => sigs.indexOf(s) !== i);
  assert.deepStrictEqual(dupes, []);
  const opens = (cs.match(/{/g) || []).length, closes = (cs.match(/}/g) || []).length;
  assert.strictEqual(opens, closes, 'balanced braces');
});

test('winhelper exposes the commands main.js relies on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'winhelper.ps1'), 'utf8');
  for (const cmd of ['procstate', 'focus', 'foreground', 'current', 'modes', 'setMode', 'postKey', 'tap']) {
    assert.match(src, new RegExp(`['"]${cmd}['"]`), cmd);
  }
});

test('packaged builds run the helper from app.asar.unpacked', () => {
  const { unpackedPath } = require('../src/core/winhelper');
  const inAsar = 'C:\\Program Files\\Refract\\resources\\app.asar\\scripts\\winhelper.ps1';
  const real = 'C:\\Program Files\\Refract\\resources\\app.asar.unpacked\\scripts\\winhelper.ps1';
  assert.strictEqual(unpackedPath(inAsar, p => p === real), real);
  assert.strictEqual(unpackedPath(inAsar, () => false), inAsar);
  const dev = 'C:\\Users\\me\\Refract\\scripts\\winhelper.ps1';
  assert.strictEqual(unpackedPath(dev, () => true), dev);
});
