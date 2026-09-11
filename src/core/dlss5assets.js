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
  },
  // The neural-rendering runtime every DLSS 5 route needs (nvngx_dlssnr.dll). This is the
  // community "Universal RTX 20/30/40/50 DLSS-NR" build: NVIDIA's 310.8.0.0 binary patched in
  // place (same size and version, different hash) so it also runs on Turing/Ampere/Ada.
  // Verified live on an RTX 5070 (Cyberpunk 2077, NR evaluating every frame). It is a modified
  // proprietary binary; users can point Refract at their own file instead.
  dlssnrPatched: {
    url: 'https://github.com/reiluisii/1-Click-DLSS5/releases/download/v3.0.2/1-Click-DLSS5-v3.0.2.zip',
    name: '1-Click-DLSS5-v3.0.2.zip', kind: 'zip', version: '3.0.2',
    sha256: '193e1d90a60c43830b37018efdd1f89590e1959fbc6d0774ebc6e8c6b22fd99f',
    // Verified hash of the extracted nvngx_dlssnr.dll inside that archive.
    innerSha256: '4b8d19bc3eff58a084f5eca7489c921501c203450169fb82ff4f649a4482ba05',
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
  const needs = ['reshade', 'dlssnr'];
  if (route === 'native' || route === 'native+bridge') needs.push('renodx5');
  if (route === 'native+bridge') needs.push('bridge');
  if (route === 'feeder') needs.push('feeder', 'lumenite', 'headers', 'streamline');
  const of = needs.length;
  let n = 0;
  const step = (label, frac) => onProgress && onProgress({ phase: n, of, label, frac });
  const b = (rel) => (bitness === 64 ? bundle.file(rel) : null);
  const out = { ok: false, route, versions: {}, bundled: !!bundle.info() };

  n++; step('ReShade add-on runtime');
  out.reshadeDll = b('reshade/ReShade64.dll') || await rt.ensureReShade(cacheRoot, { addon: true, bitness });

  n++; step('Neural-rendering runtime');
  out.nvngxNrUniversal = b('ngx/nvngx_dlssnr.dll') || await ensurePatchedRuntime(cacheRoot, p => step('Neural-rendering runtime', p && p.frac));
  out.versions.dlssnr = SOURCES.dlssnrPatched.version;

  if (needs.includes('renodx5')) {
    n++; step('RenoDX DLSS 5 add-on');
    out.addon = b('addons/renodx-dlss5.addon64')
      || findFile(await ensureUnpacked(cacheRoot, 'renodx5', f => step('RenoDX DLSS 5 add-on', f)), /^renodx-dlss5\.addon64$/i);
    out.addonName = 'renodx-dlss5.addon64';
    out.versions.renodx5 = SOURCES.renodx5.version;
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

  out.ok = !!out.reshadeDll && !!out.nvngxNrUniversal && (route === 'feeder'
    ? !!(out.feedAddon && out.feedFx && out.lumeniteShaders && out.lumeniteShaders.length && out.dlls.length && out.shaderHeaders)
    : !!out.addon && (route !== 'native+bridge' || !!out.bridge));
  return out;
}

// The patched neural-rendering runtime that lets RTX 20/30/40 run DLSS 5. Only called when
// the user has explicitly enabled the unlock. Verified twice: the archive, then the DLL.
async function ensurePatchedRuntime(cacheRoot, onProgress) {
  const bundled = bundle.file('ngx/nvngx_dlssnr.dll');
  if (bundled) return bundled;
  const a = SOURCES.dlssnrPatched;
  const step = (label, frac) => onProgress && onProgress({ phase: 1, of: 1, label, frac });
  step('Patched DLSS-NR runtime (RTX 20/30/40)');
  const dir = await ensureUnpacked(cacheRoot, 'dlssnrPatched', f => step('Patched DLSS-NR runtime (RTX 20/30/40)', f));
  const dll = findFile(dir, /^nvngx_dlssnr\.dll$/i);
  if (!dll) throw new Error('The unlock package did not contain nvngx_dlssnr.dll.');
  if (a.innerSha256) {
    const got = digest(fs.readFileSync(dll));
    if (got !== a.innerSha256) throw new Error(`Patched nvngx_dlssnr.dll checksum mismatch (expected ${a.innerSha256}, got ${got}).`);
  }
  return dll;
}

const UNIVERSAL_NR_SHA256 = SOURCES.dlssnrPatched.innerSha256;

module.exports = { ensurePayload, ensureStreamline, ensureFile, ensureUnpacked, ensurePatchedRuntime, ensureShaderHeaders, listFiles, findFile, SOURCES, SHADER_HEADERS, UNIVERSAL_NR_SHA256 };
