'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../src/core/feederconfig');
const feeder = require('../src/core/feeder');
const { proxyName } = require('../src/core/peimports');

test('feederconfig writes the minimal ReShade keys the RenoDX DLSS route needs', () => {
  const ini = cfg.gameReShade('');
  assert.match(ini, /\[GENERAL\]/);
  assert.match(ini, /PresetPath=\.\\ReShadePreset\.ini/);
  assert.match(ini, /NoReloadOnInit=0/);
  const keep = cfg.gameReShade('[GENERAL]\r\nPresetPath=.\\Custom.ini\r\n');
  assert.match(keep, /PresetPath=\.\\Custom\.ini/);
});

test('proxyName maps render APIs to the right ReShade proxy DLL', () => {
  assert.strictEqual(proxyName('dxgi'), 'dxgi.dll');
  assert.strictEqual(proxyName('d3d9'), 'd3d9.dll');
  assert.strictEqual(proxyName('opengl'), 'opengl32.dll');
});

const RESHADE_ADDON_BYTES = Buffer.concat([Buffer.from('ReShade 6.8.0 '), Buffer.from('Searching for add-ons'), Buffer.alloc(32)]);
function fixturePayload(dir) {
  const P = p => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
  const reshadeDll = P(path.join(dir, 'ReShade64.dll')); fs.writeFileSync(reshadeDll, RESHADE_ADDON_BYTES);
  const addon = P(path.join(dir, 'renodx-dlss5-v2.5.addon64')); fs.writeFileSync(addon, 'RENODX');
  const d1 = P(path.join(dir, 'sl', 'nvngx_dlss.dll')); fs.writeFileSync(d1, 'PAYLOAD-DLSS');
  const d2 = P(path.join(dir, 'sl', 'nvngx_dlssnr.dll')); fs.writeFileSync(d2, 'PAYLOAD-NR');
  const d3 = P(path.join(dir, 'sl', 'sl.dlss.dll')); fs.writeFileSync(d3, 'PAYLOAD-SL');
  const nr = P(path.join(dir, 'ngx', 'nvngx_dlssnr.dll')); fs.writeFileSync(nr, 'UNIVERSAL-NR');
  return { ok: true, route: 'native', versions: { renodx5: 'test', dlssnr: 'test' }, reshadeDll, addon, addonName: 'renodx-dlss5-v2.5.addon64',
    dlls: [d1, d2, d3], nvngxDlss: d1, nvngxNrUniversal: nr };
}
// A game that already ships DLSS (so the add-on has NGX to hook).
function gameWithDlss(gameDir) {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(gameDir, 'nvngx_dlss.dll'), 'GAME-OWN-DLSS');
  fs.writeFileSync(path.join(gameDir, 'sl.dlss.dll'), 'GAME-OWN-SL');
  fs.writeFileSync(path.join(gameDir, 'keep.txt'), 'keep');
  return path.join(gameDir, 'game.exe');
}

test('a game with no DLSS is routed to the feeder, not refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-elig-'));
  const bare = path.join(base, 'bare'); fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'game.exe'), 'MZ');
  const noDlss = feeder.eligible({ exeDir: bare, bitness: 64, api: 'dxgi', dx: 12 });
  assert.strictEqual(noDlss.ok, true, 'a DLSS-less game is still supported');
  assert.strictEqual(noDlss.route, 'feeder');

  const withDlss = path.join(base, 'dlss'); gameWithDlss(withDlss);
  const hit = feeder.eligible({ exeDir: withDlss, bitness: 64, api: 'dxgi', dx: 12 });
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.route, 'native');
  assert.strictEqual(feeder.eligible({ exeDir: withDlss, bitness: 32 }).ok, false);
  fs.rmSync(base, { recursive: true, force: true });
});

// The real-world broken case: the user has a RenoDX add-on, but their ReShade is the
// LIMITED build, which logs "Searching for add-ons" and then refuses to load any.
const LIMITED_RESHADE_BYTES = Buffer.concat([
  Buffer.from('ReShade 6.8.0 '), Buffer.from('Searching for add-ons'),
  Buffer.from('because this build of ReShade has only limited add-on functionality'), Buffer.alloc(16)]);

