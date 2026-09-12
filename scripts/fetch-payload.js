'use strict';
// Build step (runs before electron-builder): fetch every third-party component from the
// pinned, hash-verified catalog in src/core/dlss5assets.js and lay it out under ./payload,
// which electron-builder ships as resources/payload. ./payload is never committed to git.
//
//   node scripts/fetch-payload.js            # reuse the download cache, rebuild ./payload
//
// Cache: %APPDATA%\Refract (shared with the app) unless REFRACT_BUILD_CACHE is set. To skip the
// 224 MB NeuralScreen download, drop neuralscreen-v1.6.0-full.zip into <cache>\dlss5\ (hash-checked).
const fs = require('fs');
const path = require('path');
const assets = require('../src/core/dlss5assets');
const mfgassets = require('../src/core/mfgassets');
const rt = require('../src/core/reshaderuntime');
const { sha256File } = require('../src/core/bundle');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'payload');
const CACHE = process.env.REFRACT_BUILD_CACHE || path.join(process.env.APPDATA || ROOT, 'Refract');

const files = {};
// REFRACT_LITE=1 builds the redistributable payload: everything except NVIDIA's
// nvngx_dlssnr.dll, which Refract downloads from NeuralScreen's release on first use.
const LITE = process.env.REFRACT_LITE === '1' || process.argv.includes('--lite');

