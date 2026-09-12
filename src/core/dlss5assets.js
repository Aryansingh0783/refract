'use strict';
// Catalog of every third-party component the DLSS 5 routes need, pinned to a known version
// and hash. The installer ships all of them in resources/payload (built by
// scripts/fetch-payload.js from this catalog); the download path here is only the fallback
// for a damaged install or a dev checkout without ./payload.
//
// Routes and what each needs:
//   native         DX12 + the game already has DLSS  -> ReShade add-on build + renodx-dlss5
//   native+bridge  DX11 + the game already has DLSS  -> the above + dlss5-bridge
//   feeder         DX11/DX12 with NO DLSS            -> ReShade + dlss5-feed + LumeniteFX + NGX runtime
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SOURCES = {
  renodx5: {
    url: 'https://github.com/RankFTW/rhi-repo/releases/download/renodx-dlss5-4.70/renodx-dlss5_4.70.zip',
    name: 'renodx-dlss5_4.70.zip', kind: 'zip', version: '4.70',
    sha256: 'd6e356d01b429af6288f488a4926c44f1d779a7d4586ee8c79d04d3a09a536e6',
  },
  bridge: {
    url: 'https://github.com/NIGos/dlss5-dx11-bridge/releases/download/v1.4.12/dlss5-bridge.addon64',
    name: 'dlss5-bridge.addon64', kind: 'file', version: '1.4.12',
    sha256: '4f2acecc1026ae89ac0b92767be66ceea2662ad0ef88710b89c7da7840d548d4',
  },
  feeder: {
    url: 'https://github.com/jlrouzies-fr/DLSS5-Feeder/releases/download/v0.15.1/DLSS5-Feeder-0.15.1.zip',
    name: 'DLSS5-Feeder-0.15.1.zip', kind: 'zip', version: '0.15.1',
    sha256: '2e44e81e691e75e532b9b7babc278a12615cb7f0fd9ef854da50e6ef17b272f4',
  },
  // A branch tarball, so its hash moves with upstream; verified by extraction instead.
  lumenite: {
    url: 'https://codeload.github.com/umar-afzaal/LumeniteFX/tar.gz/refs/heads/mainline',
    name: 'LumeniteFX-mainline.tar.gz', kind: 'tar', version: 'mainline', sha256: null,
  },
  streamline: {
    url: 'https://github.com/yumlevi/renodx-dlss-installer/releases/download/latest/streamline.zip',
    name: 'streamline.zip', kind: 'zip', version: 'latest',
    sha256: '5389d164ef99a0e4aba5128da2e87d26de5833aeaf89bfeb0232cfdc8f7229a2',
    // Two files inside are used on their own: NVIDIA's DLSS Super Resolution runtime, which the
    // add-on's neural pass rides on, and Streamline's DLSS-NR plugin. Same bytes 1-Click ships.
    inner: {
      'nvngx_dlss.dll': 'c85f971ce023c9f3492fc7455f0b01a24ba18ea39636407a846902c4360b0b7e',   // 310.8.0.0
      'sl.dlss_nr.dll': '9f6672e5e0170dc118a3188d21bda187e1fc1aa3502895b21ab846d23165c11d',   // Streamline 2.13
    },
  },
  // OptiScaler: the bridge that turns a game's FSR 2/3 or XeSS calls into DLSS calls, so a game
  // that never shipped DLSS can still be given DLSS 5 neural rendering. This is 1-Click-DLSS5's
  // "Mode 2", taken from OptiScaler's own release rather than their repack.
  optiscaler: {
    url: 'https://github.com/optiscaler/OptiScaler/releases/download/v0.9.4/Optiscaler_0.9.4-final.20260718._MM.7z',
    name: 'Optiscaler_0.9.4.7z', kind: 'zip', version: '0.9.4',
    sha256: '575cb4df866116093df75af607e37fd70e10f5163e0f23fd5c804142e80ef0ad',
    inner: {
      'OptiScaler.dll': 'fbfb6676b829dad7e020fb830586a16aa0ec6add78016db48ef12e2ae1803231',
      'libxess.dll': '251659dd84a3e84de67c886a4186e01f3eca49b00641906fe38bb6b807e5d5b7',
    },
  },
  // The neural-rendering runtime every DLSS 5 route needs (nvngx_dlssnr.dll), taken from the
  // NeuralScreen release, which Refract also bundles whole as its screen-space engine.
  // NVIDIA's 310.8.0 build with sm_75/86/89/120 kernels and an architecture gate that accepts
  // Ampere, Ada and Blackwell (Turing is still refused), so one file serves RTX 30/40/50.
  // A modified proprietary binary; users can point Refract at their own file instead.
  neuralscreen: {
    url: 'https://github.com/perseval-BLR/DLSS5-NeuralScreen/releases/download/v1.6.0/neuralscreen-v1.6.0-full.zip',
    name: 'neuralscreen-v1.6.0-full.zip', kind: 'zip', version: '1.6.0',
    sha256: '0e36f9bcb863044ec8e3740469a430df5b24d8adf9271c77c9c8dcf5b2d70fe8',
    innerSha256: 'dcc0dc2414aedec4a8e084647070383be068554042587180c20c784d4772d36f',
  },
};