test('a limited ReShade build is NOT mistaken for the add-on build', () => {
  const rt = require('../src/core/reshaderuntime');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-rsbuild-'));
  const limited = path.join(base, 'limited.dll'); fs.writeFileSync(limited, LIMITED_RESHADE_BYTES);
  const full = path.join(base, 'full.dll'); fs.writeFileSync(full, RESHADE_ADDON_BYTES);
  assert.strictEqual(rt.isReShade(limited), true, 'still recognised as ReShade');
  assert.strictEqual(rt.isAddonReShade(limited), false, 'limited build must not pass as add-on build');
  assert.strictEqual(rt.isAddonReShade(full), true, 'full add-on build passes');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a game with a RenoDX add-on but a limited ReShade gets ReShade upgraded, add-on kept', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-already-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'USERS-OWN');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), LIMITED_RESHADE_BYTES);

  const gate = feeder.plan(dir, { bitness: 64 });
  assert.strictEqual(gate.ok, true);
  assert.deepStrictEqual(gate.actions, ['reshade-upgrade', 'nr-runtime'], 'ReShade + the missing NR runtime');

  await feeder.install({ exe, api: 'dxgi', bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache') });
  assert.strictEqual(require('../src/core/reshaderuntime').isAddonReShade(path.join(dir, 'dxgi.dll')), true, 'ReShade upgraded to add-on build');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'utf8'), 'USERS-OWN', 'their add-on kept as-is');
  assert.ok(!fs.existsSync(path.join(dir, 'renodx-dlss5-v2.5.addon64')), 'no duplicate add-on added');

  await feeder.restore(dir);
  assert.ok(fs.readFileSync(path.join(dir, 'dxgi.dll')).includes(Buffer.from('limited add-on functionality')), 'their original ReShade restored');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'utf8'), 'USERS-OWN');
  fs.rmSync(base, { recursive: true, force: true });
});

test('competing DLSS add-ons in one folder are flagged as a conflict', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-conflict-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), RESHADE_ADDON_BYTES);
  // Mirrors a real folder: several add-ons all driving DLSS at once.
  for (const a of ['renodx-dlss.addon64', 'renodx-dlss5.addon64', 'dlss5-feed.addon64', 'DLSS5 DX11 Bridge.addon64']) {
    fs.writeFileSync(path.join(dir, a), 'X');
  }
  fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'NR');
  const gate = feeder.plan(dir, { bitness: 64 });
  assert.strictEqual(gate.inspect.conflicts.length, 4, 'all four DLSS add-ons detected');
  assert.ok(gate.warnings.length, 'a conflict warning is raised');
  assert.match(gate.warnings[0], /fight over the same NGX hooks/i);
  assert.match(gate.reason, /4 DLSS add-ons are installed/i);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a single DLSS add-on raises no conflict warning', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-noconflict-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), RESHADE_ADDON_BYTES);
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'X');
  const gate = feeder.plan(dir, { bitness: 64 });
  assert.deepStrictEqual(gate.inspect.conflicts, []);
  assert.deepStrictEqual(gate.warnings, []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a fully set-up game reports "already" and suggests enabling DLSS in-game', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-done-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'USERS-OWN');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), RESHADE_ADDON_BYTES);
  fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'NR');
  const gate = feeder.plan(dir, { bitness: 64 });
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.already, true);
  assert.match(gate.reason, /turn DLSS on in the game/i);
  fs.rmSync(base, { recursive: true, force: true });
});

