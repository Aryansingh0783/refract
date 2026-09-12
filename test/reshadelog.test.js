'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rl = require('../src/core/reshadelog');

// Excerpts from real logs: an RTX 5070 where neural rendering works, an RTX 3060 where the
// runtime never reached the game folder, and an RTX 4050 where the add-on skipped the pass.
const HEAD = (game, adapter, driver) => `23:45:07:411 [16112] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) loaded from '${game}\\dxgi.dll' into '${game}\\game.exe' (0x491EA19E) ...
23:45:19:007 [16112] | INFO  | Searching for add-ons (*.addon, *.addon64) in '${game}' ...
23:45:19:008 [16112] | INFO  | Registered add-on "DLSS 5 Neural Rendering" v0.2026.828.517 using ReShade API version 18.
23:45:22:791 [16112] | INFO  | Running on ${adapter} Driver ${driver}.
`;

const WORKING = HEAD('J:\\Cyberpunk 2077\\bin\\x64', 'NVIDIA GeForce RTX 5070', '616.92') + `23:45:19:444 [16112] | WARN  | [DLSS 5 Neural Rendering] DLSS5 Generic: signed runtime sha256 DCC0DC2414AEDEC4A8E084647070383BE068554042587180C20C784D4772D36F (custom runtime accepted)
23:45:19:444 [16112] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: signed NR runtime (nvngx_dlssnr.dll) pre-loaded at device init
23:45:45:759 [32248] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: NGX feature create intercepted: feature=18 (DLSSNR/reserved-18), slot=0
23:45:45:983 [32248] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: feature 18 created via the signed snippet after DLSSD/RR
23:45:45:985 [32248] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: inline feature 18 evaluation succeeded (count=1, NR input 1920x1080)
23:45:46:985 [32248] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: inline feature 18 evaluation succeeded (count=60, NR input 1920x1080)
`;

const RTX3060 = HEAD('D:\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64', 'NVIDIA GeForce RTX 3060', '616.56') + `22:46:03:801 [ 9460] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: first NGX evaluate intercepted (slot=0)
22:47:56:204 [16888] | ERROR | [DLSS 5 Neural Rendering] DLSS5 Generic: nvngx_dlssnr.dll was not found in D:\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64. Place NVIDIA's signed nvngx_dlssnr.dll in that folder and restart the game; NR stays off until then
22:48:48:872 [16872] | ERROR | [DLSS 5 Neural Rendering] DLSS5 Generic: nvngx_dlssnr.dll was not found in D:\\Steam\\steamapps\\common\\Cyberpunk 2077\\bin\\x64. Place NVIDIA's signed nvngx_dlssnr.dll in that folder and restart the game; NR stays off until then
`;

const RTX4050 = HEAD('C:\\Program Files (x86)\\Steam\\steamapps\\common\\DEATH STRANDING DIRECTORS CUT', 'NVIDIA GeForce RTX 4050 Laptop GPU', '616.56') + `02:19:20:008 [23736] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: first NGX evaluate intercepted (slot=0)
02:19:20:011 [23736] | INFO  | [DLSS 5 Neural Rendering] DLSS5 Generic: DLSS-armed detailed native host tracker installed; first-use coarse prehistory is preserved
02:19:20:015 [23736] | WARN  | [DLSS 5 Neural Rendering] DLSS5 Generic: real DLSS/DLSSD work left host state incomplete; skipping inline NR (pso_known=1 so_known=1 root_known=0 heaps=2)
`;

test('the working RTX 5070 log reads as evaluating', () => {
  const r = rl.parse(WORKING);
  assert.strictEqual(r.verdict, 'evaluating');
  assert.strictEqual(r.evaluations, 60);
  assert.strictEqual(r.adapter, 'NVIDIA GeForce RTX 5070');
  assert.strictEqual(r.driver, '616.92');
  assert.strictEqual(r.runtimeLoaded, true);
  assert.strictEqual(r.runtimeSha.slice(0, 12), 'dcc0dc2414ae');
  assert.strictEqual(rl.VERDICTS[r.verdict].level, 'ok');
});

test('the RTX 3060 log names the missing runtime and points at Repair', () => {
  const r = rl.parse(RTX3060);
  assert.strictEqual(r.verdict, 'runtime-missing');
  assert.match(r.line, /nvngx_dlssnr\.dll was not found/);
  assert.strictEqual(r.evaluations, 0);
  assert.strictEqual(r.adapter, 'NVIDIA GeForce RTX 3060');
  assert.strictEqual(rl.VERDICTS[r.verdict].action, 'repair');
});

test('the RTX 4050 log reads as an incomplete host state, not a missing file', () => {
  const r = rl.parse(RTX4050);
  assert.strictEqual(r.verdict, 'host-state');
  assert.match(r.line, /skipping inline NR/);
  assert.strictEqual(r.addon, 'DLSS 5 Neural Rendering');
  assert.strictEqual(rl.VERDICTS[r.verdict].action, 'upgrade-dlss');
});

test('a later success outranks an earlier failure in the same log', () => {
  const r = rl.parse(RTX3060 + WORKING.split('\n').slice(4).join('\n'));
  assert.strictEqual(r.verdict, 'evaluating');
});

test('other shapes: no log, a limited build, no add-on, DLSS never used', () => {
  assert.strictEqual(rl.parse('').verdict, 'reshade-missing');
  const limited = HEAD('C:\\g', 'NVIDIA GeForce RTX 5070', '616.92').replace('Registered add-on "DLSS 5 Neural Rendering" v0.2026.828.517 using ReShade API version 18.', 'It was built with only limited add-on functionality.');
  assert.strictEqual(rl.parse(limited).verdict, 'limited-reshade');
  const noAddon = HEAD('C:\\g', 'NVIDIA GeForce RTX 5070', '616.92').split('\n').filter(l => !/Registered add-on/.test(l)).join('\n');
  assert.strictEqual(rl.parse(noAddon).verdict, 'addon-missing');
  assert.strictEqual(rl.parse(HEAD('C:\\g', 'NVIDIA GeForce RTX 5070', '616.92')).verdict, 'no-dlss');
});

test('inspectGame reads the newest log in a game folder and tolerates none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-log-'));
  assert.strictEqual(rl.inspectGame(dir).verdict, 'reshade-missing');
  fs.writeFileSync(path.join(dir, 'ReShade1.log'), RTX3060);
  fs.writeFileSync(path.join(dir, 'ReShade.log'), WORKING);
  const now = Date.now();
  fs.utimesSync(path.join(dir, 'ReShade1.log'), new Date(now - 60000), new Date(now - 60000));
  const r = rl.inspectGame(dir);
  assert.strictEqual(r.verdict, 'evaluating');
  assert.strictEqual(path.basename(r.file), 'ReShade.log');
  assert.strictEqual(rl.logsIn(dir).length, 2);
});

test('only the tail of a huge log is read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-log-big-'));
  const p = path.join(dir, 'ReShade.log');
  fs.writeFileSync(p, 'x'.repeat(9 << 20) + '\n' + RTX3060);
  const t = rl.readTail(p);
  assert.ok(t.length <= (8 << 20) + 1);
  assert.strictEqual(rl.parse(t).verdict, 'runtime-missing');
});
