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
  const sr = P(path.join(dir, 'ngx', 'nvngx_dlss.dll')); fs.writeFileSync(sr, 'REFRACT-DLSS-310.8');
  return { ok: true, route: 'native', versions: { renodx5: 'test', dlssnr: 'test' }, reshadeDll, addon, addonName: 'renodx-dlss5-v2.5.addon64',
    dlls: [d1, d2, d3], nvngxDlss: d1, nvngxNrUniversal: nr, nvngxDlssSr: sr };
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
  // The two RenoDX builds are the real fight; feed and the DX11 bridge are legitimate company.
  assert.deepStrictEqual(gate.inspect.conflicts.sort(), ['renodx-dlss.addon64', 'renodx-dlss5.addon64']);
  assert.ok(gate.warnings.length, 'a conflict warning is raised');
  assert.match(gate.warnings[0], /fight over the same NGX hooks/i);
  assert.match(gate.reason, /2 other DLSS add-ons are installed/i);
  // A stranger add-on that also drives DLSS counts too.
  fs.writeFileSync(path.join(dir, 'someones-dlss-thing.addon64'), 'X');
  assert.ok(feeder.plan(dir, { bitness: 64 }).inspect.conflicts.includes('someones-dlss-thing.addon64'));
  // The intended feeder pairing on its own is not a conflict.
  const solo = path.join(base, 'solo'); gameWithDlss(solo);
  fs.writeFileSync(path.join(solo, 'dxgi.dll'), RESHADE_ADDON_BYTES);
  for (const a of ['renodx-dlss5.addon64', 'dlss5-feed.addon64']) fs.writeFileSync(path.join(solo, a), 'X');
  assert.deepStrictEqual(feeder.plan(solo, { bitness: 64 }).inspect.conflicts, []);
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

// ---------------------------------------------------------------- install verification (0.4)
// The RTX 3060 case: everything installed except the runtime, and the app said "already set up".
function installedGame(dir, { nr = null, addon = 'renodx-dlss5.addon64', reshade = true, ini = '[GENERAL]\r\n' } = {}) {
  gameWithDlss(dir);
  if (reshade) fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
  if (addon) fs.writeFileSync(path.join(dir, addon), 'ADDON');
  if (ini != null) fs.writeFileSync(path.join(dir, 'ReShade.ini'), ini);
  if (nr) fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), nr);
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({ version: 5, route: 'native', added: [], replaced: [], notes: [] }));
  return dir;
}

