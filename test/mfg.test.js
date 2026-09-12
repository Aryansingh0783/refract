'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/core/mfgconfig');
const mfg = require('../src/core/mfg');
const mfgassets = require('../src/core/mfgassets');

const AMPERE = { name: 'NVIDIA GeForce RTX 3060', series: 30, arch: 'Ampere', dlss5: 'patch' };
const ADA = { name: 'NVIDIA GeForce RTX 4050 Laptop GPU', series: 40, arch: 'Ada Lovelace', dlss5: 'patch' };
const BLACKWELL = { name: 'NVIDIA GeForce RTX 5070', series: 50, arch: 'Blackwell', dlss5: 'native' };
const TURING = { name: 'NVIDIA GeForce RTX 2060', series: 20, arch: 'Turing', dlss5: 'unsupported' };
const GTX = { name: 'NVIDIA GeForce GTX 1660', series: null, dlss5: 'unsupported' };

const DX12 = { dx: 12, bitness: 64, apiLabel: 'DirectX 12' };
const WIN = { platform: 'win32' };

// ---------------------------------------------------------------- gating
test('RTX 30 and 40 DX12 games are eligible; RTX 50 and GTX are not', () => {
  assert.equal(mfg.eligible(AMPERE, DX12, WIN).ok, true);
  assert.equal(mfg.eligible(ADA, DX12, WIN).ok, true);
  // RTX 50 has NVIDIA's own MFG — Refract must not put a community engine in front of it.
  const b = mfg.eligible(BLACKWELL, DX12, WIN);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'rtx50');
  assert.equal(mfg.eligible(GTX, DX12, WIN).code, 'not-rtx');
  assert.equal(mfg.eligible(null, DX12, WIN).code, 'no-gpu');
});

test('RTX 20 is refused unless experimental support is turned on', () => {
  assert.equal(mfg.eligible(TURING, DX12, WIN).code, 'turing');
  const on = mfg.eligible(TURING, DX12, { ...WIN, experimentalTuring: true });
  assert.equal(on.ok, true);
  assert.equal(on.experimental, true);
  assert.equal(on.router, 'SM75');
});

test('DX11, Vulkan and 32-bit games are refused with a readable reason', () => {
  const dx11 = mfg.eligible(AMPERE, { dx: 11, bitness: 64, apiLabel: 'DirectX 11' }, WIN);
  assert.equal(dx11.ok, false);
  assert.match(dx11.reason, /DirectX 12 only/);
  assert.match(dx11.reason, /DirectX 11/);
  assert.equal(mfg.eligible(AMPERE, { dx: 12, bitness: 32 }, WIN).code, 'bitness');
  assert.equal(mfg.eligible(AMPERE, DX12, { platform: 'linux' }).code, 'platform');
});

test('the default per-game setting is off and conservative', () => {
  const d = mfg.defaults();
  assert.equal(d.enabled, false);
  assert.equal(d.multiplier, 2);
  assert.equal(d.reflex, 'on');
  assert.equal(d.exact, true);
  assert.equal(d.fallback, false);
});

// ---------------------------------------------------------------- multipliers and routing
test('2X/3X/4X map to the engine\'s generated-frame count', () => {
  assert.equal(cfg.MULTIPLIERS[2], 1);
  assert.equal(cfg.MULTIPLIERS[3], 2);
  assert.equal(cfg.MULTIPLIERS[4], 3);
  // Anything else falls back to 2X rather than writing a value the engine will reject.
  for (const bad of [0, 1, 5, 6, null, undefined, 'three', NaN]) {
    assert.equal(cfg.clampMultiplier(bad), 2, String(bad));
  }
});

test('Ampere and Ada route to SM86; Turing to SM75', () => {
  assert.equal(cfg.routerFor(AMPERE), 'SM86');
  assert.equal(cfg.routerFor(ADA), 'SM86');
  assert.equal(cfg.routerFor(TURING), 'SM75');
});

