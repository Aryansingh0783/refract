'use strict';
// The third-party payload shipped inside the installer (resources/payload), laid out by
// scripts/fetch-payload.js. Every file is listed in payload/manifest.json with its SHA-256;
// a file is only handed out after its hash matches (checked once per run), so a damaged or
// tampered install falls back to the verified download path instead of being used.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function candidates() {
  const c = [];
  if (process.env.REFRACT_PAYLOAD) c.push(process.env.REFRACT_PAYLOAD);
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'payload'));
  c.push(path.join(__dirname, '..', '..', 'payload'));
  return c;
}

let cached;
function load() {
  if (cached !== undefined) return cached;
  for (const root of candidates()) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      if (manifest && manifest.files) return (cached = { root, manifest, verified: new Map() });
    } catch {}
  }
  return (cached = null);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(4 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Absolute path of a bundled file (manifest-relative, '/' separated), or null.
function file(rel) {
  const b = load();
  if (!b) return null;
  const want = b.manifest.files[rel];
  if (!want) return null;
  const p = path.join(b.root, ...rel.split('/'));
  if (!fs.existsSync(p)) return null;
  if (!b.verified.has(rel)) b.verified.set(rel, sha256File(p) === want);
  return b.verified.get(rel) ? p : null;
}

// Every verified bundled file under a prefix, e.g. list('lumenite/Shaders/').
function list(prefix) {
  const b = load();
  if (!b) return [];
  return Object.keys(b.manifest.files).filter(r => r.startsWith(prefix)).map(file).filter(Boolean);
}

// Cheap presence check (listed in the manifest and on disk) without hashing — for status
// displays; file() still verifies before anything is used.
function has(rel) {
  const b = load();
  return !!(b && b.manifest.files[rel] && fs.existsSync(path.join(b.root, ...rel.split('/'))));
}

function info() {
  const b = load();
  return b ? { root: b.root, components: b.manifest.components || {}, files: Object.keys(b.manifest.files).length } : null;
}

module.exports = { file, list, has, info, sha256File, _reset: () => { cached = undefined; } };