test('install is additive: never overwrites the game\'s own DLSS DLLs or ReShade.ini', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-dlss5-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const gameDir = path.join(base, 'Game', 'bin');
  const exe = gameWithDlss(gameDir);
  fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), '[GENERAL]\r\nPresetPath=.\\Mine.ini\r\n');

  await feeder.install({ exe, api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache') });

  // The game's own files are untouched.
  assert.strictEqual(fs.readFileSync(path.join(gameDir, 'nvngx_dlss.dll'), 'utf8'), 'GAME-OWN-DLSS', 'game DLSS runtime preserved');
  assert.strictEqual(fs.readFileSync(path.join(gameDir, 'sl.dlss.dll'), 'utf8'), 'GAME-OWN-SL', 'game Streamline DLL preserved');
  assert.match(fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8'), /Mine\.ini/, 'existing ReShade.ini preserved');
  // Only ReShade + the add-on are added; the runtime set is left alone all-or-nothing,
  // because Streamline's interposer and plugins must stay a version-matched set.
  assert.ok(fs.existsSync(path.join(gameDir, 'dxgi.dll')), 'ReShade proxy added');
  assert.ok(fs.existsSync(path.join(gameDir, 'renodx-dlss5-v2.5.addon64')), 'RenoDX add-on added');
  assert.strictEqual(fs.readFileSync(path.join(gameDir, 'nvngx_dlssnr.dll'), 'utf8'), 'UNIVERSAL-NR', 'missing NR runtime added (the reason NR stayed off on RTX 30)');
  assert.ok(!fs.existsSync(path.join(gameDir, 'sl.dlss_nr.dll')), 'no Streamline plugin mixed into the game\'s own set');
  assert.strictEqual(feeder.status(gameDir).installed, true);

  await feeder.restore(gameDir);
  for (const f of ['dxgi.dll', 'renodx-dlss5-v2.5.addon64', 'nvngx_dlssnr.dll', 'refract-feeder.json']) {
    assert.ok(!fs.existsSync(path.join(gameDir, f)), f + ' removed on restore');
  }
  assert.strictEqual(fs.readFileSync(path.join(gameDir, 'nvngx_dlss.dll'), 'utf8'), 'GAME-OWN-DLSS', 'game DLSS intact after restore');
  assert.match(fs.readFileSync(path.join(gameDir, 'ReShade.ini'), 'utf8'), /Mine\.ini/, 'ReShade.ini intact after restore');
  assert.strictEqual(fs.readFileSync(path.join(gameDir, 'keep.txt'), 'utf8'), 'keep', 'user file untouched');
  assert.strictEqual(feeder.status(gameDir).installed, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('install keeps an existing ReShade add-on build instead of replacing it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-keepreshade-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const gameDir = path.join(base, 'g');
  const exe = gameWithDlss(gameDir);
  const theirs = Buffer.concat([RESHADE_ADDON_BYTES, Buffer.from('THEIRS')]);
  fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), theirs);

  await feeder.install({ exe, api: 'dxgi', bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache') });
  assert.ok(fs.readFileSync(path.join(gameDir, 'dxgi.dll')).includes(Buffer.from('THEIRS')), 'their ReShade add-on build kept');
  await feeder.restore(gameDir);
  assert.ok(fs.readFileSync(path.join(gameDir, 'dxgi.dll')).includes(Buffer.from('THEIRS')), 'still theirs after restore');
  fs.rmSync(base, { recursive: true, force: true });
});

test('routeFor picks the right DLSS 5 route for each kind of game', () => {
  const r = feeder.routeFor;
  assert.strictEqual(r({ api: 'dxgi', dx: 12, hasDlss: true }).route, 'native');
  assert.strictEqual(r({ api: 'dxgi', dx: 11, hasDlss: true }).route, 'native+bridge');
  assert.strictEqual(r({ api: 'dxgi', dx: 12, hasDlss: false }).route, 'feeder');
  assert.strictEqual(r({ api: 'dxgi', dx: 11, hasDlss: false }).route, 'feeder');
  // Unknown DX with DLSS falls back to native rather than adding a DX11 bridge blindly.
  assert.strictEqual(r({ api: 'dxgi', dx: null, hasDlss: true }).route, 'native');
  const vk = r({ api: 'vulkan', hasDlss: true });
  assert.strictEqual(vk.route, null);
  assert.match(vk.reason, /Vulkan/);
  const d9 = r({ api: 'd3d9', hasDlss: false });
  assert.strictEqual(d9.route, null);
});

test('a game with no DLSS routes to the feeder instead of being refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-route-'));
  const dir = path.join(base, 'g'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ');
  const gate = feeder.plan(dir, { bitness: 64, api: 'dxgi', dx: 12 });
  assert.strictEqual(gate.ok, true);
  assert.strictEqual(gate.route, 'feeder');
  assert.ok(gate.actions.includes('feeder-install'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('Vulkan and 32-bit games are explained, not silently attempted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-unsup-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  const vk = feeder.plan(dir, { bitness: 64, api: 'vulkan' });
  assert.strictEqual(vk.ok, false);
  assert.match(vk.reason, /Vulkan/);
  const x86 = feeder.plan(dir, { bitness: 32, api: 'dxgi', dx: 12 });
  assert.strictEqual(x86.ok, false);
  assert.match(x86.reason, /64-bit only/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('RTX 20/30/40 needs the unlock; RTX 50 does not; non-RTX is refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-gpu-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  const opts = { bitness: 64, api: 'dxgi', dx: 12 };
  const ampere = { name: 'NVIDIA GeForce RTX 3060', dlss5: 'patch', series: 30, arch: 'Ampere' };
  const off = feeder.plan(dir, { ...opts, gpu: ampere, unlock: { enabled: false } });
  assert.ok(off.warnings.some(w => /switched off/i.test(w)), 'warns when the user switched the runtime off');
  const on = feeder.plan(dir, { ...opts, gpu: ampere });
  assert.strictEqual(on.warnings.length, 0, 'on by default: no warning');
  assert.ok(on.actions.includes('nr-runtime'), 'RTX 30 needs the universal runtime');
  const blackwell = feeder.plan(dir, { ...opts, gpu: { name: 'NVIDIA GeForce RTX 5070', dlss5: 'native', series: 50 } });
  assert.strictEqual(blackwell.warnings.length, 0, 'RTX 50 needs no unlock');
  const gtx = feeder.plan(dir, { ...opts, gpu: { name: 'NVIDIA GeForce GTX 1080 Ti', dlss5: 'unsupported' } });
  assert.strictEqual(gtx.ok, false);
  assert.match(gtx.reason, /no DLSS hardware/i);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- neural-rendering runtime
const AMPERE = { name: 'NVIDIA GeForce RTX 3060', dlss5: 'patch', series: 30, arch: 'Ampere' };
const BLACKWELL = { name: 'NVIDIA GeForce RTX 5070', dlss5: 'native', series: 50, arch: 'Blackwell' };

test('RTX 3060 regression: a stock game with no nvngx_dlssnr.dll gets the universal runtime', async () => {
  // Exactly the brother's PC: add-on hooks DLSS, then "nvngx_dlssnr.dll was not found ... NR stays off".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-nr30-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const dir = path.join(base, 'Cyberpunk 2077', 'bin', 'x64'); const exe = gameWithDlss(dir);
  await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: AMPERE });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'utf8'), 'UNIVERSAL-NR');
  assert.strictEqual(feeder.nrNeeded(dir, { gpu: AMPERE, unlock: { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal } }), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('RTX 30 with a stock NVIDIA nvngx_dlssnr.dll gets it replaced (backed up); restore puts it back', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-nrstock-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'STOCK-SIGNED');
  assert.ok(feeder.plan(dir, { bitness: 64, gpu: AMPERE }).actions.includes('nr-runtime'));
  await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: AMPERE });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'utf8'), 'UNIVERSAL-NR');
  await feeder.restore(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'utf8'), 'STOCK-SIGNED', 'original runtime back');
  fs.rmSync(base, { recursive: true, force: true });
});

