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
