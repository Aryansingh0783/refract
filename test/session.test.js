'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Session } = require('../src/core/session');

// Fake winhelper: a 2560x1440 panel and a scripted sequence of process states.
function fakeWin(states) {
  const w = { mode: { width: 2560, height: 1440, hz: 165 }, calls: [], states: [...states], broken: false };
  w.call = async (cmd, args) => {
    w.calls.push([cmd, args]);
    if (cmd === 'current') return { ...w.mode };
    if (cmd === 'modes') return [{ width: 2560, height: 1440, hz: 165 }, { width: 2048, height: 1152, hz: 165 }, { width: 1600, height: 900, hz: 165 }];
    if (cmd === 'setMode') { w.mode = { width: args.width, height: args.height, hz: args.hz }; return 'ok'; }
    if (cmd === 'procstate') {
      if (w.broken) throw new Error('helper died');
      return w.states.length > 1 ? w.states.shift() : w.states[0];
    }
    throw new Error('unexpected ' + cmd);
  };
  return w;
}
function fakeStore(tier) {
  let data = { nativeMode: null };
  return { get: () => data, patch: p => { data = { ...data, ...p }; return data; }, game: () => ({ tier, exe: 'C:\\Games\\X\\x.exe' }) };
}
const GAME = { id: 'steam:1', name: 'X', exe: 'C:\\Games\\X\\x.exe', launch: null };
async function start(s) {
  const cp = require('child_process');
  const real = cp.spawn;
  cp.spawn = () => ({ unref() {} });
  try { await s.launch(GAME); } finally { cp.spawn = real; }
  clearInterval(s.timer);
}
const states = events => events.filter(e => e[0] === 'session').map(e => e[1].state);
const RUN = { count: 1, windows: 1 }, GONE = { count: 0, windows: 0 }, LINGER = { count: 1, windows: 0 };

test('session applies the tier, watches the process and restores native on exit', async () => {
  const win = fakeWin([GONE, RUN, RUN, GONE]), store = fakeStore('performance'), events = [];
  const s = new Session(win, store, (ch, d) => events.push([ch, d]));
  await start(s);
  assert.deepStrictEqual(win.mode, { width: 1600, height: 900, hz: 165 }, 'performance tier applied');
  for (let i = 0; i < 6 && s.active; i++) await s.tick();
  assert.strictEqual(s.active, null, 'session ended after the process exited');
  assert.deepStrictEqual(win.mode, { width: 2560, height: 1440, hz: 165 }, 'native restored');
  assert.deepStrictEqual(states(events), ['launching', 'running', 'ended']);
});

test('a game that lingers in the background with no window still ends the session', async () => {
  const win = fakeWin([RUN, LINGER]), events = [];
  const s = new Session(win, fakeStore('native'), (ch, d) => events.push([ch, d]));
  s.lingerMs = 0; // no grace period in the test
  await start(s);
  await s.tick();                 // window seen -> running
  await new Promise(r => setTimeout(r, 5));
  await s.tick();                 // process alive, window gone -> ended
  assert.strictEqual(s.active, null);
  assert.deepStrictEqual(states(events), ['launching', 'running', 'ended']);
});

test('a helper that keeps failing ends the session instead of hanging "Running" forever', async () => {
  const win = fakeWin([RUN]), events = [];
  const s = new Session(win, fakeStore('native'), (ch, d) => events.push([ch, d]));
  await start(s);
  await s.tick();
  win.broken = true;
  for (let i = 0; i < 5; i++) await s.tick();
  assert.strictEqual(s.active, null);
  assert.strictEqual(events.at(-1)[1].reason, 'lost');
});

test('a stale session does not block the next launch; a live one does', async () => {
  const win = fakeWin([RUN]);
  const s = new Session(win, fakeStore('native'), () => {});
  await start(s);
  await assert.rejects(s.launch(GAME), /still running/);
  win.states = [GONE];
  await start(s); // stale one is cleared, new one starts
  assert.ok(s.active);
});

test('end() clears a session by hand', async () => {
  const events = [];
  const s = new Session(fakeWin([RUN]), fakeStore('native'), (ch, d) => events.push([ch, d]));
  await start(s);
  assert.strictEqual(await s.end(), true);
  assert.strictEqual(s.active, null);
  assert.strictEqual(events.at(-1)[1].state, 'ended');
});

test('session refuses to launch without an executable', async () => {
  const s = new Session(fakeWin([GONE]), { get: () => ({}), patch() {}, game: () => ({ tier: 'native' }) }, () => {});
  await assert.rejects(s.launch({ id: 'x', name: 'X', exe: null }), /executable/);
});
