'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const er = require('../src/core/errorreport');

const AMPERE = { name: 'NVIDIA GeForce RTX 3060', driver: '576.02', series: 30, arch: 'Ampere', dlss5: 'patch', memoryTotal: 12288, driverStatus: 'older' };
const ADA = { name: 'NVIDIA GeForce RTX 4050 Laptop GPU', driver: '580.10', series: 40, arch: 'Ada Lovelace', dlss5: 'patch', memoryTotal: 6144 };
const BLACKWELL = { name: 'NVIDIA GeForce RTX 5070', driver: '616.92', series: 50, arch: 'Blackwell', dlss5: 'native', memoryTotal: 12288 };
const TURING = { name: 'NVIDIA GeForce RTX 2060', driver: '576.02', series: 20, arch: 'Turing', dlss5: 'unsupported' };

const GAME = { name: 'Cyberpunk 2077', store: 'Steam', exeDir: 'C:\\Games\\Cyberpunk 2077\\bin\\x64', apiLabel: 'DirectX 12', bitness: 64 };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refract-err-'));
}

test('only RTX 30 and 40 get an automatic report', () => {
  assert.equal(er.watched(AMPERE), true);
  assert.equal(er.watched(ADA), true);
  assert.equal(er.watched(BLACKWELL), false);
  assert.equal(er.watched(TURING), false);
  assert.equal(er.watched(null), false);
});

test('the file is named after the hardware and the day', () => {
  const when = new Date(2026, 8, 12, 14, 32, 10);
  assert.equal(er.fileName(AMPERE, when), 'Refract-error-NVIDIA-GeForce-RTX-3060-2026-09-12.log');
  assert.equal(er.fileName(ADA, when), 'Refract-error-NVIDIA-GeForce-RTX-4050-Laptop-GPU-2026-09-12.log');
  assert.equal(er.fileName(ADA, when, 'zip').endsWith('.zip'), true);
  assert.equal(er.hardwareSlug({ name: 'weird/name: 4090!' }), 'weird-name-4090');
});

test('a bad log verdict on an RTX 30 card is a failure; a good one is not', () => {
  const bad = er.failureOf({ gpu: AMPERE, log: { verdict: 'runtime-missing', text: 'The runtime is not in the game folder.' } });
  assert.equal(bad.code, 'runtime-missing');
  assert.equal(bad.phase, 'session');
  for (const v of ['evaluating', 'idle', 'no-dlss', 'reshade-missing']) {
    assert.equal(er.failureOf({ gpu: AMPERE, log: { verdict: v } }), null, v);
  }
  // Same failure on an RTX 50 card: no Desktop file, that path is verified and has its own UI.
  assert.equal(er.failureOf({ gpu: BLACKWELL, log: { verdict: 'runtime-missing' } }), null);
});

test('a failed install verification and a thrown install both report', () => {
  const v = { ok: false, summary: 'nvngx_dlssnr.dll is missing.', failed: [{ id: 'runtime', label: 'Neural-rendering runtime' }], checks: [] };
  assert.equal(er.failureOf({ gpu: ADA, verify: v, phase: 'install' }).code, 'install-failed');
  const vanished = { ok: false, vanished: true, summary: 'gone', failed: [], checks: [] };
  assert.equal(er.failureOf({ gpu: ADA, verify: vanished }).code, 'files-removed');
  assert.equal(er.failureOf({ gpu: ADA, error: new Error('EBUSY') }).code, 'install-error');
  assert.equal(er.failureOf({ gpu: ADA, verify: { ok: true, checks: [] } }), null);
});

test('precedence: the install trusts its own verification, a session trusts the game log', () => {
  const verify = { ok: false, summary: 'x', failed: [], checks: [] };
  const log = { verdict: 'arch-refused', text: 'refused' };
  assert.equal(er.failureOf({ gpu: AMPERE, verify, log, phase: 'install' }).code, 'install-failed');
  assert.equal(er.failureOf({ gpu: AMPERE, verify, log, phase: 'session' }).code, 'arch-refused');
});