test('a game missing the runtime is never reported as "already set up"', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-verify-'));
  const opts = { bitness: 64, api: 'dxgi', dx: 12 };
  // runtime switched off: 0.3 said "already set up" with a warning underneath. It is not set up.
  const off = installedGame(path.join(base, 'off'));
  const p = feeder.plan(off, { ...opts, gpu: AMPERE, unlock: { enabled: false } });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.already, true);
  assert.strictEqual(p.blocked, 'off');
  assert.match(p.reason, /neural rendering is off/i);
  assert.doesNotMatch(p.reason, /already set up/i);
  // runtime simply missing, unlock on: offered as a repair
  const missing = installedGame(path.join(base, 'missing'));
  const q = feeder.plan(missing, { ...opts, gpu: AMPERE, unlock: { enabled: true } });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.repair, true);
  assert.deepStrictEqual(q.actions, ['nr-runtime']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('verify() names exactly what is missing, per route', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-verify2-'));
  const opts = { gpu: BLACKWELL, unlock: { enabled: true } };
  const good = installedGame(path.join(base, 'good'), { nr: 'UNIVERSAL-NR' });
  const v1 = feeder.verify(good, { ...opts, route: 'native' });
  assert.strictEqual(v1.checks.find(c => c.id === 'runtime').ok, true, 'an existing runtime is kept on RTX 50');
  assert.strictEqual(v1.checks.find(c => c.id === 'reshade').ok, true);
  assert.strictEqual(v1.ok, true);

  const noNr = installedGame(path.join(base, 'nonr'));
  const v2 = feeder.verify(noNr, { ...opts, route: 'native' });
  assert.strictEqual(v2.ok, false);
  assert.strictEqual(v2.failed[0].id, 'runtime');
  assert.match(v2.summary, /Not in the game folder/);

  const limited = installedGame(path.join(base, 'limited'), { nr: 'UNIVERSAL-NR' });
  fs.writeFileSync(path.join(limited, 'dxgi.dll'), 'ReShade 6.8.0 only limited add-on functionality');
  const v3 = feeder.verify(limited, { ...opts, route: 'native' });
  assert.strictEqual(v3.checks.find(c => c.id === 'reshade').ok, false);
  assert.match(v3.checks.find(c => c.id === 'reshade').detail, /without add-on support/);

  const disabled = installedGame(path.join(base, 'disabled'), { nr: 'UNIVERSAL-NR', ini: '[ADDON]\r\nDisabledAddons=renodx-dlss5.addon64\r\n' });
  const v4 = feeder.verify(disabled, { ...opts, route: 'native' });
  assert.strictEqual(v4.checks.find(c => c.id === 'config').ok, false);

  const noAddon = installedGame(path.join(base, 'noaddon'), { nr: 'UNIVERSAL-NR', addon: null });
  assert.strictEqual(feeder.verify(noAddon, { ...opts, route: 'native' }).checks.find(c => c.id === 'addon').ok, false);
  assert.strictEqual(feeder.verify(noAddon, { ...opts, route: 'feeder' }).checks.find(c => c.id === 'addon').label, 'DLSS 5 Feeder add-on');
  fs.rmSync(base, { recursive: true, force: true });
});

test('nrState explains the RTX 30 cases in words a user can act on', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-nrstate-'));
  const dir = installedGame(path.join(base, 'g'));
  const legacy = require('../src/core/dlss5assets').LEGACY_NR_SHA256;
  assert.match(feeder.nrState(dir, { gpu: AMPERE, unlock: { enabled: true } }).detail, /Not in the game folder/);
  assert.strictEqual(feeder.nrState(dir, { gpu: AMPERE, unlock: { enabled: false } }).why, 'off');
  assert.strictEqual(feeder.nrState(dir, { gpu: { dlss5: 'unsupported', series: 20 } }).needed, false);
  fs.writeFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'UNIVERSAL-NR');
  // The real universal build is identified by hash; a stranger's build is refused on RTX 30.
  assert.strictEqual(feeder.nrState(dir, { gpu: AMPERE, unlock: { enabled: true } }).why, 'wrong-build');
  assert.strictEqual(feeder.nrState(dir, { gpu: BLACKWELL, unlock: { enabled: true } }).ok, true, 'RTX 50 runs what the game already has');
  assert.strictEqual(feeder.nrState(dir, { gpu: AMPERE, unlock: { enabled: true, source: 'own', runtime: path.join(dir, 'nvngx_dlssnr.dll') } }).ok, true, 'or the file the user chose');
  assert.strictEqual(legacy.length, 64);
  fs.rmSync(base, { recursive: true, force: true });
});

test('install verifies itself and reports the result', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-installverify-'));
  const payload = fixturePayload(path.join(base, 'p'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  const unlock = { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal }; // the fixture stands in for the bundled build
  const r = await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'c'), gpu: AMPERE, unlock });
  assert.strictEqual(r.ok, true, JSON.stringify(r.verify && r.verify.failed));
  assert.strictEqual(r.verify.ok, true);
  assert.deepStrictEqual(r.verify.failed, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlssnr.dll'), 'utf8'), 'UNIVERSAL-NR');
  fs.rmSync(base, { recursive: true, force: true });
});

