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
  return { ok: true, route: 'native', versions: { renodx5: 'test' }, reshadeDll, addon, addonName: 'renodx-dlss5-v2.5.addon64', dlls: [d1, d2, d3], nvngxDlss: d1 };
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
  assert.deepStrictEqual(gate.actions, ['reshade-upgrade'], 'only ReShade needs fixing');

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
  assert.ok(!fs.existsSync(path.join(gameDir, 'nvngx_dlssnr.dll')), 'no foreign runtime DLL mixed into the game\'s own set');
  assert.strictEqual(feeder.status(gameDir).installed, true);

  await feeder.restore(gameDir);
  for (const f of ['dxgi.dll', 'renodx-dlss5-v2.5.addon64', 'refract-feeder.json']) {
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
  assert.ok(off.warnings.some(w => /RTX 20\/30\/40 unlock/i.test(w)), 'warns that the unlock is needed');
  const on = feeder.plan(dir, { ...opts, gpu: ampere, unlock: { enabled: true } });
  assert.strictEqual(on.warnings.length, 0, 'no warning once the unlock is on');
  const blackwell = feeder.plan(dir, { ...opts, gpu: { name: 'NVIDIA GeForce RTX 5070', dlss5: 'native', series: 50 } });
  assert.strictEqual(blackwell.warnings.length, 0, 'RTX 50 needs no unlock');
  const gtx = feeder.plan(dir, { ...opts, gpu: { name: 'NVIDIA GeForce GTX 1080 Ti', dlss5: 'unsupported' } });
  assert.strictEqual(gtx.ok, false);
  assert.match(gtx.reason, /no DLSS hardware/i);
  fs.rmSync(base, { recursive: true, force: true });
});
