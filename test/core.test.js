'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vdf = require('../src/core/vdf');
const ini = require('../src/core/ini');
const { pickMode, ladder } = require('../src/core/display');
const nvidia = require('../src/core/nvidia');
const reshade = require('../src/core/reshade');
const { getFileVersion, compare } = require('../src/core/peversion');
const looks = require('../src/shared/looks');

test('vdf parses libraryfolders with escaped paths', () => {
  const t = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t\t"apps" { "228980" "1" }\n\t}\n\t"1" { "path" "D:\\\\SteamLibrary" }\n}`;
  const d = vdf.parse(t);
  assert.strictEqual(d.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.strictEqual(d.libraryfolders['1'].path, 'D:\\SteamLibrary');
  assert.strictEqual(d.libraryfolders['0'].apps['228980'], '1');
});

test('ini edits keep unrelated content', () => {
  const src = '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\n; comment\r\nFoo=1\r\n\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\n';
  const d = ini.parse(src);
  ini.set(d, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  ini.set(d, 'INPUT', 'KeyOverlay', '45,0,0,0');
  const out = ini.stringify(d);
  assert.match(out, /; comment/);
  assert.match(out, /Foo=1\r\nPresetPath=\.\\ReShadePreset\.ini/);
  assert.match(out, /KeyOverlay=45,0,0,0/);
  assert.strictEqual(ini.get(ini.parse(out), 'general', 'presetpath'), '.\\ReShadePreset.ini');
});

test('pickMode keeps aspect ratio and refresh rate', () => {
  const native = { width: 2560, height: 1440, hz: 165 };
  const modes = [
    { width: 2560, height: 1440, hz: 165 }, { width: 2560, height: 1440, hz: 60 },
    { width: 1920, height: 1080, hz: 165 }, { width: 1920, height: 1080, hz: 60 },
    { width: 2048, height: 1152, hz: 165 }, { width: 1680, height: 1050, hz: 60 },
    { width: 1600, height: 900, hz: 165 }, { width: 1280, height: 720, hz: 165 },
  ];
  const bal = pickMode(modes, native, 'balanced');
  assert.deepStrictEqual([bal.width, bal.height, bal.hz], [2048, 1152, 165]);
  const perf = pickMode(modes, native, 'performance');
  assert.deepStrictEqual([perf.width, perf.height, perf.hz], [1600, 900, 165]);
  assert.ok(Math.abs(perf.pixelSaving - (1 - 1600 * 900 / (2560 * 1440))) < 1e-9);
  assert.strictEqual(pickMode(modes, native, 'native').width, 2560);
  assert.strictEqual(ladder(modes, native).length, 3);
  assert.strictEqual(pickMode([native], native, 'performance'), null);
});

test('nvidia-smi lines parse, driver gate vs 616.92', () => {
  const i = nvidia.parseInfo('NVIDIA GeForce RTX 5070, 616.92, 250.00, 300.00, 12227');
  assert.strictEqual(i.rtx50, true);
  assert.strictEqual(i.driverStatus, 'tested');
  assert.strictEqual(nvidia.parseInfo('NVIDIA GeForce RTX 4090, 610.10, 450, 600, 24564').driverStatus, 'older');
  assert.strictEqual(nvidia.parseInfo('NVIDIA GeForce RTX 5090, 620.01, 575, 600, 32607').driverStatus, 'newer');
  const l = nvidia.parseLive('247.31, 250.00, 99, 71, 2610, 9012, 12227, P0');
  assert.strictEqual(l.powerLimited, true);
  assert.strictEqual(nvidia.parseLive('120.0, 250.00, 99, 60, 2610, 9012, 12227, P0').powerLimited, false);
  assert.strictEqual(nvidia.parseLive('[N/A], 250.00, 99, 60, 2610, 9012, 12227, P0').powerDraw, null);
});

test('reshade install is additive and reversible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-'));
  const rini = path.join(dir, 'ReShade.ini');
  fs.writeFileSync(rini, '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\nPresetPath=.\\MyPreset.ini\r\n');
  fs.writeFileSync(path.join(dir, 'MyPreset.ini'), 'Techniques=SMAA@SMAA.fx\r\nTechniqueSorting=SMAA@SMAA.fx\r\n\r\n[SMAA.fx]\r\nEdgeDetectionType=1\r\n');
  const st = await reshade.install(rini, { startLook: 'natural' });
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.startLook, 'natural');
  const preset = fs.readFileSync(path.join(dir, 'MyPreset.ini'), 'utf8');
  assert.match(preset, /Techniques=SMAA@SMAA\.fx,Refract@Refract\.fx/);
  assert.match(preset, /\[SMAA\.fx\]\r\nEdgeDetectionType=1/);
  assert.match(preset, /\[Refract\.fx\][\s\S]*RefractStartLook=2/);
  assert.match(fs.readFileSync(rini, 'utf8'), /EffectSearchPaths=\.\\reshade-shaders\\Shaders\\\*\*,\.\\refract-shaders\\/);
  assert.ok(fs.existsSync(path.join(dir, 'refract-shaders', 'Refract.fx')));
  assert.ok(fs.existsSync(rini + '.refract-backup'));
  // idempotent
  await reshade.install(rini, {});
  assert.strictEqual((fs.readFileSync(path.join(dir, 'MyPreset.ini'), 'utf8').match(/Refract@Refract\.fx/g) || []).length, 2); // Techniques + TechniqueSorting
  const un = await reshade.uninstall(rini);
  assert.strictEqual(un.installed, false);
  const after = fs.readFileSync(path.join(dir, 'MyPreset.ini'), 'utf8');
  assert.doesNotMatch(after, /Refract/);
  assert.match(after, /Techniques=SMAA@SMAA\.fx/);
});

test('looks: default preview is identity, others stay in range', () => {
  const P = looks.defaults();
  const img = { width: 4, height: 2, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 30, 90, 200, 255, 250, 120, 10, 255, 128, 128, 128, 255, 12, 250, 40, 255, 64, 32, 16, 255, 200, 200, 190, 255]) };
  const copy = new Uint8ClampedArray(img.data);
  looks.gradeImage(img, 'default', P);
  assert.deepStrictEqual(img.data, copy);
  for (const id of ['cinematic', 'natural']) {
    const im = { width: 4, height: 2, data: new Uint8ClampedArray(copy) };
    looks.gradeImage(im, id, P);
    assert.notDeepStrictEqual(im.data, copy);
  }
  // Natural keeps white at white-ish and lifts black
  const [r0] = looks.natural(0, 0, 0, P);
  assert.ok(r0 > 0.02 && r0 < 0.05);
});

test('shader uniforms match the look parameter ids', () => {
  const fx = fs.readFileSync(path.join(__dirname, '..', 'shaders', 'Refract.fx'), 'utf8');
  for (const l of looks.LOOKS) for (const p of l.params) {
    const m = new RegExp('uniform float ' + p.id + '\\s*<[^>]*ui_min\\s*=\\s*([-\\d.]+);\\s*ui_max\\s*=\\s*([-\\d.]+);[^>]*>\\s*=\\s*([-\\d.]+);').exec(fx);
    assert.ok(m, 'missing uniform ' + p.id);
    assert.strictEqual(+m[1], p.min, p.id + ' min'); assert.strictEqual(+m[2], p.max, p.id + ' max'); assert.strictEqual(+m[3], p.value, p.id + ' default');
  }
  for (const [id, code] of Object.entries(looks.KEYCODES)) {
    assert.match(fx, new RegExp('keycode = 0x' + code.toString(16).toUpperCase()), id);
  }
  assert.strictEqual(compare('616.92', '616.100'), -1);
});

test('pe version reader handles non-PE input', () => {
  const f = path.join(os.tmpdir(), 'not-a-pe.dll');
  fs.writeFileSync(f, 'hello');
  assert.strictEqual(getFileVersion(f), null);
});

test('library uses the ReShade.ini next to the exe, never a backup copy', async () => {
  const library = require('../src/core/library');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-lib-'));
  const bin = path.join(root, 'bin', 'x64_dx12');
  const bak = path.join(root, '_DLSS5_Backup', 'originals', 'x', 'bin', 'x64_dx12');
  for (const d of [bin, bak]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'game.exe'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(bin, 'ReShade.ini'), '[GENERAL]\r\n');
  fs.writeFileSync(path.join(bak, 'ReShade.ini'), '[GENERAL]\r\n');
  fs.writeFileSync(path.join(bak, 'nvngx_dlss.dll'), 'stale');
  fs.writeFileSync(path.join(bak, 'witcher3.exe'), Buffer.alloc(9000));
  const g = await library.inspect({ id: 't', name: 'T', dir: root });
  assert.strictEqual(g.exe, path.join(bin, 'game.exe'));
  assert.strictEqual(g.reshadeIni, path.join(bin, 'ReShade.ini'));
  assert.deepStrictEqual(g.dlls, []);
});

test('removeAll strips Refract from the live ini, keeps newer settings, drops stale backups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-rm-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-rm-other-'));
  const rini = path.join(dir, 'ReShade.ini');
  fs.writeFileSync(rini, '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**,.\\refract-shaders\\\r\nPresetPath=.\\ReShadePreset.ini\r\n\r\n[RenoDX.DLSS5]\r\nNRPreset=3\r\n');
  fs.writeFileSync(rini + '.refract-backup', '[GENERAL]\r\nEffectSearchPaths=.\\refract-shaders\\\r\n');
  fs.writeFileSync(path.join(dir, 'ReShadePreset.ini'), 'Techniques=SMAA@SMAA.fx,Refract@Refract.fx\r\n\r\n[Refract.fx]\r\nRefractStartLook=1\r\n');
  fs.writeFileSync(path.join(dir, 'ReShadePreset.ini.refract-backup'), 'stale');
  const done = await reshade.removeAll(dir, path.join(other, 'ReShade.ini'));
  assert.ok(done.includes('looks'));
  const after = fs.readFileSync(rini, 'utf8');
  assert.doesNotMatch(after, /refract-shaders/);
  assert.match(after, /reshade-shaders\\Shaders/);
  assert.match(after, /\[RenoDX\.DLSS5\]\r\nNRPreset=3/);
  const preset = fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8');
  assert.doesNotMatch(preset, /Refract/);
  assert.match(preset, /Techniques=SMAA@SMAA\.fx/);
  assert.ok(!fs.existsSync(rini + '.refract-backup'));
  assert.ok(!fs.existsSync(path.join(dir, 'ReShadePreset.ini.refract-backup')));
  assert.ok(!fs.existsSync(path.join(other, 'ReShadePreset.ini')), 'never creates files elsewhere');
});
