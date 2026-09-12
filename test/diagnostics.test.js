'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const diagnostics = require('../src/core/diagnostics');

function readZip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), comp = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const body = buf.slice(start, start + comp);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8');
    i = start + comp;
  }
  return out;
}

function brokenGame(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cyberpunk2077.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'nvngx_dlss.dll'), 'GAME-DLSS');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
  fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'ADDON');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\r\n');
  fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({ version: 5, route: 'native', added: [], replaced: [] }));
  fs.writeFileSync(path.join(dir, 'ReShade.log'), `22:45:54:639 [15528] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) loaded from '${dir}\\dxgi.dll' into '${dir}\\Cyberpunk2077.exe' ...
22:45:54:639 [15528] | INFO  | Registered add-on "DLSS 5 Neural Rendering" v0.2026.828.517 using ReShade API version 18.
22:45:54:639 [15528] | INFO  | Running on NVIDIA GeForce RTX 3060 Driver 616.56.
22:47:56:204 [16888] | ERROR | [DLSS 5 Neural Rendering] DLSS5 Generic: nvngx_dlssnr.dll was not found in ${dir}. Place NVIDIA's signed nvngx_dlssnr.dll in that folder and restart the game; NR stays off until then
`);
  return dir;
}

test('a diagnostics bundle explains the RTX 3060 failure by itself', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-diag-'));
  const dir = brokenGame(path.join(base, 'Cyberpunk 2077', 'bin', 'x64'));
  const userData = path.join(base, 'appdata');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'install.log'), 'installed Cyberpunk 2077\n');
  const gpu = { name: 'NVIDIA GeForce RTX 3060', driver: '616.56', series: 30, arch: 'Ampere', dlss5: 'patch', memoryTotal: 12288, driverStatus: 'older' };
  const out = diagnostics.collect({
    game: { name: 'Cyberpunk 2077', store: 'steam', exe: path.join(dir, 'Cyberpunk2077.exe'), apiLabel: 'DirectX 12', bitness: 64 },
    exeDir: dir, gpu, userData, appVersion: '0.4.0',
    settings: { dlss5Unlock: true, games: { a: { exe: 'x' } }, overlay: { hotkey: 'Ctrl+Alt+R' } },
  });
  assert.match(out.name, /^refract-diagnostics-cyberpunk-2077-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
  const files = readZip(out.buffer);
  assert.ok(files['report.json'] && files['game/ReShade.log'] && files['game/refract-feeder.json'] && files['refract/settings.json'] && files['README.txt']);
  const r = JSON.parse(files['report.json']);
  assert.strictEqual(r.game.log.verdict, 'runtime-missing');
  assert.strictEqual(r.game.verify.ok, false);
  assert.strictEqual(r.game.verify.checks.find(c => c.id === 'runtime').ok, false);
  assert.strictEqual(r.gpu.dlss5, 'patch');
  assert.strictEqual(r.refract.version, '0.4.0');
  assert.ok(r.game.folder.files.find(f => f.name === 'renodx-dlss5.addon64'), 'the folder inventory lists the add-on');
  assert.ok(r.game.folder.files.find(f => f.name === 'dxgi.dll').sha256, 'and hashes the files that decide the outcome');
  assert.match(files['README.txt'], /Last run:\s+runtime-missing/);
  // settings are included without the per-game paths
  const s = JSON.parse(files['refract/settings.json']);
  assert.strictEqual(s.games, undefined);
  assert.strictEqual(s.gamesConfigured, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

test('user paths and the account name are redacted', () => {
  const redact = diagnostics.redactor();
  const home = os.homedir();
  const user = path.basename(home);
  const text = redact(`C:\\path ${home}\\Games\\thing.log and ${user} again`);
  assert.doesNotMatch(text, new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  if (user.length > 2) assert.doesNotMatch(text, new RegExp(user));
});

test('collect works with no game and no payload', () => {
  const out = diagnostics.collect({ appVersion: '0.4.0' });
  const files = readZip(out.buffer);
  const r = JSON.parse(files['report.json']);
  assert.strictEqual(r.game, null);
  assert.strictEqual(typeof r.payload.present, 'boolean');
  assert.match(out.name, /^refract-diagnostics-refract-/);
});