test('the game\'s DLSS runtime is only upgraded when Refract\'s is provably newer', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-sr-'));
  // The decision itself, without needing real PE resources
  assert.strictEqual(feeder.srDecision('310.8.0.0', path.join(base, 'nothing.dll')).upgrade, false, 'a game with no DLSS is left alone');
  const fake = path.join(base, 'nvngx_dlss.dll'); fs.writeFileSync(fake, 'not a real PE');
  const d = feeder.srDecision('310.8.0.0', fake);
  assert.strictEqual(d.upgrade, false, 'an unreadable version is left alone rather than guessed at');
  assert.match(d.why, /Could not read/);
  assert.strictEqual(feeder.srDecision(null, fake).upgrade, false);

  // and end to end: the game's own DLSS survives an install when its version cannot be read
  const payload = fixturePayload(path.join(base, 'p'));
  const dir = path.join(base, 'g'); const exe = gameWithDlss(dir);
  const before = fs.readFileSync(path.join(dir, 'nvngx_dlss.dll'), 'utf8');
  const unlock = { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal };
  const r = await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'c'), gpu: AMPERE, unlock });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'nvngx_dlss.dll'), 'utf8'), before, 'the game keeps its own DLSS runtime');
  assert.ok(r.notes.some(n => /Could not read|already current|no nvngx_dlss/.test(n)), 'and the install says why');
  // switching upgrades off is respected
  const dir2 = path.join(base, 'g2'); const exe2 = gameWithDlss(dir2);
  const r2 = await feeder.install({ exe: exe2, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'c'), gpu: AMPERE, unlock, upgradeSr: false });
  assert.ok(r2.notes.some(n => /upgrades are switched off/.test(n)));
  fs.rmSync(base, { recursive: true, force: true });
});

test('a runtime Refract installed that has since vanished is called out as an antivirus', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-av-'));
  const dir = path.join(base, 'g');
  installedGame(dir, { nr: 'UNIVERSAL-NR' });
  const nrPath = path.join(dir, 'nvngx_dlssnr.dll');
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({
    version: 5, route: 'native', added: [{ path: nrPath, kind: 'runtime-nr' }], replaced: [], notes: [],
  }));
  const opts = { gpu: BLACKWELL, unlock: { enabled: true }, route: 'native' };
  assert.strictEqual(feeder.verify(dir, opts).ok, true);
  fs.rmSync(nrPath);                        // what real-time protection does, seconds later
  const v = feeder.verify(dir, opts);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.vanished, true);
  assert.match(v.checks.find(c => c.id === 'runtime').detail, /antivirus most likely quarantined/);
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the OptiScaler bridge (mode 2)
function fsrGame(dir, { xess = false, reshade = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ');
  if (xess) fs.writeFileSync(path.join(dir, 'libxess.dll'), 'GAME-XESS');
  else fs.writeFileSync(path.join(dir, 'ffx_fsr2_x64.dll'), 'GAME-FSR2');
  if (reshade) fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
  return path.join(dir, 'game.exe');
}
function optiPayload(dir) {
  const P = p => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
  const dll = P(path.join(dir, 'opti', 'OptiScaler.dll')); fs.writeFileSync(dll, 'OPTISCALER');
  const xess = P(path.join(dir, 'opti', 'libxess.dll')); fs.writeFileSync(xess, 'XESS-RUNTIME');
  const nr = P(path.join(dir, 'ngx', 'nvngx_dlssnr.dll')); fs.writeFileSync(nr, 'UNIVERSAL-NR');
  return { ok: true, route: 'optiscaler', versions: { optiscaler: '0.9.4' }, optiScaler: dll, optiXess: xess, nvngxNrUniversal: nr };
}

test('a game with FSR or XeSS and no DLSS is routed through the bridge', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-opti-'));
  const opts = { bitness: 64, api: 'dxgi', dx: 12, gpu: BLACKWELL };
  const fsr = path.join(base, 'fsr'); fsrGame(fsr);
  const p = feeder.plan(fsr, opts);
  assert.strictEqual(p.route, 'optiscaler');
  assert.deepStrictEqual(p.actions, ['optiscaler-install', 'nr-runtime']);
  assert.match(p.label, /FSR\/XeSS/);
  const xe = path.join(base, 'xess'); fsrGame(xe, { xess: true });
  assert.strictEqual(feeder.plan(xe, opts).route, 'optiscaler');
  // a game with real DLSS still takes the native route, FSR files or not
  const both = path.join(base, 'both'); gameWithDlss(both); fs.writeFileSync(path.join(both, 'ffx_fsr2_x64.dll'), 'x');
  assert.strictEqual(feeder.plan(both, opts).route, 'native');
  // and a game with neither still goes to the feeder
  const bare = path.join(base, 'bare'); fs.mkdirSync(bare); fs.writeFileSync(path.join(bare, 'game.exe'), 'MZ');
  assert.strictEqual(feeder.plan(bare, opts).route, 'feeder');
  fs.rmSync(base, { recursive: true, force: true });
});

