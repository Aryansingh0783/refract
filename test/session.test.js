'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Session } = require('../src/core/session');

// Fake winhelper: a 2560x1440 panel and a game process that appears, runs, then exits.
function fakeWin() {
  const w = { mode: { width: 2560, height: 1440, hz: 165 }, calls: [], running: [false, true, true, false] };
  w.call = async (cmd, args) => {
    w.calls.push([cmd, args]);
    if (cmd === 'current') return { ...w.mode };
    if (cmd === 'modes') return [{ width: 2560, height: 1440, hz: 165 }, { width: 2048, height: 1152, hz: 165 }, { width: 1600, height: 900, hz: 165 }];
    if (cmd === 'setMode') { w.mode = { width: args.width, height: args.height, hz: args.hz }; return 'ok'; }
    if (cmd === 'running') return w.running.length ? w.running.shift() : false;
    throw new Error('unexpected ' + cmd);
  };
  return w;
}
function fakeStore(tier) {
  let data = { nativeMode: null };
  return { get: () => data, patch: p => { data = { ...data, ...p }; return data; }, game: () => ({ tier, exe: 'C:\\Games\\X\\x.exe' }) };
}

test('session applies the tier, watches the process and restores native', async () => {
  const win = fakeWin(), store = fakeStore('performance'), events = [];
  const s = new Session(win, store, (ch, d) => events.push([ch, d]));
  const g = { id: 'steam:1', name: 'X', exe: 'C:\\Games\\X\\x.exe', launch: null };
  const cp = require('child_process');
  const real = cp.spawn;
  cp.spawn = () => ({ unref() {} });
  try { await s.launch(g); } finally { cp.spawn = real; }
  clearInterval(s.timer);
  assert.deepStrictEqual(win.mode, { width: 1600, height: 900, hz: 165 }, 'performance tier applied');
  assert.deepStrictEqual(store.get().nativeMode, { width: 2560, height: 1440, hz: 165 }, 'native remembered');
  for (let i = 0; i < 4 && s.active; i++) await s.tick();
  assert.strictEqual(s.active, null, 'session ended after the process exited');
  assert.deepStrictEqual(win.mode, { width: 2560, height: 1440, hz: 165 }, 'native restored');
  assert.strictEqual(store.get().nativeMode, null);
  assert.deepStrictEqual(events.filter(e => e[0] === 'session').map(e => e[1].state), ['launching', 'running', 'ended']);
});

test('session refuses to launch without an executable', async () => {
  const s = new Session(fakeWin(), { get: () => ({}), patch() {}, game: () => ({ tier: 'native' }) }, () => {});
  await assert.rejects(s.launch({ id: 'x', name: 'X', exe: null }), /executable/);
});
