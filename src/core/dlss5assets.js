'use strict';
// Catalog of every third-party component the DLSS 5 routes need, pinned to a known version,
// downloaded on demand, hash-verified and cached. Refract redistributes none of them.
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
  // RTX 20/30/40 unlock. NVIDIA ships neural rendering enabled only on Blackwell; this is
  // the community "Universal RTX 20/30/40/50 DLSS-NR" build — NVIDIA's nvngx_dlssnr.dll
  // 310.8.0.0 binary-patched in place (same size and version, different hash). It is a
  // modified proprietary binary, so Refract only fetches it when the user turns the unlock
  // on, and equally accepts a file the user supplies themselves.
  dlssnrPatched: {
    url: 'https://github.com/reiluisii/1-Click-DLSS5/releases/download/v3.0.2/1-Click-DLSS5-v3.0.2.zip',
    name: '1-Click-DLSS5-v3.0.2.zip', kind: 'zip', version: '3.0.2',
    sha256: '193e1d90a60c43830b37018efdd1f89590e1959fbc6d0774ebc6e8c6b22fd99f',
    // Verified hash of the extracted nvngx_dlssnr.dll inside that archive.
    innerSha256: '4b8d19bc3eff58a084f5eca7489c921501c203450169fb82ff4f649a4482ba05',
  },
};

const PINNED = require('./dlss5-hashes.json');
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

// Assemble everything a given route needs. onProgress -> {phase, of, label, frac?}
async function ensurePayload(cacheRoot, { bitness = 64, route = 'native' } = {}, onProgress) {
  const rt = require('./reshaderuntime');
  const needs = ['reshade'];
  if (route === 'native' || route === 'native+bridge') needs.push('renodx5');
  if (route === 'native+bridge') needs.push('bridge');
  if (route === 'feeder') needs.push('feeder', 'lumenite', 'streamline');
  const of = needs.length;
  let n = 0;
  const step = (label, frac) => onProgress && onProgress({ phase: n, of, label, frac });

  const out = { ok: false, route, versions: {} };

  n = 1; step('ReShade add-on runtime');
  out.reshadeDll = await rt.ensureReShade(cacheRoot, { addon: true, bitness });

  if (needs.includes('renodx5')) {
    n++; step('RenoDX DLSS 5 add-on');
    const dir = await ensureUnpacked(cacheRoot, 'renodx5', f => step('RenoDX DLSS 5 add-on', f));
    out.addon = findFile(dir, /^renodx-dlss5\.addon64$/i);
    out.addonName = 'renodx-dlss5.addon64';
    out.versions.renodx5 = SOURCES.renodx5.version;
  }
  if (needs.includes('bridge')) {
    n++; step('DX11 DLSS bridge');
    out.bridge = await ensureUnpacked(cacheRoot, 'bridge', f => step('DX11 DLSS bridge', f));
    out.bridgeName = 'dlss5-bridge.addon64';
    out.versions.bridge = SOURCES.bridge.version;
  }
  if (needs.includes('feeder')) {
    n++; step('DLSS 5 Feeder');
    const dir = await ensureUnpacked(cacheRoot, 'feeder', f => step('DLSS 5 Feeder', f));
    out.feedAddon = findFile(dir, new RegExp(`^dlss5-feed\\.addon${bitness}$`, 'i'));
    out.feedAddonName = `dlss5-feed.addon${bitness}`;
    out.feedFx = findFile(dir, /^DLSS5_Feed\.fx$/i);
    out.verify = findFile(dir, /^Verify-DLSS5Feeder\.ps1$/i);
    out.vkLayer = findFile(dir, /^VkLayer_feed_vk\.dll$/i);
    out.vkLayerJson = findFile(dir, /^VkLayer_feed_vk\.json$/i);
    out.versions.feeder = SOURCES.feeder.version;
  }
  if (needs.includes('lumenite')) {
    n++; step('LumeniteFX shaders');
    const dir = await ensureUnpacked(cacheRoot, 'lumenite', f => step('LumeniteFX shaders', f));
    out.lumeniteShaders = listFiles(dir, /\.fx$/i);
    out.lumeniteIncludes = listFiles(dir, /\.fxh$/i);
    out.lumeniteTextures = listFiles(dir, /\.(png|jpe?g)$/i);
    out.versions.lumenite = SOURCES.lumenite.version;
  }
  out.dlls = [];
  if (needs.includes('streamline')) {
    n++; step('DLSS runtime');
    out.dlls = await ensureStreamline(cacheRoot, f => step('DLSS runtime', f));
  }

  out.ok = !!out.reshadeDll && (route === 'feeder'
    ? !!(out.feedAddon && out.feedFx && out.lumeniteShaders && out.lumeniteShaders.length && out.dlls.length)
    : !!out.addon && (route !== 'native+bridge' || !!out.bridge));
  return out;
}

// The patched neural-rendering runtime that lets RTX 20/30/40 run DLSS 5. Only called when
// the user has explicitly enabled the unlock. Verified twice: the archive, then the DLL.
async function ensurePatchedRuntime(cacheRoot, onProgress) {
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

module.exports = { ensurePayload, ensureStreamline, ensureFile, ensureUnpacked, ensurePatchedRuntime, listFiles, findFile, SOURCES };