const PINNED = require('./dlss5-hashes.json');
const bundle = require('./bundle');

// ReShade's standard shader headers. DLSS5_Feed.fx and the LumeniteFX effects #include
// these, and neither package ships them (the reference installers pull them from here).
const SHADER_HEADERS = ['ReShade.fxh', 'ReShadeUI.fxh', 'DrawText.fxh'];
const HEADER_URL = n => `https://raw.githubusercontent.com/crosire/reshade-shaders/slim/Shaders/${n}`;
const digest = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchBytes(url, onFrac) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Refract/0.1' }, signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); got += value.length;
    if (onFrac && total) onFrac(got / total);
  }
  return Buffer.concat(chunks);
}

function tar(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('tar.exe', args, { cwd, windowsHide: true, timeout: 300000 }, (err, so, se) =>
      err ? reject(new Error('tar failed: ' + (se || err.message))) : resolve());
  });
}

function cacheDir(cacheRoot) { return path.join(cacheRoot, 'dlss5'); }

// Download (or reuse) one catalog artifact, verifying its pinned hash.
async function ensureFile(cacheRoot, key, onFrac) {
  const a = SOURCES[key];
  if (!a) throw new Error('unknown DLSS 5 asset: ' + key);
  const dir = cacheDir(cacheRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, a.name);
  const expected = PINNED[key] || a.sha256;
  if (fs.existsSync(dest) && (!expected || digest(fs.readFileSync(dest)) === expected)) return dest;
  const bytes = await fetchBytes(a.url, onFrac);
  const got = digest(bytes);
  if (expected && got !== expected) throw new Error(`${a.name} checksum mismatch (expected ${expected}, got ${got}).`);
  const tmp = dest + '.part';
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, dest);
  return dest;
}

// Download + unpack an archive asset (bsdtar reads .zip and .tar.gz alike).
async function ensureUnpacked(cacheRoot, key, onFrac) {
  const a = SOURCES[key];
  const src = await ensureFile(cacheRoot, key, onFrac);
  if (a.kind === 'file') return src;
  const out = path.join(cacheDir(cacheRoot), key + '.x');
  const marker = path.join(out, '.extracted');
  if (fs.existsSync(marker)) return out;
  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(out, { recursive: true });
  await tar(['-xf', src], out);
  await fs.promises.writeFile(marker, '');
  return out;
}

function walkFiles(root) {
  const out = [];
  (function rec(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) rec(p); else out.push(p);
    }
  })(root);
  return out;
}
const findFile = (root, re) => walkFiles(root).find(p => re.test(path.basename(p)));
const listFiles = (root, re) => walkFiles(root).filter(p => re.test(path.basename(p)));