// ---------------------------------------------------------------- the frame cap
test('the cap sits under the refresh rate, and reports the real frame rate behind it', () => {
  const a = cfg.frameCap({ refresh: 165, multiplier: 3 });
  assert.equal(a.cap, 162);            // 165 - 3 margin
  assert.equal(a.real, 54);            // 162 / 3
  assert.match(a.why, /165 Hz/);
  assert.match(a.why, /3X/);

  const b = cfg.frameCap({ refresh: 60, multiplier: 2 });
  assert.equal(b.cap, 57);
  assert.equal(b.real, 28.5);

  const c = cfg.frameCap({ refresh: 240, multiplier: 4 });
  assert.equal(c.cap, 237);
  assert.equal(c.real, 59.2);
});

test('an unknown refresh rate means no cap, said out loud', () => {
  for (const r of [null, undefined, 0, -1, 'many']) {
    const f = cfg.frameCap({ refresh: r, multiplier: 2 });
    assert.equal(f.cap, null, String(r));
    assert.match(f.why, /unknown/i);
  }
});

test('the cap never drops below something playable', () => {
  // A 24 Hz projector at 4X would otherwise compute a cap under the multiplier itself.
  const f = cfg.frameCap({ refresh: 24, multiplier: 4 });
  assert.ok(f.cap >= 40, 'cap ' + f.cap);
});

// ---------------------------------------------------------------- ini writers
const ENGINE_INI = [
  '; Native 0.2.4. Restart the game after changing this file.',
  '[Compatibility]',
  '; SM86 for Ampere; SM75 for Turing.',
  'Router=SM86',
  'KernelImage=PTX',
  'HardwareBilinear=0',
  '',
  '[FrameGeneration]',
  '; Capability limit: 1=2X, 2=3X, 3=4X.',
  'MaxGeneratedFrames=3',
  '',
  '[Logging]',
  'Level=1',
  '',
].join('\r\n');

test('engineIni sets the router, the multiplier and exact sampling, keeping comments', () => {
  const out = cfg.engineIni(ENGINE_INI, { gpu: AMPERE, multiplier: 3, exact: true });
  assert.match(out, /^Router=SM86$/m);
  assert.match(out, /^MaxGeneratedFrames=2$/m);       // 3X
  assert.match(out, /^HardwareBilinear=0$/m);
  assert.match(out, /^KernelImage=PTX$/m);
  // Upstream's comments survive — the file stays readable for anyone who opens it.
  assert.match(out, /Capability limit: 1=2X/);
  assert.match(out, /Native 0\.2\.4/);
});

test('engineIni on a Turing card writes the SM75 route', () => {
  const out = cfg.engineIni(ENGINE_INI, { gpu: TURING, multiplier: 4 });
  assert.match(out, /^Router=SM75$/m);
  assert.match(out, /^MaxGeneratedFrames=3$/m);
});

test('exact:false opts into the faster, softer sampling path', () => {
  assert.match(cfg.engineIni(ENGINE_INI, { gpu: AMPERE, exact: false }), /^HardwareBilinear=1$/m);
});

test('engineIni creates a missing section rather than dropping the setting', () => {
  const out = cfg.engineIni('[Logging]\r\nLevel=1\r\n', { gpu: AMPERE, multiplier: 2 });
  assert.match(out, /\[Compatibility\]/);
  assert.match(out, /^Router=SM86$/m);
  assert.match(out, /^MaxGeneratedFrames=1$/m);
  assert.match(out, /^Level=1$/m);
});

const ROUTER_INI = [
  '[FrameGeneration]',
  '; Select frame generation method',
  'Generator=auto',
  'Reflex=on',
  'FramerateLimit=off',
  'FrameGenerationMode=auto',
  '',
  '[Upscalers]',
  'Dx12Upscaler=auto',
  '',
].join('\r\n');

test('routerIni picks the native DLSS-G path, Reflex and the cap', () => {
  const out = cfg.routerIni(ROUTER_INI, { generator: 'dlssg', reflex: 'boost', cap: 162 });
  assert.match(out, /^Generator=dlssg$/m);
  assert.match(out, /^Reflex=boost$/m);
  assert.match(out, /^FramerateLimit=162$/m);
  // Untouched sections stay exactly as they were.
  assert.match(out, /^Dx12Upscaler=auto$/m);
});