test('RTX 50 keeps whatever nvngx_dlssnr.dll already works; adds the universal one only if missing', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-nr50-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const has = path.join(base, 'has'); const exeA = gameWithDlss(has);
  fs.writeFileSync(path.join(has, 'nvngx_dlssnr.dll'), 'WORKING-ON-5070');
  assert.strictEqual(feeder.nrNeeded(has, { gpu: BLACKWELL }), false);
  await feeder.install({ exe: exeA, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: BLACKWELL });
  assert.strictEqual(fs.readFileSync(path.join(has, 'nvngx_dlssnr.dll'), 'utf8'), 'WORKING-ON-5070', 'RTX 50 setup untouched');
  const bare = path.join(base, 'bare'); const exeB = gameWithDlss(bare);
  await feeder.install({ exe: exeB, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: BLACKWELL });
  assert.strictEqual(fs.readFileSync(path.join(bare, 'nvngx_dlssnr.dll'), 'utf8'), 'UNIVERSAL-NR');
  fs.rmSync(base, { recursive: true, force: true });
});

test('switching the runtime off leaves the folder alone; a user-supplied file is used instead of the bundled one', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-nrown-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const off = path.join(base, 'off'); const exeA = gameWithDlss(off);
  assert.strictEqual(feeder.nrNeeded(off, { gpu: AMPERE, unlock: { enabled: false } }), false);
  await feeder.install({ exe: exeA, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: AMPERE, unlock: { enabled: false } });
  assert.ok(!fs.existsSync(path.join(off, 'nvngx_dlssnr.dll')));
  const own = path.join(base, 'mine', 'nvngx_dlssnr.dll'); fs.mkdirSync(path.dirname(own)); fs.writeFileSync(own, 'MY-OWN-NR');
  const mine = path.join(base, 'mine-game'); const exeB = gameWithDlss(mine);
  await feeder.install({ exe: exeB, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: AMPERE, unlock: { enabled: true, source: 'own', runtime: own } });
  assert.strictEqual(fs.readFileSync(path.join(mine, 'nvngx_dlssnr.dll'), 'utf8'), 'MY-OWN-NR');
  fs.rmSync(base, { recursive: true, force: true });
});