async function ensureStreamline(cacheRoot, onFrac) {
  const dir = await ensureUnpacked(cacheRoot, 'streamline', onFrac);
  return listFiles(dir, /\.dll$/i);
}

async function ensureShaderHeaders(cacheRoot) {
  const dir = path.join(cacheDir(cacheRoot), 'headers');
  await fs.promises.mkdir(dir, { recursive: true });
  const out = [];
  for (const n of SHADER_HEADERS) {
    const dest = path.join(dir, n);
    if (!fs.existsSync(dest)) {
      const bytes = await fetchBytes(HEADER_URL(n));
      if (!bytes.includes(Buffer.from('#'))) throw new Error('Unexpected content for ' + n);
      await fs.promises.writeFile(dest, bytes);
    }
    out.push(dest);
  }
  return out;
}

// Assemble everything a route needs. The payload bundled in the installer is used first
// (hash-checked by bundle.js); anything missing falls back to the pinned download.
// onProgress -> {phase, of, label, frac?}
async function ensurePayload(cacheRoot, { bitness = 64, route = 'native' } = {}, onProgress) {
  const rt = require('./reshaderuntime');
  const needs = ['reshade', 'dlss-sr', 'dlssnr'];
  if (route === 'native' || route === 'native+bridge') needs.push('renodx5');
  if (route === 'optiscaler') needs.push('optiscaler');
  if (route === 'native+bridge') needs.push('bridge');
  if (route === 'feeder') needs.push('renodx5', 'feeder', 'lumenite', 'headers', 'streamline');
  const of = needs.length;
  let n = 0;
  const step = (label, frac) => onProgress && onProgress({ phase: n, of, label, frac });
  const b = (rel) => (bitness === 64 ? bundle.file(rel) : null);
  const out = { ok: false, route, versions: {}, bundled: !!bundle.info() };

  n++; step('ReShade add-on runtime');
  out.reshadeDll = b('reshade/ReShade64.dll') || await rt.ensureReShade(cacheRoot, { addon: true, bitness });

  n++; step('DLSS Super Resolution runtime');
  out.nvngxDlssSr = b(SR_REL);
  out.slDlssNr = b(SL_NR_REL);
  out.versions.dlssSr = SR_VERSION;

  n++; step('Neural-rendering runtime');
  out.nvngxNrUniversal = b(NR_REL) || await ensureUniversalRuntime(cacheRoot, p => step('Neural-rendering runtime', p && p.frac));
  out.versions.dlssnr = '310.8.0 (NeuralScreen ' + SOURCES.neuralscreen.version + ')';

  if (needs.includes('renodx5')) {
    n++; step('RenoDX DLSS 5 add-on');
    out.addon = b('addons/renodx-dlss5.addon64')
      || findFile(await ensureUnpacked(cacheRoot, 'renodx5', f => step('RenoDX DLSS 5 add-on', f)), /^renodx-dlss5\.addon64$/i);
    out.addonName = 'renodx-dlss5.addon64';
    out.versions.renodx5 = SOURCES.renodx5.version;
  }
  if (needs.includes('optiscaler')) {
    n++; step('OptiScaler bridge');
    const o = await ensureOptiScaler(cacheRoot, f => step('OptiScaler bridge', f && f.frac));
    out.optiScaler = o.dll; out.optiXess = o.xess;
    out.versions.optiscaler = o.version;
  }
  if (needs.includes('bridge')) {
    n++; step('DX11 DLSS bridge');
    out.bridge = b('addons/dlss5-bridge.addon64') || await ensureUnpacked(cacheRoot, 'bridge', f => step('DX11 DLSS bridge', f));
    out.bridgeName = 'dlss5-bridge.addon64';
    out.versions.bridge = SOURCES.bridge.version;
  }
  if (needs.includes('feeder')) {
    n++; step('DLSS 5 Feeder');
    let feedAddon = b(`feeder/dlss5-feed.addon${bitness}`), feedFx = b('feeder/DLSS5_Feed.fx'), verify = b('feeder/Verify-DLSS5Feeder.ps1');
    if (!feedAddon || !feedFx) {
      const dir = await ensureUnpacked(cacheRoot, 'feeder', f => step('DLSS 5 Feeder', f));
      feedAddon = findFile(dir, new RegExp(`^dlss5-feed\\.addon${bitness}$`, 'i'));
      feedFx = findFile(dir, /^DLSS5_Feed\.fx$/i);
      verify = findFile(dir, /^Verify-DLSS5Feeder\.ps1$/i);
    }
    Object.assign(out, { feedAddon, feedFx, verify, feedAddonName: `dlss5-feed.addon${bitness}` });
    out.versions.feeder = SOURCES.feeder.version;
  }
  if (needs.includes('lumenite')) {
    n++; step('LumeniteFX shaders');
    let fx = bundle.list('lumenite/Shaders/').filter(p => /\.fx$/i.test(p));
    let fxh = bundle.list('lumenite/Shaders/include/');
    let tex = bundle.list('lumenite/Textures/');
    if (!fx.length) {
      const dir = await ensureUnpacked(cacheRoot, 'lumenite', f => step('LumeniteFX shaders', f));
      fx = listFiles(dir, /\.fx$/i); fxh = listFiles(dir, /\.fxh$/i); tex = listFiles(dir, /\.(png|jpe?g)$/i);
    }
    Object.assign(out, { lumeniteShaders: fx, lumeniteIncludes: fxh, lumeniteTextures: tex });
    out.versions.lumenite = SOURCES.lumenite.version;
  }
  if (needs.includes('headers')) {
    n++; step('ReShade shader headers');
    const bundled = SHADER_HEADERS.map(h => bundle.file('feeder/headers/' + h));
    out.shaderHeaders = bundled.every(Boolean) ? bundled : await ensureShaderHeaders(cacheRoot);
  }
  out.dlls = [];
  if (needs.includes('streamline')) {
    n++; step('DLSS runtime');
    const bundled = bundle.list('streamline/');
    out.dlls = (bundled.length ? bundled : await ensureStreamline(cacheRoot, f => step('DLSS runtime', f)))
      .filter(p => !/^nvngx_dlssnr\.dll$/i.test(path.basename(p))); // universal NR is provisioned separately
  }

  if (route === 'optiscaler') {
    out.ok = !!(out.optiScaler && out.optiXess && out.nvngxNrUniversal);
    return out;
  }
  out.ok = !!out.reshadeDll && !!out.nvngxNrUniversal && (route === 'feeder'
    ? !!(out.feedAddon && out.feedFx && out.lumeniteShaders && out.lumeniteShaders.length && out.dlls.length && out.shaderHeaders)
    : !!out.addon && (route !== 'native+bridge' || !!out.bridge));
  return out;
}