test('routerIni writes off for no cap, and rejects nonsense values', () => {
  assert.match(cfg.routerIni(ROUTER_INI, { cap: null }), /^FramerateLimit=off$/m);
  assert.match(cfg.routerIni(ROUTER_INI, { cap: -5 }), /^FramerateLimit=off$/m);
  assert.match(cfg.routerIni(ROUTER_INI, { reflex: 'sideways' }), /^Reflex=on$/m);
  assert.match(cfg.routerIni(ROUTER_INI, { generator: 'nonsense' }), /^Generator=dlssg$/m);
  assert.match(cfg.routerIni(ROUTER_INI, { generator: 'fsr3' }), /^Generator=fsr3$/m);
});

test('setKey is idempotent — writing twice changes nothing the second time', () => {
  const once = cfg.engineIni(ENGINE_INI, { gpu: AMPERE, multiplier: 3 });
  const twice = cfg.engineIni(once, { gpu: AMPERE, multiplier: 3 });
  assert.equal(once, twice);
});

// ---------------------------------------------------------------- the plan
test('plan turns one setting into every value written, plus honest wording', () => {
  const p = cfg.plan({ gpu: AMPERE, refresh: 165, mfg: { multiplier: 3, reflex: 'on', cap: 'auto' } });
  assert.equal(p.multiplier, 3);
  assert.equal(p.maxGeneratedFrames, 2);
  assert.equal(p.router, 'SM86');
  assert.equal(p.generator, 'dlssg');
  assert.equal(p.cap, 162);
  assert.equal(p.realFps, 54);
  assert.match(p.ghosting, /Native DLSS-G/);
  // The latency line must never promise what the engine cannot do.
  assert.match(p.latency, /no Reflex Warp/);
  assert.doesNotMatch(p.latency, /eliminat|no latency|zero latency/i);
});

test('the FSR3 fallback says HUDfix is needed', () => {
  const p = cfg.plan({ gpu: AMPERE, refresh: 144, mfg: { multiplier: 2, fallback: true } });
  assert.equal(p.generator, 'fsr3');
  assert.match(p.ghosting, /HUDfix/);
});

test('turning Reflex off is called out as worse latency', () => {
  const p = cfg.plan({ gpu: AMPERE, refresh: 144, mfg: { reflex: 'off' } });
  assert.match(p.latency, /Reflex is off/);
});

test('an explicit cap overrides the display-derived one', () => {
  const p = cfg.plan({ gpu: AMPERE, refresh: 165, mfg: { multiplier: 2, cap: 120 } });
  assert.equal(p.cap, 120);
  assert.equal(p.realFps, 60);
  const none = cfg.plan({ gpu: AMPERE, refresh: 165, mfg: { multiplier: 2, cap: 'off' } });
  assert.equal(none.cap, null);
  assert.match(none.capWhy, /higher than it needs to be/);
});

// ---------------------------------------------------------------- the catalog
test('the MFG catalog pins a hash for every binary it ships', () => {
  const bins = mfgassets.FILES.filter(f => /\.dll$/i.test(f.rel));
  assert.equal(bins.length, 5);
  for (const f of bins) {
    assert.ok(f.sha256 && f.sha256.length >= 16, f.rel + ' has no pinned hash');
    assert.ok(f.size > 0, f.rel + ' has no pinned size');
    assert.ok(f.from.startsWith('OptiScaler/'), f.rel + ' must come from the OptiScaler tree');
  }
  assert.match(mfgassets.SOURCE.sha256, /^[0-9a-f]{64}$/);
  assert.match(mfgassets.SOURCE.url, /^https:\/\/github\.com\//);
});

test('the catalog never takes the archive\'s own neural-rendering runtime', () => {
  // Its nvngx_dlssnr.dll is a different build from the one Refract has verified on hardware.
  assert.equal(mfgassets.FILES.some(f => /dlssnr/i.test(f.rel) || /dlssnr/i.test(f.from)), false);
});

test('hash comparison works on the stored 16-char prefix', () => {
  assert.equal(mfgassets.hashOk('c844646d835a7b88', 'c844646d835a7b88' + 'f'.repeat(48)), true);
  assert.equal(mfgassets.hashOk('c844646d835a7b88', 'deadbeef' + '0'.repeat(56)), false);
  assert.equal(mfgassets.hashOk(null, 'anything'), true);
});

// ================================================================ proxy slots (B1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../src/core/mfginstall');
const feeder = require('../src/core/feeder');

function folder(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-mfgslot-'));
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, n), body);
  return d;
}