test('an install from an older version is repairable, and one restore undoes both runs', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-repair-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  // Simulate v0.1: ReShade + add-on + ini added, but no NR runtime.
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), RESHADE_ADDON_BYTES);
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'RENODX-4.70');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\r\nPresetPath=.\\ReShadePreset.ini\r\n');
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({ version: 4, route: 'native', exeDir: dir, replaced: [],
    added: ['dxgi.dll', 'renodx-dlss5.addon64', 'ReShade.ini'].map(n => ({ path: path.join(dir, n), kind: 'x' })) }));
  const gate = feeder.plan(dir, { bitness: 64, gpu: AMPERE });
  assert.strictEqual(gate.ok, true, 'not a dead "already set up"');
  assert.strictEqual(gate.repair, true);
  assert.deepStrictEqual(gate.actions, ['nr-runtime']);
  await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache'), gpu: AMPERE });
  assert.ok(fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll')));
  assert.match(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), /\[RenoDX\.DLSS5\][\s\S]*NRPreset=2/, 'tuned NR settings added');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'refract-feeder.json'), 'utf8'));
  assert.ok(man.added.some(e => /dxgi\.dll$/.test(e.path)) && man.added.some(e => /nvngx_dlssnr\.dll$/.test(e.path)), 'manifest merged');
  await feeder.restore(dir);
  for (const f of ['dxgi.dll', 'renodx-dlss5.addon64', 'ReShade.ini', 'nvngx_dlssnr.dll', 'refract-feeder.json']) {
    assert.ok(!fs.existsSync(path.join(dir, f)), f + ' removed');
  }
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlss.dll'), 'utf8'), 'GAME-OWN-DLSS');
  fs.rmSync(base, { recursive: true, force: true });
});

test('restore also removes the logs and preset ReShade created, but never the user\'s own new files', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-artifacts-'));
  const payload = fixturePayload(path.join(base, 'cache'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'cache') });
  for (const f of ['ReShade.log', 'ReShade.log1', 'ReShadePreset.ini', 'renodx-dlss5.log', 'savegame.dat', 'screenshot.png']) fs.writeFileSync(path.join(dir, f), 'x');
  await feeder.restore(dir);
  for (const f of ['ReShade.log', 'ReShade.log1', 'ReShadePreset.ini', 'renodx-dlss5.log']) assert.ok(!fs.existsSync(path.join(dir, f)), f + ' removed');
  for (const f of ['savegame.dat', 'screenshot.png', 'keep.txt']) assert.ok(fs.existsSync(path.join(dir, f)), f + ' kept');
  fs.rmSync(base, { recursive: true, force: true });
});

test('dlss5ReShade: fresh config is tuned; a user\'s own NR tuning is never overwritten', () => {
  const fresh = cfg.dlss5ReShade('');
  assert.match(fresh, /\[RenoDX\.DLSS5\][\s\S]*EnableHooks=2[\s\S]*NRPreset=2[\s\S]*NRStyle=1/);
  assert.match(fresh, /DisabledAddons=Generic Depth,Effect Runtime Sync/);
  assert.match(fresh, /KeyOverlay=36,0,0,0/);
  const mine = cfg.dlss5ReShade('[RenoDX.DLSS5]\r\nNRIntensity=2\r\nNRStyle=2\r\n[ADDON]\r\nDisabledAddons=renodx-dlss5,Generic Depth\r\n');
  assert.match(mine, /NRStyle=2/, 'user value kept');
  assert.doesNotMatch(mine, /NRPreset=2/, 'no tuned block forced into a tuned config');
  assert.match(mine, /DisabledAddons=Generic Depth\r\n/, 'our add-on can no longer be disabled');
});