test('the report names the card, the game, the failing checks and what to do', () => {
  const dir = tmp();
  const res = er.write({
    gpu: AMPERE, game: GAME, desktop: dir, appVersion: '0.4.1', route: 'native', phase: 'session',
    when: new Date(2026, 8, 12, 14, 32, 10),
    log: { verdict: 'runtime-missing', text: 'The runtime is not in the game folder.', line: 'ERROR | nvngx_dlssnr.dll was not found', adapter: 'NVIDIA GeForce RTX 3060', evaluations: 0, file: 'C:\\Games\\ReShade.log' },
    verify: { ok: false, summary: 'missing', failed: [{ id: 'runtime' }], checks: [
      { id: 'reshade', label: 'ReShade add-on build next to the game', ok: true, detail: 'dxgi.dll' },
      { id: 'runtime', label: 'Neural-rendering runtime (nvngx_dlssnr.dll)', ok: false, detail: 'Not in this folder.' },
    ] },
    folder: { path: '...', count: 40, files: [{ name: 'dxgi.dll', size: 7340032, sha256: 'a'.repeat(64) }] },
    payload: { present: true, files: 1372, missing: [] },
  });
  assert.equal(res.written, true);
  const text = fs.readFileSync(res.path, 'utf8');
  assert.match(text, /NVIDIA GeForce RTX 3060/);
  assert.match(text, /RTX 30 — Ampere — DLSS 5 tier: patch/);
  assert.match(text, /Cyberpunk 2077 \(Steam\)/);
  assert.match(text, /Code: *runtime-missing/);
  assert.match(text, /FAILED {2}Neural-rendering runtime/);
  assert.match(text, /nvngx_dlssnr\.dll {2,}MISSING/);
  assert.match(text, /dxgi\.dll {2,}7,340,032 bytes/);
  assert.match(text, /WHAT TO TRY NEXT/);
  assert.match(text, /press Repair/i);
  assert.match(text, /#sig [0-9a-f]{16}/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same failure twice a day writes once; a different one appends', () => {
  const dir = tmp();
  const base = { gpu: AMPERE, game: GAME, desktop: dir, when: new Date(2026, 8, 12, 9, 0, 0) };
  const a = er.write({ ...base, log: { verdict: 'runtime-missing', text: 'gone' } });
  const again = er.write({ ...base, when: new Date(2026, 8, 12, 22, 0, 0), log: { verdict: 'runtime-missing', text: 'gone' } });
  assert.equal(a.written, true);
  assert.equal(again.written, false);
  assert.equal(again.path, a.path);
  const b = er.write({ ...base, log: { verdict: 'host-state', text: 'skipped' } });
  assert.equal(b.written, true);
  assert.equal(b.path, a.path);
  const text = fs.readFileSync(a.path, 'utf8');
  assert.equal((text.match(/Refract error report/g) || []).length, 2);
  assert.match(text, /host-state/);
  // A different day is a different file.
  const c = er.write({ ...base, when: new Date(2026, 8, 13, 9, 0, 0), log: { verdict: 'addon-missing', text: 'x' } });
  assert.notEqual(c.path, a.path);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing is written when there is no failure, or on an RTX 50 card', () => {
  const dir = tmp();
  assert.equal(er.write({ gpu: AMPERE, game: GAME, desktop: dir, log: { verdict: 'evaluating' } }), null);
  assert.equal(er.write({ gpu: BLACKWELL, game: GAME, desktop: dir, verify: { ok: false, summary: 'x', failed: [], checks: [] } }), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the redactor is applied to the paths that reach the file', () => {
  const dir = tmp();
  const res = er.write({
    gpu: ADA, game: { name: 'G', exeDir: 'C:\\Users\\aryan\\Games\\G' }, desktop: dir,
    log: { verdict: 'host-state', text: 'skipped', line: 'C:\\Users\\aryan\\Games\\G\\ReShade.log opened' },
    redact: s => String(s).split('C:\\Users\\aryan').join('%USERPROFILE%'),
  });
  const text = fs.readFileSync(res.path, 'utf8');
  assert.equal(text.includes('C:\\Users\\aryan'), false);
  assert.match(text, /%USERPROFILE%\\Games\\G/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every bad verdict has next steps written for it', () => {
  for (const v of er.BAD_VERDICTS) assert.ok(er.NEXT_STEPS[v] && er.NEXT_STEPS[v].length, v);
  for (const v of ['install-failed', 'install-error']) assert.ok(er.NEXT_STEPS[v]);
});