test('the bridge installs beside ReShade, verifies, and restores exactly', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-opti2-'));
  const payload = optiPayload(path.join(base, 'p'));
  const dir = path.join(base, 'g');
  const exe = fsrGame(dir, { reshade: true });      // ReShade already owns dxgi.dll
  const before = fs.readdirSync(dir).sort();
  const r = await feeder.install({ exe, api: 'dxgi', dx: 12, bitness: 64 }, payload,
    { cacheRoot: path.join(base, 'c'), gpu: BLACKWELL, unlock: { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal } });
  assert.strictEqual(r.route, 'optiscaler');
  assert.strictEqual(r.ok, true, JSON.stringify(r.verify.failed));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'dxgi.dll'), 'utf8'), 'ReShade 6.8.0 Searching for add-ons', 'ReShade is left alone');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'winmm.dll'), 'utf8'), 'OPTISCALER', 'the bridge takes the next free proxy name');
  assert.match(fs.readFileSync(path.join(dir, 'OptiScaler.ini'), 'utf8'), /Dx12Upscaler=dlss/);
  assert.ok(fs.existsSync(path.join(dir, 'nvngx_dlssnr.dll')) && fs.existsSync(path.join(dir, 'nvngx.dll_dlssnr.dll')), 'the runtime is there under both names');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'libxess.dll'), 'utf8'), 'XESS-RUNTIME', 'the game\'s XeSS stub is replaced by the bridge runtime');
  await feeder.restore(dir);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'restore leaves the folder as it was');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the feeder route (mode 3)
function feederPayload(dir) {
  const P = p => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
  const w = (p, t) => { fs.writeFileSync(P(p), t); return p; };
  return {
    ok: true, route: 'feeder', versions: { feeder: '0.15.1', lumenite: 'mainline', renodx5: '4.70', dlssnr: 'test' },
    reshadeDll: w(path.join(dir, 'reshade', 'ReShade64.dll'), 'ReShade 6.8.0 Searching for add-ons'),
    feedAddon: w(path.join(dir, 'feeder', 'dlss5-feed.addon64'), 'FEED'),
    feedAddonName: 'dlss5-feed.addon64',
    feedFx: w(path.join(dir, 'feeder', 'DLSS5_Feed.fx'), '// feed'),
    addon: w(path.join(dir, 'addons', 'renodx-dlss5.addon64'), 'RENODX'),
    addonName: 'renodx-dlss5.addon64',
    lumeniteShaders: [w(path.join(dir, 'lum', 'lumenite_Kernel.fx'), '// kernel')],
    lumeniteIncludes: [w(path.join(dir, 'lum', 'inc', 'lumenite_Helpers.fxh'), '// helpers')],
    lumeniteTextures: [w(path.join(dir, 'lum', 'tex', 'lumenite_bluenoise256.png'), 'PNG')],
    shaderHeaders: [w(path.join(dir, 'hdr', 'ReShade.fxh'), '// reshade header')],
    dlls: [w(path.join(dir, 'sl', 'sl.dlss.dll'), 'SL-DLSS'), w(path.join(dir, 'sl', 'sl.common.dll'), 'SL-COMMON')],
    nvngxDlssSr: w(path.join(dir, 'ngx', 'nvngx_dlss.dll'), 'SR-310.8'),
    nvngxNrUniversal: w(path.join(dir, 'ngx', 'nvngx_dlssnr.dll'), 'UNIVERSAL-NR'),
  };
}

