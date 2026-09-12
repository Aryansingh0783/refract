'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gpupref = require('../src/core/gpupref');

function fakeReg(store) {
  return (file, args, opts, cb) => {
    assert.strictEqual(file, 'reg.exe');
    const [verb, key, , name] = args;
    assert.strictEqual(key, gpupref.KEY);
    if (verb === 'query') {
      if (!(name in store)) return cb(new Error('not found'));
      return cb(null, `\r\n${gpupref.KEY}\r\n    ${name}    REG_SZ    ${store[name]}\r\n\r\n`);
    }
    if (verb === 'add') { store[name] = args[args.indexOf('/d') + 1]; return cb(null, 'ok'); }
    if (verb === 'delete') { delete store[name]; return cb(null, 'ok'); }
    return cb(new Error('unexpected ' + verb));
  };
}

const only = process.platform === 'win32' ? test : test.skip;

only('a game with no preference is pointed at the discrete GPU, and restore removes it', async () => {
  const store = {};
  const exe = 'C:\\Games\\game.exe';
  const r = await gpupref.preferHighPerformance(exe, fakeReg(store));
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.previous, null);
  assert.strictEqual(store[exe], gpupref.HIGH);
  await gpupref.restore(exe, r.previous, fakeReg(store));
  assert.strictEqual(exe in store, false, 'the value is gone again');
});

only('an existing preference is remembered and put back', async () => {
  const exe = 'C:\\Games\\other.exe';
  const store = { [exe]: 'GpuPreference=1;' };
  const r = await gpupref.preferHighPerformance(exe, fakeReg(store));
  assert.strictEqual(r.previous, 'GpuPreference=1;');
  assert.strictEqual(store[exe], gpupref.HIGH);
  await gpupref.restore(exe, r.previous, fakeReg(store));
  assert.strictEqual(store[exe], 'GpuPreference=1;');
});

only('already set to high performance is a no-op', async () => {
  const exe = 'C:\\Games\\third.exe';
  const store = { [exe]: gpupref.HIGH };
  const r = await gpupref.preferHighPerformance(exe, fakeReg(store));
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.previous, gpupref.HIGH);
});

test('off Windows it does nothing rather than failing', async () => {
  if (process.platform === 'win32') return;
  const r = await gpupref.preferHighPerformance('C:\\g.exe');
  assert.deepStrictEqual(r, { changed: false, previous: null });
});
