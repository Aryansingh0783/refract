'use strict';
// Fetches the official ReShade build on first use, verifies it, caches it, and extracts the
// ReShade DLL Refract drops into a game as its proxy. Refract never bundles ReShade; this is
// the same "download from upstream, verify, cache" pattern the DLSS 5 Swapper uses for its
// third-party components. Windows-only (uses tar.exe to unpack the setup's archive).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Official version-pinned downloads. Hashes are verified when known; a null hash means
// "record on first download" (trust-on-first-use) so the app still works before a pin.
const BUILDS = {
  plain: {
    url: 'https://reshade.me/downloads/ReShade_Setup_6.8.0.exe',
    sha256: null,
  },
  addon: {
    url: 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe',
    sha256: null,
  },
};
// Pinned after verification on a known-good machine (filled in by build/verify).
const PINNED = require('./reshade-hashes.json');

function digest(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Refract/0.1' }, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`ReShade download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function tar(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('tar.exe', args, { cwd, windowsHide: true, timeout: 60000 }, (err, so, se) =>
      err ? reject(new Error('tar failed: ' + (se || err.message))) : resolve());
  });
}

// Returns the absolute path to the extracted ReShade<bitness>.dll for the requested build.
async function ensureReShade(cacheRoot, { addon = false, bitness = 64 } = {}) {
  if (process.platform !== 'win32') throw new Error('ReShade auto-install is Windows only.');
  const kind = addon ? 'addon' : 'plain';
  const build = BUILDS[kind];
  const dllName = `ReShade${bitness}.dll`;
  const dir = path.join(cacheRoot, 'reshade', `6.8.0-${kind}`);
  const dll = path.join(dir, dllName);
  const expected = PINNED[kind] || build.sha256;
  if (fs.existsSync(dll)) return dll;

  await fs.promises.mkdir(dir, { recursive: true });
  const setup = path.join(dir, 'setup.exe');
  if (!(fs.existsSync(setup) && (!expected || digest(fs.readFileSync(setup)) === expected))) {
    const bytes = await fetchBytes(build.url);
    const got = digest(bytes);
    if (expected && got !== expected) throw new Error(`ReShade checksum mismatch (expected ${expected}, got ${got}).`);
    const tmp = setup + '.part';
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, setup);
  }
  // The setup is an NSIS installer wrapping the DLLs; tar.exe (bsdtar) unpacks them.
  await tar(['-xf', setup, dllName], dir);
  if (!fs.existsSync(dll)) throw new Error('Could not extract ' + dllName + ' from the ReShade setup.');
  return dll;
}

// True when a DLL is a ReShade build with FULL add-on support.
//
// Careful: both builds contain "Searching for add-ons" — the non-add-on build logs that
// line and then refuses with "because this build of ReShade has only limited add-on
// functionality". Testing only for the search string false-positives on the limited build
// and silently leaves a ReShade that will never load an add-on. The refusal message is the
// reliable discriminator.
const LIMITED_MARKER = 'limited add-on functionality';
function isAddonReShade(file) {
  try {
    const b = fs.readFileSync(file);
    if (!b.includes(Buffer.from('ReShade'))) return false;
    if (b.includes(Buffer.from(LIMITED_MARKER))) return false;
    return b.includes(Buffer.from('Searching for add-ons'));
  } catch { return false; }
}
function isReShade(file) {
  try { return fs.readFileSync(file).includes(Buffer.from('ReShade')); } catch { return false; }
}

module.exports = { ensureReShade, isAddonReShade, isReShade, BUILDS };