function put(src, rel) {
  if (!src || !fs.existsSync(src)) throw new Error('missing source for ' + rel);
  const dest = path.join(OUT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  files[rel] = sha256File(dest);
}
const log = m => process.stdout.write(m + '\n');
const prog = label => {
  let last = -1;
  return p => {
    if (!p || p.frac == null) return;
    const pct = Math.floor(p.frac * 4) * 25; // log each quarter once
    if (pct > last) { last = pct; log(`  ${label} ${pct}%`); }
  };
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  log('ReShade 6.8.0 (add-on build)');
  put(await rt.ensureReShade(CACHE, { addon: true, bitness: 64 }), 'reshade/ReShade64.dll');

  log('RenoDX DLSS 5 add-on ' + assets.SOURCES.renodx5.version);
  const renodx = await assets.ensureUnpacked(CACHE, 'renodx5');
  put(assets.findFile(renodx, /^renodx-dlss5\.addon64$/i), 'addons/renodx-dlss5.addon64');

  log('DX11 bridge ' + assets.SOURCES.bridge.version);
  put(await assets.ensureUnpacked(CACHE, 'bridge'), 'addons/dlss5-bridge.addon64');

  log('DLSS5-Feeder ' + assets.SOURCES.feeder.version);
  const feeder = await assets.ensureUnpacked(CACHE, 'feeder');
  put(assets.findFile(feeder, /^dlss5-feed\.addon64$/i), 'feeder/dlss5-feed.addon64');
  put(assets.findFile(feeder, /^DLSS5_Feed\.fx$/i), 'feeder/DLSS5_Feed.fx');
  put(assets.findFile(feeder, /^Verify-DLSS5Feeder\.ps1$/i), 'feeder/Verify-DLSS5Feeder.ps1');

  log('ReShade shader headers (crosire/reshade-shaders slim)');
  for (const f of await assets.ensureShaderHeaders(CACHE)) put(f, 'feeder/headers/' + path.basename(f));

  log('LumeniteFX');
  const lum = await assets.ensureUnpacked(CACHE, 'lumenite');
  for (const f of assets.listFiles(lum, /\.fx$/i)) put(f, 'lumenite/Shaders/' + path.basename(f));
  for (const f of assets.listFiles(lum, /\.fxh$/i)) put(f, 'lumenite/Shaders/include/' + path.basename(f));
  for (const f of assets.listFiles(lum, /\.(png|jpe?g)$/i)) put(f, 'lumenite/Textures/' + path.basename(f));

  log('OptiScaler ' + assets.SOURCES.optiscaler.version + ' (FSR 2/3 and XeSS games -> DLSS 5)');
  const opti = await assets.ensureOptiScaler(CACHE, prog('optiscaler'));
  put(opti.dll, assets.OPTI_DLL_REL);
  put(opti.xess, assets.OPTI_XESS_REL);

  // NeuralScreen: the screen-space engine, and the source of the universal RTX 30/40/50
  // neural-rendering runtime both engines use (one copy, at neuralscreen/native/).
  log('NeuralScreen ' + assets.SOURCES.neuralscreen.version + ' (screen engine + universal RTX 30/40/50 DLSS-NR runtime)');
  await assets.ensureUniversalRuntime(CACHE, prog('neuralscreen')); // downloads + verifies the DLL inside
  const ns = await assets.ensureUnpacked(CACHE, 'neuralscreen');
  for (const f of assets.walkFiles(ns)) {
    const rel = path.relative(ns, f).split(path.sep).join('/');
    if (/^(\.extracted|NeuralScreen\.log|recordings\/|screenshots\/)/i.test(rel)) continue;
    // The public build leaves NVIDIA's neural-rendering runtime out of the installer: it is
    // not NVIDIA's to redistribute. The app fetches and hash-checks it from NeuralScreen's own
    // release on first use, so the only difference a user sees is one download.
    if (LITE && 'neuralscreen/' + rel === assets.NR_REL) continue;
    put(f, 'neuralscreen/' + rel);
  }
  if (LITE) {
    if (files[assets.NR_REL]) throw new Error('lite payload still contains ' + assets.NR_REL);
    log('lite build: ' + assets.NR_REL + ' left out; Refract downloads it on first use');
  } else if (files[assets.NR_REL] !== assets.UNIVERSAL_NR_SHA256) {
    throw new Error('bundled nvngx_dlssnr.dll is not the universal build');
  }

  // Streamline: the feeder route's runtime set, and the source of the DLSS Super Resolution
  // runtime (nvngx_dlss.dll 310.8) and Streamline's NR plugin used on the native routes.
  log('Streamline / NGX runtimes ' + assets.SR_VERSION);
  const dlssRuntimes = await assets.ensureDlssRuntimes(CACHE, prog('dlss runtimes'));
  for (const f of await assets.ensureStreamline(CACHE)) {
    if (/^nvngx_dlssnr\.dll$/i.test(path.basename(f))) continue; // the universal build (neuralscreen/native) replaces the stock one
    put(f, 'streamline/' + path.basename(f));
  }
  for (const rel of [assets.SR_REL, assets.SL_NR_REL]) {
    if (!files[rel]) throw new Error('the Streamline package did not provide ' + rel);
  }
  if (files[assets.SR_REL] !== '' && !dlssRuntimes.dlss) throw new Error('DLSS runtime check failed');

  // Multi Frame Generation for RTX 30/40: the dlssg_sm86 engine plus the Reflex pieces that are
  // the only real latency lever. Sourced from the pinned dlss-unlocked release because
  // dlssg_for_sm86 itself publishes no binaries. Each file is hash-checked on extraction.
  log('Multi Frame Generation (dlssg_sm86 + Reflex, RTX 30/40)');
  if (!assets.SOURCES[mfgassets.SOURCE.key]) assets.SOURCES[mfgassets.SOURCE.key] = mfgassets.SOURCE;
  const mfgDir = await assets.ensureUnpacked(CACHE, mfgassets.SOURCE.key, prog('mfg'));
  const mfgFiles = await mfgassets.extractFrom(mfgDir);
  for (const [rel, src] of Object.entries(mfgFiles)) put(src, rel);
  for (const f of mfgassets.FILES) {
    if (!f.optional && !files[f.rel]) throw new Error('the MFG payload is missing ' + f.rel);
  }

  const components = Object.fromEntries(Object.entries(assets.SOURCES).map(([k, v]) => [k, v.version]));
  components.reshade = '6.8.0';
  components.lite = LITE;
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), components, files }, null, 2));
  const bytes = Object.keys(files).reduce((s, r) => s + fs.statSync(path.join(OUT, ...r.split('/'))).size, 0);
  log(`payload ready: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
})().catch(e => { console.error('fetch-payload failed:', e && e.stack || e); process.exit(1); });
