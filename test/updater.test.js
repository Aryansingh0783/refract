'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const up = require('../src/core/updater');

const REL = (over = {}) => ({
  tag_name: 'v0.6.0', name: 'DIHLSS5 0.6.0', body: 'notes',
  html_url: 'https://github.com/Aryansingh0783/refract/releases/tag/v0.6.0',
  assets: [{ name: 'DIHLSS5-Setup-0.6.0.exe', size: 405912040,
    browser_download_url: 'https://github.com/Aryansingh0783/refract/releases/download/v0.6.0/DIHLSS5-Setup-0.6.0.exe' }],
  ...over,
});

test('version comparison handles v-prefixes and uneven lengths', () => {
  assert.equal(up.compare('0.5.0', '0.6.0'), -1);
  assert.equal(up.compare('0.5.0', 'v0.5.0'), 0);
  assert.equal(up.compare('0.10.0', '0.9.0'), 1);   // not string order
  assert.equal(up.compare('0.5', '0.5.1'), -1);
  assert.equal(up.compare('1.0.0', '0.9.9'), 1);
  assert.equal(up.compare('0.5.0', '0.5.0'), 0);
});

test('check reports a newer release and the installer to fetch', async () => {
  const r = await up.check('0.5.0', { fetchJson: async () => REL() });
  assert.equal(r.newer, true);
  assert.equal(r.latest, '0.6.0');
  assert.equal(r.downloadable, true);
  assert.equal(r.asset.name, 'DIHLSS5-Setup-0.6.0.exe');
});

test('the same version is not an update', async () => {
  const r = await up.check('0.6.0', { fetchJson: async () => REL() });
  assert.equal(r.newer, false);
});

test('a release with no installer attached is flagged, not guessed at', async () => {
  const r = await up.check('0.5.0', { fetchJson: async () => REL({ assets: [] }) });
  assert.equal(r.newer, true);
  assert.equal(r.downloadable, false);
  assert.equal(r.asset, null);
  assert.match(r.page, /github\.com\/Aryansingh0783/);
});

test('the full installer is preferred over the lite one', () => {
  const a = up.pickAsset([
    { name: 'DIHLSS5-Setup-0.6.0-lite.exe', browser_download_url: 'https://github.com/x/y/releases/download/a/DIHLSS5-Setup-0.6.0-lite.exe' },
    { name: 'DIHLSS5-Setup-0.6.0.exe', browser_download_url: 'https://github.com/x/y/releases/download/a/DIHLSS5-Setup-0.6.0.exe' },
  ]);
  assert.equal(a.name, 'DIHLSS5-Setup-0.6.0.exe');
});

test('assets that are not our installer, or not from GitHub, are ignored', () => {
  assert.equal(up.pickAsset([{ name: 'notes.txt', browser_download_url: 'https://github.com/x/y/notes.txt' }]), null);
  // An .exe from somewhere else is the dangerous case: never selected.
  assert.equal(up.pickAsset([{ name: 'DIHLSS5-Setup-9.9.9.exe', browser_download_url: 'https://evil.example.com/DIHLSS5-Setup-9.9.9.exe' }]), null);
  assert.equal(up.pickAsset([{ name: 'DIHLSS5-Setup-9.9.9.exe', browser_download_url: 'http://github.com/x/y/z.exe' }]), null, 'plain http refused');
});

test('download refuses anything not from the project\'s own releases', async () => {
  await assert.rejects(() => up.download({ name: 'DIHLSS5-Setup-1.0.0.exe', url: 'https://evil.example.com/x.exe' }),
    /own GitHub releases/);
  await assert.rejects(() => up.download({ name: 'payload.exe', url: 'https://github.com/Aryansingh0783/refract/releases/download/v1/payload.exe' }),
    /not a DIHLSS5 installer/);
});

test('a download whose size does not match is not written or run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const asset = { name: 'DIHLSS5-Setup-1.0.0.exe', size: 5000000,
    url: 'https://github.com/Aryansingh0783/refract/releases/download/v1/DIHLSS5-Setup-1.0.0.exe' };
  const short = Buffer.alloc(2 << 20); short[0] = 0x4d; short[1] = 0x5a;
  await assert.rejects(() => up.download(asset, { dir, get: async () => short }), /GitHub said 5000000/);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a download that is not a Windows executable is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const asset = { name: 'DIHLSS5-Setup-1.0.0.exe',
    url: 'https://github.com/Aryansingh0783/refract/releases/download/v1/DIHLSS5-Setup-1.0.0.exe' };
  const notExe = Buffer.alloc(2 << 20, 0x41);   // no MZ header
  await assert.rejects(() => up.download(asset, { dir, get: async () => notExe }), /not a Windows installer/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a good download is written and can be launched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const buf = Buffer.alloc(2 << 20); buf[0] = 0x4d; buf[1] = 0x5a;
  const asset = { name: 'DIHLSS5-Setup-1.0.0.exe', size: buf.length,
    url: 'https://github.com/Aryansingh0783/refract/releases/download/v1/DIHLSS5-Setup-1.0.0.exe' };
  const file = await up.download(asset, { dir, get: async () => buf });
  assert.ok(fs.existsSync(file));
  let launched = null;
  up.install(file, { spawnFn: (f, a, o) => { launched = { f, o }; return { unref() {} }; } });
  assert.equal(launched.f, file);
  assert.equal(launched.o.detached, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install refuses a path that is not an installer on disk', () => {
  assert.throws(() => up.install('C:\\nope\\nothing.exe'), /not where it should be/);
  assert.throws(() => up.install(null), /not where it should be/);
});

test('the updater is pinned to this project only', () => {
  assert.equal(up.REPO, 'Aryansingh0783/refract');
  assert.match(up.API, /^https:\/\/api\.github\.com\/repos\/Aryansingh0783\/refract\//);
});