// Where the bundled runtime lives: inside the bundled NeuralScreen app, which loads it from
// its own native folder, so both engines share one 158 MB file.
const NR_REL = 'neuralscreen/native/nvngx_dlssnr.dll';

// The universal neural-rendering runtime (RTX 30/40/50). Bundled first; the download is the
// fallback for a dev checkout. Verified twice: the archive, then the DLL inside it.
async function ensureUniversalRuntime(cacheRoot, onProgress) {
  const bundled = bundle.file(NR_REL);
  if (bundled) return bundled;
  const a = SOURCES.neuralscreen;
  const step = (label, frac) => onProgress && onProgress({ phase: 1, of: 1, label, frac });
  step('Neural-rendering runtime (RTX 30/40/50)');
  const dir = await ensureUnpacked(cacheRoot, 'neuralscreen', f => step('Neural-rendering runtime (RTX 30/40/50)', f));
  const dll = walkFiles(dir).find(p => /[\\/]native[\\/]nvngx_dlssnr\.dll$/i.test(p));
  if (!dll) throw new Error('The NeuralScreen package did not contain native/nvngx_dlssnr.dll.');
  const got = digest(fs.readFileSync(dll));
  if (got !== a.innerSha256) throw new Error(`nvngx_dlssnr.dll checksum mismatch (expected ${a.innerSha256}, got ${got}).`);
  return dll;
}

