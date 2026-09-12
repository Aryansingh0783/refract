'use strict';
// Multi Frame Generation for RTX 30 (Ampere) and RTX 40 (Ada).
//
// NVIDIA ships DLSS Frame Generation for Ada and up, and Multi Frame Generation for Blackwell
// only. What actually runs the DLSS-G pipeline on older cards is dlssg_for_sm86 (sdli1995): a
// native reimplementation that carries SM75/SM86 PTX + cubin kernels and NVIDIA's DLSS-G 310.1
// model inside one DLL, so it needs no nvngx_dlssg.dll from a 40-series driver. OptiScaler is the
// host that loads it; OptiScaler on its own does not do Ampere MFG.
//
// dlssg_for_sm86 publishes source but no release binaries, so the pinned artifact is the
// dlss-unlocked distribution, which bundles it — the same sourcing pattern dlss5assets.js already
// uses for the Streamline runtimes. Every file is checked against its own hash on extraction.
//
// This module is deliberately separate from dlss5assets.js: the DLSS 5 catalog is verified
// working on an RTX 5070 and is not touched by the MFG work.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const assets = require('./dlss5assets');
const bundle = require('./bundle');

const digest = buf => crypto.createHash('sha256').update(buf).digest('hex');

const SOURCE = {
  key: 'dlssUnlocked',
  url: 'https://github.com/ShyVortex/dlss-unlocked/releases/download/DLSSNR-v0.7.7/dlss-unlocked-standalone-DLSSNR-v0.7.7.zip',
  name: 'dlss-unlocked-standalone-DLSSNR-v0.7.7.zip',
  kind: 'zip',
  version: 'DLSSNR-v0.7.7',
  sha256: '973176777b87e84cf4dfc3106441cf89fe649b7b5d4824d37eb47cf9181a0dcc',
};

// What Refract takes out of that archive, and nothing else. `from` is the path inside the zip,
// `rel` is where it lands in payload/. Hashes measured from the pinned release.
//
// Explicitly NOT taken: the archive's own nvngx_dlssnr.dll. It is a different build
// (e67dee20…) from Refract's verified universal one (dcc0dc24…) despite the identical size,
// and the DLSS 5 neural-rendering path is already proven with ours.
const FILES = [
  { rel: 'mfg/dlssg_sm86.dll', from: 'OptiScaler/dlssg_sm86/dlssg_sm86.dll',
    sha256: 'c844646d835a7b88', size: 15667520, role: 'the Ampere/Turing MFG engine' },
  { rel: 'mfg/nvngx_dlssg.dll', from: 'OptiScaler/streamline/nvngx_dlssg.dll',
    sha256: 'ff6e90eb78b82792', size: 7460976, role: 'DLSS-G runtime' },
  { rel: 'mfg/sl.reflex.dll', from: 'OptiScaler/streamline/sl.reflex.dll',
    sha256: '0ce9725e3e03ea9e', size: 388736, role: 'Reflex — the latency lever' },
  { rel: 'mfg/sl.pcl.dll', from: 'OptiScaler/streamline/sl.pcl.dll',
    sha256: 'f13d51cfa05f4cd5', size: 360064, role: 'Reflex PC latency stats' },
  { rel: 'mfg/dlssg_to_fsr3.dll', from: 'OptiScaler/dlssg_to_fsr3_amd_is_better.dll',
    sha256: '806020c0444f7841', size: 3038208, role: 'FSR3-FG fallback' },
  { rel: 'mfg/THIRD_PARTY_NOTICES.txt', from: 'OptiScaler/dlssg_sm86/THIRD_PARTY_NOTICES.txt',
    sha256: null, size: null, role: 'licence notices', optional: false },
];

const MFG_DLL_REL = 'mfg/dlssg_sm86.dll';
const DLSSG_REL = 'mfg/nvngx_dlssg.dll';
const REFLEX_REL = 'mfg/sl.reflex.dll';
const PCL_REL = 'mfg/sl.pcl.dll';
const FSR3_FALLBACK_REL = 'mfg/dlssg_to_fsr3.dll';
const NOTICES_REL = 'mfg/THIRD_PARTY_NOTICES.txt';

// The engine version this catalog pins, for the UI and the error report.
const ENGINE_VERSION = 'dlssg_sm86 0.2.4 (via dlss-unlocked DLSSNR-v0.7.7)';

// Where the DLL has to sit relative to the game folder for OptiScaler to host it — the layout
// dlss-unlocked ships. See PRD B0: this is the layout under test, not yet a proven load path.
const GAME_SUBDIR = 'dlssg_sm86';

// Hashes above are stored truncated to 16 chars for readability; compare on that prefix.
function hashOk(want, got) { return !want || got.slice(0, want.length) === want; }

// Every MFG file, resolved out of the bundled payload. Returns null for any that is missing so
// callers can decide between "download it" and "refuse the feature".
function fromBundle() {
  const out = {};
  for (const f of FILES) out[f.rel] = bundle.file(f.rel);
  return out;
}

function bundled() {
  const b = fromBundle();
  return FILES.every(f => f.optional || b[f.rel]) ? b : null;
}

// Pull the MFG set out of the pinned archive, verifying each file. Used by the payload builder
// and as the runtime fallback for a dev checkout with no payload/.
async function extractFrom(dir) {
  const out = {};
  const all = assets.walkFiles(dir);
  for (const f of FILES) {
    const want = f.from.split('/').join(path.sep).toLowerCase();
    const p = all.find(x => x.toLowerCase().endsWith(want));
    if (!p) {
      if (f.optional) continue;
      throw new Error(`The dlss-unlocked package did not contain ${f.from}.`);
    }
    const buf = fs.readFileSync(p);
    const got = digest(buf);
    if (!hashOk(f.sha256, got)) {
      throw new Error(`${f.from} checksum mismatch (expected ${f.sha256}…, got ${got.slice(0, 16)}…).`);
    }
    if (f.size != null && buf.length !== f.size) {
      throw new Error(`${f.from} is ${buf.length} bytes, expected ${f.size}.`);
    }
    out[f.rel] = p;
  }
  return out;
}

// The MFG components, from the payload when it has them and from the pinned download otherwise.
async function ensureMfg(cacheRoot, onProgress) {
  const b = bundled();
  if (b) return { files: b, version: ENGINE_VERSION, source: 'bundle' };
  if (!cacheRoot) throw new Error('Multi Frame Generation is not in this install and there is nowhere to download it to.');
  const step = (label, frac) => onProgress && onProgress({ phase: 1, of: 1, label, frac });
  step('Multi Frame Generation engine');
  // Registered into the shared catalog so ensureUnpacked's cache + hash check apply unchanged.
  if (!assets.SOURCES[SOURCE.key]) assets.SOURCES[SOURCE.key] = SOURCE;
  const dir = await assets.ensureUnpacked(cacheRoot, SOURCE.key, f => step('Multi Frame Generation engine', f));
  return { files: await extractFrom(dir), version: ENGINE_VERSION, source: 'download' };
}

module.exports = {
  SOURCE, FILES, ensureMfg, extractFrom, bundled, fromBundle, hashOk,
  MFG_DLL_REL, DLSSG_REL, REFLEX_REL, PCL_REL, FSR3_FALLBACK_REL, NOTICES_REL,
  ENGINE_VERSION, GAME_SUBDIR,
};