test('looks: ReShade installed for looks is the add-on build and is fully removed by removeAll', async () => {
  const reshade = require('../src/core/reshade');
  const bundle = require('../src/core/bundle');
  const rt = require('../src/core/reshaderuntime');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-looksrt-'));
  const pay = path.join(base, 'payload'); fs.mkdirSync(path.join(pay, 'reshade'), { recursive: true });
  fs.writeFileSync(path.join(pay, 'reshade', 'ReShade64.dll'), RESHADE_ADDON_BYTES);
  fs.writeFileSync(path.join(pay, 'manifest.json'), JSON.stringify({ files: { 'reshade/ReShade64.dll': bundle.sha256File(path.join(pay, 'reshade', 'ReShade64.dll')) } }));
  process.env.REFRACT_PAYLOAD = pay; bundle._reset();
  try {
    const dir = path.join(base, 'g'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
    const r = await reshade.ensureRuntime(dir, { api: 'dxgi', bitness: 64, cacheRoot: base });
    assert.strictEqual(r.installed, true);
    assert.strictEqual(rt.isAddonReShade(path.join(dir, 'dxgi.dll')), true, 'add-on build, so DLSS 5 add-ons still load');
    await reshade.install(r.iniPath, {});
    fs.writeFileSync(path.join(dir, 'ReShade.log'), 'log');
    assert.strictEqual(reshade.touched(dir), true);
    await reshade.removeAll(dir, r.iniPath);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['keep.txt'], 'folder back to exactly the user\'s files');
  } finally { delete process.env.REFRACT_PAYLOAD; bundle._reset(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('bundle.js refuses a bundled file whose hash does not match the manifest', () => {
  const bundle = require('../src/core/bundle');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-bundle-'));
  fs.mkdirSync(path.join(base, 'ngx'));
  fs.writeFileSync(path.join(base, 'ngx', 'nvngx_dlssnr.dll'), 'tampered');
  fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ files: { 'ngx/nvngx_dlssnr.dll': '0'.repeat(64) } }));
  process.env.REFRACT_PAYLOAD = base; bundle._reset();
  try { assert.strictEqual(bundle.file('ngx/nvngx_dlssnr.dll'), null); }
  finally { delete process.env.REFRACT_PAYLOAD; bundle._reset(); fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- runtime generations
test('GPU tiers follow what the runtimes can actually run: RTX 30/40/50 yes, RTX 20 no', () => {
  const nvidia = require('../src/core/nvidia');
  const tier = n => nvidia.parseInfo(`NVIDIA GeForce ${n}, 616.92, 200, 250, 12288`);
  assert.strictEqual(tier('RTX 5070').dlss5, 'native');
  assert.strictEqual(tier('RTX 4070').dlss5, 'patch');
  assert.strictEqual(tier('RTX 3060').dlss5, 'patch');
  const turing = tier('RTX 2080 Ti');
  assert.strictEqual(turing.dlss5, 'unsupported');
  assert.match(turing.dlss5Note, /Turing/);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-tu-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  const p = feeder.plan(dir, { bitness: 64, api: 'dxgi', dx: 12, gpu: { ...turing, name: 'NVIDIA GeForce RTX 2080 Ti' } });
  assert.strictEqual(p.ok, false);
  assert.match(p.reason, /Turing/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the bundled runtime is the universal build, and 0.2\'s Ada-only build is repaired on RTX 30/40', () => {
  const assets = require('../src/core/dlss5assets');
  assert.strictEqual(assets.UNIVERSAL_NR_SHA256, 'dcc0dc2414aedec4a8e084647070383be068554042587180c20c784d4772d36f');
  assert.notStrictEqual(assets.LEGACY_NR_SHA256, assets.UNIVERSAL_NR_SHA256);
  assert.strictEqual(assets.NR_REL, 'neuralscreen/native/nvngx_dlssnr.dll');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-legacy-'));
  const dir = path.join(base, 'g'); gameWithDlss(dir);
  fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'ADA-ONLY-0.2'); // any build that isn't the universal one
  const ada = { name: 'NVIDIA GeForce RTX 4070', dlss5: 'patch', series: 40, arch: 'Ada Lovelace' };
  assert.strictEqual(feeder.nrNeeded(dir, { gpu: AMPERE }), true, 'RTX 30 gets the universal build');
  assert.strictEqual(feeder.nrNeeded(dir, { gpu: ada }), true, 'RTX 40 gets it too');
  assert.strictEqual(feeder.nrNeeded(dir, { gpu: BLACKWELL }), false, 'RTX 50 keeps what already works');
  fs.rmSync(base, { recursive: true, force: true });
});