// Where the DLSS Super Resolution runtime and the Streamline NR plugin live in the payload.
// They come from the Streamline package Refract already bundles, so there is nothing extra to
// download — and nothing for an antivirus to object to on the way in.
const SR_REL = 'streamline/nvngx_dlss.dll';
const SL_NR_REL = 'streamline/sl.dlss_nr.dll';
const SR_VERSION = '310.8.0.0';

// NVIDIA's own DLSS runtimes from the 1-Click payload, hash-checked file by file.
async function ensureDlssRuntimes(cacheRoot, onProgress) {
  const out = { dlss: bundle.file(SR_REL), slNr: bundle.file(SL_NR_REL), version: SR_VERSION };
  if (out.dlss && out.slNr) return out;
  const a = SOURCES.streamline;
  const step = (label, frac) => onProgress && onProgress({ phase: 1, of: 1, label, frac });
  step('DLSS runtimes');
  const dir = await ensureUnpacked(cacheRoot, 'streamline', f => step('DLSS runtimes', f));
  for (const [name, want] of Object.entries(a.inner)) {
    const p = walkFiles(dir).find(f => path.basename(f).toLowerCase() === name.toLowerCase());
    if (!p) throw new Error(`The DLSS runtime package did not contain ${name}.`);
    const got = digest(fs.readFileSync(p));
    if (got !== want) throw new Error(`${name} checksum mismatch (expected ${want}, got ${got}).`);
    if (name === 'nvngx_dlss.dll') out.dlss = p; else out.slNr = p;
  }
  return out;
}

const OPTI_DLL_REL = 'optiscaler/OptiScaler.dll';
const OPTI_XESS_REL = 'optiscaler/libxess.dll';

// OptiScaler's runtime pair (the bridge itself and Intel's XeSS runtime it translates through).
async function ensureOptiScaler(cacheRoot, onProgress) {
  const out = { dll: bundle.file(OPTI_DLL_REL), xess: bundle.file(OPTI_XESS_REL), version: SOURCES.optiscaler.version };
  if (out.dll && out.xess) return out;
  const a = SOURCES.optiscaler;
  const step = (label, frac) => onProgress && onProgress({ phase: 1, of: 1, label, frac });
  step('OptiScaler bridge');
  const dir = await ensureUnpacked(cacheRoot, 'optiscaler', f => step('OptiScaler bridge', f));
  for (const [name, want] of Object.entries(a.inner)) {
    const p = walkFiles(dir).find(f => path.basename(f).toLowerCase() === name.toLowerCase());
    if (!p) throw new Error(`The OptiScaler package did not contain ${name}.`);
    const got = digest(fs.readFileSync(p));
    if (got !== want) throw new Error(`${name} checksum mismatch (expected ${want}, got ${got}).`);
    if (name === 'OptiScaler.dll') out.dll = p; else out.xess = p;
  }
  return out;
}

const UNIVERSAL_NR_SHA256 = SOURCES.neuralscreen.innerSha256;
// Refract 0.2 shipped 1-Click-DLSS5's build: sm_89/sm_120 kernels only and an architecture gate
// that refuses Ampere ("Unsupported GPU architecture 0x170"). Fine on RTX 40/50, useless on RTX 30.
const LEGACY_NR_SHA256 = '4b8d19bc3eff58a084f5eca7489c921501c203450169fb82ff4f649a4482ba05';

module.exports = { ensurePayload, ensureStreamline, ensureFile, ensureUnpacked, ensureUniversalRuntime, ensurePatchedRuntime: ensureUniversalRuntime, ensureDlssRuntimes, ensureOptiScaler, ensureShaderHeaders, listFiles, findFile, walkFiles, SOURCES, SHADER_HEADERS, NR_REL, SR_REL, SL_NR_REL, SR_VERSION, OPTI_DLL_REL, OPTI_XESS_REL, UNIVERSAL_NR_SHA256, LEGACY_NR_SHA256 };