test('the feeder route installs, verifies and restores (it used to throw)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-feed-'));
  const payload = feederPayload(path.join(base, 'p'));
  const dir = path.join(base, 'g');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'sl.common.dll'), 'GAME-OWN-SL-COMMON'); // the game already has one
  const before = fs.readdirSync(dir).sort();
  const unlock = { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal };
  const r = await feeder.install({ exe: path.join(dir, 'game.exe'), api: 'dxgi', dx: 12, bitness: 64 }, payload,
    { cacheRoot: path.join(base, 'c'), gpu: AMPERE, unlock });
  assert.strictEqual(r.route, 'feeder');
  assert.strictEqual(r.ok, true, JSON.stringify(r.verify && r.verify.failed));
  const shaders = path.join(dir, 'reshade-shaders', 'Shaders');
  assert.ok(fs.existsSync(path.join(shaders, 'DLSS5_Feed.fx')));
  assert.ok(fs.existsSync(path.join(shaders, 'lumenite_Kernel.fx')));
  assert.ok(fs.existsSync(path.join(shaders, 'include', 'lumenite_Helpers.fxh')));
  assert.ok(fs.existsSync(path.join(dir, 'reshade-shaders', 'Textures', 'lumenite_bluenoise256.png')));
  assert.ok(fs.existsSync(path.join(dir, 'dlss5-feed.addon64')) && fs.existsSync(path.join(dir, 'renodx-dlss5.addon64')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sl.common.dll'), 'utf8'), 'GAME-OWN-SL-COMMON', 'the game keeps its own Streamline file');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sl.dlss.dll'), 'utf8'), 'SL-DLSS', 'and gets the ones it was missing');
  assert.match(fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8'), /DLSS5_Feed/);
  assert.match(fs.readFileSync(path.join(dir, 'dlss5-feed.cfg'), 'utf8'), /enabled=1/);
  // This fixture has the game's own sl.common.dll, so even on an RTX 30 the add-on must stay out
  // of that Streamline: hooking it half-way is what crashed The Witcher 3 on a 3060.
  assert.match(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), /EnableHooks=2/, 'a game with its own Streamline is left alone');
  await feeder.restore(dir);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'restore leaves the folder as it was');
  fs.rmSync(base, { recursive: true, force: true });
});

test('the hook mode follows the card, and a per-game choice wins', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-hooks-'));
  assert.strictEqual(feeder.hooksFor(AMPERE), 1);
  assert.strictEqual(feeder.hooksFor({ dlss5: 'patch', series: 40 }), 1);
  assert.strictEqual(feeder.hooksFor(BLACKWELL), 2);
  const payload = fixturePayload(path.join(base, 'p'));
  const unlock = { enabled: true, source: 'own', runtime: payload.nvngxNrUniversal };
  const a = path.join(base, 'a'); const exeA = gameWithDlss(a);
  await feeder.install({ exe: exeA, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'c'), gpu: BLACKWELL, unlock });
  assert.match(fs.readFileSync(path.join(a, 'ReShade.ini'), 'utf8'), /EnableHooks=2/);
  const b = path.join(base, 'b'); const exeB = gameWithDlss(b);
  await feeder.install({ exe: exeB, api: 'dxgi', dx: 12, bitness: 64 }, payload, { cacheRoot: path.join(base, 'c'), gpu: BLACKWELL, unlock, hooks: 1 });
  assert.match(fs.readFileSync(path.join(b, 'ReShade.ini'), 'utf8'), /EnableHooks=1/);
  fs.rmSync(base, { recursive: true, force: true });
});
