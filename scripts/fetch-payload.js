'use strict';
// Build step (runs before electron-builder): fetch every third-party component from the
// pinned, hash-verified catalog in src/core/dlss5assets.js and lay it out under ./payload,
// which electron-builder ships as resources/payload. ./payload is never committed to git.
//
//   node scripts/fetch-payload.js            # reuse the download cache, rebuild ./payload
//
// Cache: %APPDATA%\Refract (shared with the app) unless REFRACT_BUILD_CACHE is set.
const fs = require('fs');
const path = require('path');
const assets = require('../src/core/dlss5assets');
const rt = require('../src/core/reshaderuntime');
const { sha256File } = require('../src/core/bundle');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'payload');
const CACHE = process.env.REFRACT_BUILD_CACHE || path.join(process.env.APPDATA || ROOT, 'Refract');

const files = {};
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

  log('Universal RTX 20/30/40/50 DLSS-NR runtime');
  put(await assets.ensurePatchedRuntime(CACHE, prog('dlss-nr')), 'ngx/nvngx_dlssnr.dll');

  log('Streamline / NGX runtime (feeder route)');
  for (const f of await assets.ensureStreamline(CACHE)) {
    if (/^nvngx_dlssnr\.dll$/i.test(path.basename(f))) continue; // the universal build above replaces the stock one
    put(f, 'streamline/' + path.basename(f));
  }

  const components = Object.fromEntries(Object.entries(assets.SOURCES).map(([k, v]) => [k, v.version]));
  components.reshade = '6.8.0';
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), components, files }, null, 2));
  const bytes = Object.keys(files).reduce((s, r) => s + fs.statSync(path.join(OUT, ...r.split('/'))).size, 0);
  log(`payload ready: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}`);
})().catch(e => { console.error('fetch-payload failed:', e && e.stack || e); process.exit(1); });
