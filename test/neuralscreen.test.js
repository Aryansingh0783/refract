'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { NeuralScreen, KEY_FILES } = require('../src/core/neuralscreen');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-ns-'));
  const src = path.join(base, 'bundle');
  for (const rel of [...KEY_FILES, 'VERSION.txt', 'config.json', 'runtime/Lib/site-packages/cv2/x.pyd', 'NeuralScreen.log']) {
    const p = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel === 'VERSION.txt' ? 'NeuralScreen 1.6.0\n' : rel === 'config.json' ? '{"profile":"Natural","open_menu_on_start":true,"width":3840}' : 'x:' + rel);
  }
  return { base, src, home: path.join(base, 'home') };
}

function fakeSpawn(calls) {
  return (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242; child.exitCode = null; child.killed = false;
    calls.push({ file, args, opts, child });
    return child;
  };
}

test('prepare mirrors the bundle, links the runtime, keeps user files', async () => {
  const f = fixture();
  const ns = new NeuralScreen({ home: f.home, source: f.src });
  await ns.prepare();
  assert.ok(fs.existsSync(path.join(f.home, 'runtime', 'Lib', 'site-packages', 'cv2', 'x.pyd')));
  assert.ok(!fs.existsSync(path.join(f.home, 'NeuralScreen.log')), 'the bundle log is not copied');
  const a = fs.statSync(path.join(f.src, 'native', 'nvngx_dlssnr.dll')), b = fs.statSync(path.join(f.home, 'native', 'nvngx_dlssnr.dll'));
  assert.strictEqual(a.size, b.size);
  // user edits survive a re-prepare after an update
  fs.writeFileSync(path.join(f.home, 'config.json'), '{"profile":"Faithful","menu_offset":[1,2]}');
  fs.writeFileSync(path.join(f.src, 'main.py'), 'x:main.py v2');
  fs.utimesSync(path.join(f.src, 'main.py'), new Date(), new Date(Date.now() + 5000));
  await ns.prepare();
  assert.strictEqual(fs.readFileSync(path.join(f.home, 'main.py'), 'utf8'), 'x:main.py v2', 'code refreshed');
  assert.match(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'), /menu_offset/, 'settings kept');
});

test('config: Refract sets profile/speed and never opens the menu over a game', async () => {
  const f = fixture();
  const ns = new NeuralScreen({ home: f.home, source: f.src });
  await ns.prepare();
  const cfg = ns.writeConfig({ profile: 'Strong / Cinematic', faster: true, workScale: 5 });
  assert.strictEqual(cfg.profile, 'Strong / Cinematic');
  assert.strictEqual(cfg.nr_small, true);
  assert.strictEqual(cfg.work_scale, 1);
  assert.strictEqual(cfg.open_menu_on_start, false);
  assert.strictEqual(cfg.width, 3840, 'other NeuralScreen fields untouched');
  assert.strictEqual(ns.writeConfig({ profile: 'bogus' }).profile, 'Natural');
});

test('start spawns the bundled python with our config; stop kills the tree', async () => {
  const f = fixture();
  const calls = [], events = [], execs = [];
  const ns = new NeuralScreen({ home: f.home, source: f.src, spawn: fakeSpawn(calls), emit: (c, d) => events.push(d),
    exec: (cmd, args, o, cb) => { execs.push([cmd, ...args]); const c = calls[0].child; c.exitCode = 0; c.emit('exit', 0); cb(); } });
  await Promise.all([ns.start({ profile: 'Natural' }, 'Detroit'), ns.start({}, 'Detroit')]);
  assert.strictEqual(calls.length, 1, 'concurrent starts spawn once');
  assert.strictEqual(calls[0].file, path.join(f.home, 'runtime', 'pythonw.exe'));
  assert.deepStrictEqual(calls[0].args.slice(-2), ['--config', path.join(f.home, 'config.json')]);
  assert.strictEqual(calls[0].opts.cwd, f.home);
  assert.ok(ns.running());
  assert.strictEqual(ns.state().game, 'Detroit');
  await ns.stop();
  assert.deepStrictEqual(execs[0], ['taskkill', '/PID', '4242', '/T']);
  assert.ok(!ns.running());
  assert.ok(events.some(e => e.state === 'stopped' && e.game === 'Detroit'));
});

test('state reads only this run from the log', async () => {
  const f = fixture();
  const calls = [];
  const ns = new NeuralScreen({ home: f.home, source: f.src, spawn: fakeSpawn(calls) });
  await ns.prepare();
  fs.writeFileSync(path.join(f.home, 'NeuralScreen.log'), '[main] worker silent/dying 3 times in a row - NR OFF\n');
  await ns.start({});
  assert.strictEqual(ns.state().nr, null, 'an old failure is not this run');
  fs.appendFileSync(path.join(f.home, 'NeuralScreen.log'), '[arch] architecture 0x1B0 is supported anyway - no spoof needed\n[main] NR ON | FPS  55.3 | frames 120 | x\n');
  const st = ns.state();
  assert.strictEqual(st.fps, 55.3);
  assert.strictEqual(st.nr, 'on');
  assert.match(st.arch, /no spoof needed/);
});

test('availability: RTX 20 and GTX are refused; a damaged copy fails loudly', async () => {
  const f = fixture();
  const ns = new NeuralScreen({ home: f.home, source: f.src });
  assert.strictEqual(ns.available({ dlss5: 'patch', series: 30 }).ok, true);
  assert.strictEqual(ns.available({ dlss5: 'native', series: 50 }).ok, true);
  assert.match(ns.available({ dlss5: 'unsupported', series: 20 }).reason, /Turing/);
  assert.match(ns.available({ dlss5: 'unsupported', series: null }).reason, /RTX 30, 40 or 50/);
  // A source that lost a key file is reported, not silently started.
  fs.rmSync(path.join(f.src, 'native', 'nvngx_dlssnr.dll'));
  const broken = new NeuralScreen({ home: path.join(f.base, 'home2'), source: f.src });
  await assert.rejects(() => broken.prepare(), /damaged/i);
  assert.ok(!fs.existsSync(path.join(f.base, 'home2', 'main.py')), 'nothing is copied from a damaged source');
});