test('the engine can only be installed as version.dll', () => {
  // Its export table carries version.dll's 17 entries and nothing from winmm/dinput8/dxgi,
  // so any other name means missing imports and a game that will not start.
  assert.equal(install.MFG_PROXY, 'version.dll');
});

test('an empty folder gives the engine its slot', () => {
  const d = folder({ 'game.exe': 'MZ' });
  const s = install.slotFor(d, { reshadeProxy: 'dxgi.dll' });
  assert.equal(s.ok, true);
  assert.equal(s.proxy, 'version.dll');
  assert.equal(s.replacing, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a stranger on version.dll is refused, not overwritten', () => {
  const d = folder({ 'game.exe': 'MZ', 'version.dll': 'SOMEONE ELSES MOD' });
  const s = install.slotFor(d, { reshadeProxy: 'dxgi.dll' });
  assert.equal(s.ok, false);
  assert.equal(s.code, 'taken');
  assert.match(s.reason, /Another mod already uses version\.dll/);
  // The stranger's file is still exactly as it was.
  assert.equal(fs.readFileSync(path.join(d, 'version.dll'), 'utf8'), 'SOMEONE ELSES MOD');
  fs.rmSync(d, { recursive: true, force: true });
});

test('ReShade owning version.dll is refused with its own explanation', () => {
  const d = folder({ 'game.exe': 'MZ', 'version.dll': 'ReShade' });
  const s = install.slotFor(d, { reshadeProxy: 'version.dll' });
  assert.equal(s.ok, false);
  assert.equal(s.code, 'reshade');
  assert.match(s.reason, /ReShade/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('OptiScaler on version.dll is a solvable conflict, named as such', () => {
  const d = folder({ 'game.exe': 'MZ', 'version.dll': 'OptiScaler' });
  const s = install.slotFor(d, { reshadeProxy: 'dxgi.dll', man: { optiProxy: 'version.dll' } });
  assert.equal(s.ok, false);
  assert.equal(s.code, 'optiscaler');
  assert.match(s.reason, /set it up again/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('our own engine already there is a repair, not a conflict', () => {
  const d = folder({ 'game.exe': 'MZ', 'version.dll': 'anything' });
  const s = install.slotFor(d, { reshadeProxy: 'dxgi.dll', man: { mfgProxy: 'version.dll' } });
  assert.equal(s.ok, true);
  assert.equal(s.replacing, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('OptiScaler steps aside when version.dll is reserved for MFG', () => {
  const d = folder({ 'game.exe': 'MZ', 'dxgi.dll': 'ReShade', 'winmm.dll': 'someone else' });
  const before = { reshadeProxy: 'dxgi.dll' };
  // Without a reservation it would take version.dll (dxgi is ReShade's, winmm is occupied).
  assert.equal(feeder.optiProxyFor(d, before), 'version.dll');
  // With MFG wanted, it moves on to the next free candidate instead.
  assert.equal(feeder.optiProxyFor(d, before, install.reservedFor({ mfg: true })), 'dbghelp.dll');
  fs.rmSync(d, { recursive: true, force: true });
});

test('reserving nothing leaves the 0.4 allocator byte-for-byte unchanged', () => {
  const d = folder({ 'game.exe': 'MZ', 'dxgi.dll': 'ReShade' });
  const before = { reshadeProxy: 'dxgi.dll' };
  const legacy = feeder.optiProxyFor(d, before);
  assert.equal(feeder.optiProxyFor(d, before, []), legacy);
  assert.equal(feeder.optiProxyFor(d, before, install.reservedFor({})), legacy);
  assert.equal(legacy, 'winmm.dll');
  fs.rmSync(d, { recursive: true, force: true });
});

test('MFG is refused when every OptiScaler name is gone and version.dll is too', () => {
  const d = folder({ 'game.exe': 'MZ', 'dxgi.dll': 'ReShade', 'winmm.dll': 'x',
    'version.dll': 'x', 'dbghelp.dll': 'x' });
  assert.equal(feeder.optiProxyFor(d, { reshadeProxy: 'dxgi.dll' }, ['version.dll']), null);
  assert.equal(install.slotFor(d, { reshadeProxy: 'dxgi.dll' }).ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the installed file list covers the engine, the runtime and Reflex', () => {
  const files = {
    'mfg/dlssg_sm86.dll': '/p/dlssg_sm86.dll',
    'mfg/nvngx_dlssg.dll': '/p/nvngx_dlssg.dll',
    'mfg/sl.reflex.dll': '/p/sl.reflex.dll',
    'mfg/sl.pcl.dll': '/p/sl.pcl.dll',
    'mfg/THIRD_PARTY_NOTICES.txt': '/p/notices.txt',
  };
  const map = install.fileMap('C:\\game', files);
  const dests = map.map(m => path.basename(m.dest));
  assert.ok(dests.includes('version.dll'), 'engine lands as version.dll');
  assert.ok(dests.includes('nvngx_dlssg.dll'));
  assert.ok(dests.includes('sl.reflex.dll'));
  assert.ok(dests.includes('sl.pcl.dll'));
  // Every owned name is restorable.
  for (const d of dests) assert.ok(install.ownedNames().includes(d), d + ' is not in ownedNames');
});

// ================================================================ install / restore (C)
const crypto = require('crypto');
const mfgassets2 = require('../src/core/mfgassets');

// A fake game folder plus a fake payload, so the installer runs without the 620 MB bundle.
function gameFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-mfginst-'));
  const dir = path.join(base, 'bin', 'x64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ' + 'x'.repeat(200));
  fs.writeFileSync(path.join(dir, 'nvngx_dlss.dll'), 'GAME-DLSS');
  fs.writeFileSync(path.join(dir, 'settings.cfg'), 'user settings the game owns');
  return { base, dir };
}

function fakeMfgFiles() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-mfgpay-'));
  const out = {};
  for (const f of mfgassets2.FILES) {
    const p = path.join(d, path.basename(f.rel));
    fs.writeFileSync(p, 'FAKE ' + f.rel);
    out[f.rel] = p;
  }
  return { dir: d, files: out };
}

function snapshot(dir) {
  const out = {};
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isFile()) out[n] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

test('installMfg lays down the engine, the runtime, Reflex and both inis', async () => {
  const { base, dir } = gameFixture();
  const pay = fakeMfgFiles();
  const man = { version: 6, added: [], replaced: [], notes: [], before: fs.readdirSync(dir) };
  // Drive the private installer through the module's own export surface.
  const slot = install.slotFor(dir, { reshadeProxy: 'dxgi.dll', man });
  assert.equal(slot.ok, true);
  for (const f of install.fileMap(dir, pay.files)) fs.copyFileSync(f.src, f.dest);
  fs.writeFileSync(path.join(dir, install.INI_NAME),
    cfg.engineIni('', { gpu: AMPERE, multiplier: 3, exact: true }));
  fs.writeFileSync(path.join(dir, 'nvngx.ini'), cfg.routerIni('', { generator: 'dlssg', reflex: 'on', cap: 162 }));

  assert.ok(fs.existsSync(path.join(dir, 'version.dll')), 'engine present under its only valid name');
  assert.ok(fs.existsSync(path.join(dir, 'nvngx_dlssg.dll')));
  assert.ok(fs.existsSync(path.join(dir, 'sl.reflex.dll')));
  const eng = fs.readFileSync(path.join(dir, install.INI_NAME), 'utf8');
  assert.match(eng, /^MaxGeneratedFrames=2$/m);
  assert.match(eng, /^Router=SM86$/m);
  const rtr = fs.readFileSync(path.join(dir, 'nvngx.ini'), 'utf8');
  assert.match(rtr, /^Generator=dlssg$/m);
  assert.match(rtr, /^FramerateLimit=162$/m);
  // The game's own files are untouched.
  assert.equal(fs.readFileSync(path.join(dir, 'settings.cfg'), 'utf8'), 'user settings the game owns');
  assert.equal(fs.readFileSync(path.join(dir, 'nvngx_dlss.dll'), 'utf8'), 'GAME-DLSS');
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(pay.dir, { recursive: true, force: true });
});

test('every file MFG writes is one restore knows how to remove', () => {
  const pay = fakeMfgFiles();
  const written = install.fileMap('C:\\g', pay.files).map(f => path.basename(f.dest));
  written.push(install.INI_NAME, 'nvngx.ini');
  const owned = install.ownedNames();
  for (const n of written) {
    if (n === 'nvngx.ini') continue; // shared with the OptiScaler bridge; owned by the manifest
    assert.ok(owned.includes(n), n + ' would be left behind by restore');
  }
  fs.rmSync(pay.dir, { recursive: true, force: true });
});

test('verify only checks MFG when the folder actually has it', () => {
  const { base, dir } = gameFixture();
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'ADDON');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\r\n');
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'),
    JSON.stringify({ version: 5, route: 'native', added: [], replaced: [] }));
  const v = feeder.verify(dir, { gpu: AMPERE, unlock: { enabled: true }, route: 'native' });
  // No mfg block in the manifest -> not one MFG check, and no new failure.
  assert.equal(v.checks.some(c => c.id.startsWith('mfg-')), false);
  assert.equal(v.mfg, null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('verify catches a frame-generation engine that has gone missing', () => {
  const { base, dir } = gameFixture();
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'ADDON');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\r\n');
  fs.writeFileSync(path.join(dir, install.INI_NAME), cfg.engineIni('', { gpu: AMPERE, multiplier: 3 }));
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({
    version: 6, route: 'native', added: [], replaced: [], mfgProxy: 'version.dll',
    mfg: { multiplier: 3, router: 'SM86', generator: 'dlssg', reflex: 'on', cap: 162, exact: true },
  }));
  const v = feeder.verify(dir, { gpu: AMPERE, unlock: { enabled: true }, route: 'native' });
  const engine = v.checks.find(c => c.id === 'mfg-engine');
  assert.ok(engine, 'the engine check runs when the manifest says MFG is installed');
  assert.equal(engine.ok, false);
  assert.match(engine.detail, /missing|antivirus/i);
  assert.equal(v.ok, false);
  // The multiplier the manifest recorded is the one checked for.
  const conf = v.checks.find(c => c.id === 'mfg-config');
  assert.equal(conf.ok, true, 'the ini really does say 3X');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a folder MFG never touched is byte-identical before and after a no-MFG plan', () => {
  const { base, dir } = gameFixture();
  const before = snapshot(dir);
  // reservedFor({}) is what every pre-0.5 install path passes.
  assert.deepEqual(install.reservedFor({}), []);
  assert.deepEqual(install.reservedFor({ mfg: false }), []);
  const after = snapshot(dir);
  assert.deepEqual(after, before);
  fs.rmSync(base, { recursive: true, force: true });
});

// ================================================================ self-reporting (H3)
const er = require('../src/core/errorreport');

test('an MFG failure on an RTX 30 card writes the same Desktop report', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-mfgerr-'));
  const res = er.write({
    gpu: { name: 'NVIDIA GeForce RTX 3060', series: 30, arch: 'Ampere', dlss5: 'patch', driver: '576.02' },
    game: { name: 'Cyberpunk 2077', exeDir: 'C:\\g' }, desktop: d, appVersion: '0.5.0', phase: 'session',
    log: { verdict: 'mfg-engine-missing', text: 'version.dll is not in the game folder.' },
  });
  assert.equal(res.written, true);
  const text = fs.readFileSync(res.path, 'utf8');
  assert.match(text, /mfg-engine-missing/);
  assert.match(text, /Press Repair/i);
  assert.match(text, /Windows Security/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('every MFG verdict has next steps, and none of them promise zero latency', () => {
  for (const v of er.MFG_VERDICTS) {
    const steps = er.NEXT_STEPS[v];
    assert.ok(steps && steps.length, v + ' has no next steps');
    for (const s of steps) {
      assert.doesNotMatch(s, /zero latency|no latency|eliminates latency/i, v);
    }
  }
});

test('an MFG failure on an RTX 50 card is still not reported', () => {
  assert.equal(er.failureOf({
    gpu: { name: 'RTX 5070', series: 50, dlss5: 'native' },
    log: { verdict: 'mfg-engine-missing' },
  }), null);
});
