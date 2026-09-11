'use strict';
// DLSS 5 installation, universal across the routes the DLSS 5 ecosystem supports.
//
//   native         DX12 + the game already has DLSS -> ReShade add-on build + renodx-dlss5.
//                  The add-on is a post-pass that hooks the game's own NGX/Streamline calls.
//   native+bridge  DX11 + the game already has DLSS -> the above + dlss5-bridge, which
//                  forwards D3D11 DLSS calls to D3D12.
//   feeder         DX11/DX12 with NO DLSS -> dlss5-feed add-on + DLSS5_Feed.fx, with
//                  LumeniteFX supplying motion vectors, plus NVIDIA's NGX runtime.
//   unsupported    Vulkan (ReShade needs a layer, and the add-ons are Direct3D only),
//                  32-bit, and non-DX APIs.
//
// Installs are STRICTLY ADDITIVE:
//   * never overwrite a game's own Streamline/NGX DLLs — they are a version-matched set and
//     replacing or part-mixing them crashes the game before ReShade even loads;
//   * never remove or replace an add-on the user already has;
//   * never clobber an existing ReShade.ini.
// Everything added is tracked in refract-feeder.json so restore is exact.
const fs = require('fs');
const path = require('path');
const rt = require('./reshaderuntime');
const assets = require('./dlss5assets');
const cfg = require('./feederconfig');
const { proxyName } = require('./peimports');
const bundle = require('./bundle');

const MANIFEST = 'refract-feeder.json';
const BAK = '.refract-feeder-bak';

const DLSS_RUNTIME = /^(nvngx_.*\.dll|sl\..*\.dll)$/i;
const RENODX_ADDON = /^renodx.*\.addon(64|32)$/i;
const FEED_ADDON = /^dlss5-feed\.addon(64|32)$/i;
const BRIDGE_ADDON = /(dlss5[-_ ]?bridge|dx11[-_ ]?bridge).*\.addon(64|32)$/i;
const ANY_ADDON = /\.addon(64|32)?$/i;
// Add-ons that all try to drive DLSS. More than one at once is the documented conflict
// behind "it's listed but does nothing": they fight over the same NGX hooks.
const DLSS_ADDON = /(dlss|ngx)/i;
const RESHADE_PROXIES = ['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d10.dll', 'd3d9.dll', 'd3d8.dll', 'ddraw.dll', 'opengl32.dll', 'dinput8.dll'];

function listDir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// Hashing a 160 MB DLL on every status check would stall the UI; memo by size + mtime.
const hashMemo = new Map();
function hashOf(p) {
  try {
    const st = fs.statSync(p);
    const k = `${p}|${st.size}|${st.mtimeMs}`;
    if (!hashMemo.has(k)) hashMemo.set(k, bundle.sha256File(p));
    return hashMemo.get(k);
  } catch { return null; }
}

// Does this folder still need the neural-rendering runtime put right? (see provisionNr)
function nrNeeded(exeDir, { gpu, unlock } = {}) {
  const tier = (gpu && gpu.dlss5) || 'unknown';
  if (tier === 'unsupported' || (unlock && unlock.enabled === false)) return false;
  const dest = path.join(exeDir, 'nvngx_dlssnr.dll');
  if (!fs.existsSync(dest)) return true;
  if (tier !== 'patch') return false;
  const own = unlock && unlock.source === 'own' && unlock.runtime && fs.existsSync(unlock.runtime) ? unlock.runtime : null;
  return hashOf(dest) !== (own ? hashOf(own) : assets.UNIVERSAL_NR_SHA256);
}

function inspect(exeDir) {
  const names = listDir(exeDir);
  const runtime = names.filter(n => DLSS_RUNTIME.test(n));
  const proxy = names.find(n => RESHADE_PROXIES.includes(n.toLowerCase()) && rt.isReShade(path.join(exeDir, n)));
  const dlssAddons = names.filter(n => ANY_ADDON.test(n) && DLSS_ADDON.test(n));
  return {
    dlssRuntime: runtime,
    // Something for a post-pass to hook: NVIDIA's NGX runtime or Streamline's DLSS plugin.
    hasDlss: runtime.some(n => /^nvngx_dlss\.dll$/i.test(n) || /^sl\.dlss\.dll$/i.test(n)),
    renodxAddons: names.filter(n => RENODX_ADDON.test(n)),
    feedAddons: names.filter(n => FEED_ADDON.test(n)),
    bridgeAddons: names.filter(n => BRIDGE_ADDON.test(n)),
    addons: names.filter(n => ANY_ADDON.test(n)),
    dlssAddons,
    conflicts: dlssAddons.length > 1 ? dlssAddons : [],
    reshadeProxy: proxy || null,
    reshadeIsAddonBuild: proxy ? rt.isAddonReShade(path.join(exeDir, proxy)) : false,
  };
}

// Which DLSS 5 route fits this game?
function routeFor({ api = 'dxgi', dx = null, hasDlss = false } = {}) {
  if (api === 'vulkan') {
    return { route: null, reason: 'This is a Vulkan game. ReShade hooks Vulkan through an installed layer rather than a proxy DLL, and the DLSS 5 add-ons are Direct3D only.' };
  }
  if (api && api !== 'dxgi') {
    return { route: null, reason: `This is a ${api} game. DLSS 5 needs DirectX 11 or 12.` };
  }
  if (hasDlss) return { route: dx === 11 ? 'native+bridge' : 'native' };
  return { route: 'feeder' };
}

const ROUTE_LABEL = {
  native: 'DLSS 5 neural rendering over this game\'s own DLSS',
  'native+bridge': 'DLSS 5 over this DX11 game\'s DLSS, via the D3D11→D3D12 bridge',
  feeder: 'DLSS 5 Feeder — this game has no DLSS, so motion vectors are generated for it',
};

function plan(exeDir, opts = {}) {
  const { bitness = 64, api = 'dxgi', dx = null, gpu = null, unlock = null } = opts;
  const i = inspect(exeDir);
  const warnings = [];
  if (i.conflicts.length) {
    warnings.push(`${i.conflicts.length} DLSS add-ons are installed here (${i.conflicts.join(', ')}). They fight over the same NGX hooks and unload each other — keep one and move the rest out.`);
  }
  if (gpu && gpu.dlss5 === 'unsupported') {
    return { ok: false, route: null, actions: [], warnings, inspect: i,
      reason: `${gpu.name || 'This GPU'} has no DLSS hardware. DLSS 5 needs an RTX card.` };
  }
  if (gpu && gpu.dlss5 === 'patch' && unlock && unlock.enabled === false) {
    warnings.push(`RTX ${gpu.series} (${gpu.arch}): the universal neural-rendering runtime is switched off, so DLSS 5 will stay off on this card. Turn it back on in the DLSS 5 panel.`);
  }
  if (bitness !== 64) return { ok: false, route: null, actions: [], warnings, inspect: i, reason: 'DLSS 5 is 64-bit only; this game is 32-bit.' };

  const r = routeFor({ api, dx, hasDlss: i.hasDlss });
  if (!r.route) return { ok: false, route: null, actions: [], warnings, inspect: i, reason: r.reason };

  const actions = [];
  if (!i.reshadeProxy) actions.push('reshade-install');
  else if (!i.reshadeIsAddonBuild) actions.push('reshade-upgrade');
  if (r.route === 'feeder') {
    if (!i.feedAddons.length) actions.push('feeder-install');
  } else {
    if (!i.renodxAddons.length) actions.push('addon-install');
    if (r.route === 'native+bridge' && !i.bridgeAddons.length) actions.push('bridge-install');
  }
  // Without nvngx_dlssnr.dll the add-on loads, hooks DLSS, and then does nothing at all.
  if (nrNeeded(exeDir, { gpu, unlock })) actions.push('nr-runtime');

  if (!actions.length) {
    const tail = warnings.length ? ' ' + warnings[0] : ' If it still does nothing, turn DLSS on in the game\'s graphics settings.';
    return { ok: false, already: true, route: r.route, actions, warnings, inspect: i,
      reason: `DLSS 5 is already set up here (ReShade add-on build + ${(i.dlssAddons.join(', ') || 'add-on')}).` + tail };
  }
  const repair = status(exeDir).installed;
  return { ok: true, route: r.route, label: ROUTE_LABEL[r.route], actions, warnings, inspect: i, repair,
    reason: actions.length === 1 && actions[0] === 'nr-runtime'
      ? 'The neural-rendering runtime (nvngx_dlssnr.dll) is missing or the wrong build for this GPU, so DLSS 5 stays off.' : undefined };
}

function eligible(o = {}) { return plan(o.exeDir, o); }

async function track(man, dest, kind) {
  const same = e => e.path.toLowerCase() === dest.toLowerCase();
  if (man.added.some(same) || man.replaced.some(same)) return; // already ours from an earlier run
  if (fs.existsSync(dest)) {
    const bak = dest + BAK;
    if (!fs.existsSync(bak)) await fs.promises.copyFile(dest, bak);
    man.replaced.push({ path: dest, kind });
  } else {
    man.added.push({ path: dest, kind });
  }
}
async function copyInto(man, src, dest, kind) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await track(man, dest, kind);
  await fs.promises.copyFile(src, dest);
}
async function writeInto(man, dest, text, kind) {
  await track(man, dest, kind);
  await fs.promises.writeFile(dest, text);
}
async function read(p) { try { return await fs.promises.readFile(p, 'utf8'); } catch { return ''; } }

async function install(game, payload, { cacheRoot, onProgress, gpu = null, unlock = null } = {}) {
  const exeDir = path.dirname(game.exe);
  const api = game.api || 'dxgi';
  const bitness = game.bitness || 64;
  const dx = game.dx || null;

  const gate = plan(exeDir, { bitness, api, dx, gpu, unlock });
  if (!gate.ok) throw new Error(gate.reason);
  const before = gate.inspect;
  const route = gate.route;

  if (!payload || !payload.ok || payload.route !== route) {
    payload = await assets.ensurePayload(cacheRoot, { bitness, route }, onProgress);
  }
  if (!payload.ok) throw new Error('Could not prepare the DLSS 5 components for the ' + route + ' route.');

  // A repair/update extends the existing manifest so one restore still undoes everything.
  let man = null;
  try { man = JSON.parse(fs.readFileSync(path.join(exeDir, MANIFEST), 'utf8')); } catch {}
  if (!man) {
    man = { version: 5, route, exeDir, added: [], replaced: [],
      // Top-level names present before install, so restore can also remove what ReShade and
      // the add-ons create at runtime (logs, a generated preset) when Refract installed ReShade.
      before: listDir(exeDir) };
  }
  Object.assign(man, { version: 5, route, at: Date.now(), notes: [] });
  man.added = man.added || []; man.replaced = man.replaced || [];

  // 1. ReShade with FULL add-on support (a limited build silently refuses to load add-ons).
  if (gate.actions.includes('reshade-install')) {
    await copyInto(man, payload.reshadeDll, path.join(exeDir, proxyName(api)), 'reshade');
    man.notes.push('Installed the ReShade add-on build as ' + proxyName(api) + '.');
  } else if (gate.actions.includes('reshade-upgrade')) {
    await copyInto(man, payload.reshadeDll, path.join(exeDir, before.reshadeProxy), 'reshade');
    man.notes.push('Upgraded ' + before.reshadeProxy + ' from the limited ReShade build to the add-on build.');
  } else {
    man.notes.push('Kept the existing ReShade add-on build (' + before.reshadeProxy + ').');
  }

  if (route === 'feeder') {
    await installFeeder(man, exeDir, payload, before);
  } else {
    if (gate.actions.includes('addon-install')) {
      await copyInto(man, payload.addon, path.join(exeDir, payload.addonName), 'addon');
      man.notes.push(`Added ${payload.addonName} (RenoDX DLSS 5 ${payload.versions.renodx5}).`);
    } else {
      man.notes.push('Kept your existing add-on (' + before.renodxAddons.join(', ') + ').');
    }
    if (gate.actions.includes('bridge-install')) {
      await copyInto(man, payload.bridge, path.join(exeDir, payload.bridgeName), 'bridge');
      man.notes.push(`Added ${payload.bridgeName} (DX11 bridge ${payload.versions.bridge}).`);
    }
    // The game's own DLSS/Streamline set is what the add-on hooks — never touch it.
    man.notes.push(`Left the game's own DLSS/Streamline runtime untouched (${before.dlssRuntime.length} files).`);
    await writeIni(man, exeDir, { feeder: false });
  }

  await provisionNr(man, exeDir, payload, { gpu, unlock, cacheRoot, onProgress });

  await fs.promises.writeFile(path.join(exeDir, MANIFEST), JSON.stringify(man, null, 2));
  return { ...status(exeDir), route, label: ROUTE_LABEL[route], notes: man.notes };
}

// Every DLSS 5 route needs NVIDIA's neural-rendering runtime, nvngx_dlssnr.dll, next to the
// game. Stock games don't ship it — without it the add-on logs "nvngx_dlssnr.dll was not
// found ... NR stays off" and the game looks untouched. Refract provides the universal
// RTX 20/30/40/50 build (verified running on RTX 50; the stock NVIDIA file only runs on
// RTX 50). Rules:
//   missing                         -> add the universal build (or the user's own file)
//   present, RTX 20/30/40           -> must be the universal (or user's) build; replace, backed up
//   present, RTX 50 / unknown GPU   -> keep whatever works there
//   user switched the runtime off   -> leave the folder alone and say why NR stays off
async function provisionNr(man, exeDir, payload, { gpu, unlock, cacheRoot, onProgress }) {
  const tier = (gpu && gpu.dlss5) || 'unknown';
  if (tier === 'unsupported') return;
  const dest = path.join(exeDir, 'nvngx_dlssnr.dll');
  const own = unlock && unlock.source === 'own' && unlock.runtime && fs.existsSync(unlock.runtime) ? unlock.runtime : null;
  const optedOut = unlock && unlock.enabled === false;
  const label = gpu && gpu.series ? `RTX ${gpu.series}${gpu.arch ? ' (' + gpu.arch + ')' : ''}` : 'this GPU';
  if (optedOut) {
    man.notes.push(fs.existsSync(dest) ? 'Kept the game\'s nvngx_dlssnr.dll (universal runtime switched off).'
      : `No neural-rendering runtime installed (switched off) — DLSS 5 stays off on ${label}.`);
    return;
  }
  if (fs.existsSync(dest)) {
    if (tier !== 'patch') { man.notes.push('Kept the game\'s existing nvngx_dlssnr.dll.'); return; }
    const want = own ? bundle.sha256File(own) : assets.UNIVERSAL_NR_SHA256;
    if (bundle.sha256File(dest) === want) { man.notes.push(`nvngx_dlssnr.dll is already the build ${label} needs.`); return; }
  }
  const src = own || payload.nvngxNrUniversal || await assets.ensurePatchedRuntime(cacheRoot, onProgress);
  await copyInto(man, src, dest, 'runtime-nr');
  man.notes.push(`Installed the ${own ? 'your' : 'universal'} neural-rendering runtime (nvngx_dlssnr.dll) for ${label}.`);
}

// ReShade.ini: create a tuned one, or add only what is missing to the user's (backed up).
async function writeIni(man, exeDir, { feeder }) {
  const iniPath = path.join(exeDir, 'ReShade.ini');
  const cur = await read(iniPath);
  const next = feeder ? cfg.feederReShade(cur) : cfg.dlss5ReShade(cur);
  if (fs.existsSync(iniPath) && next === cur) { man.notes.push('Kept the existing ReShade.ini.'); return; }
  await writeInto(man, iniPath, next, 'config');
  man.notes.push(fs.existsSync(iniPath + BAK) ? 'Added DLSS 5 settings to your ReShade.ini (original backed up).' : 'Wrote a tuned ReShade.ini.');
}

// Files ReShade and the DLSS 5 add-ons create while the game runs. Only removed on restore
// when Refract installed ReShade itself and the file wasn't there before.
const RUNTIME_ARTIFACT = /^(ReShade\.log\d*|ReShadePreset\.ini|ReShade\.ini\.tmp|renodx[^\\/]*\.(log|ini|json)|dlss5[^\\/]*\.(log|cfg))$/i;

async function restore(exeDir) {
  const manPath = path.join(exeDir, MANIFEST);
  let man;
  try { man = JSON.parse(await fs.promises.readFile(manPath, 'utf8')); } catch { return status(exeDir); }
  for (const e of man.added || []) { try { await fs.promises.rm(e.path, { force: true }); } catch {} }
  for (const e of man.replaced || []) {
    const bak = e.path + BAK;
    try { if (fs.existsSync(bak)) { await fs.promises.copyFile(bak, e.path); await fs.promises.rm(bak, { force: true }); } } catch {}
  }
  const installedReShade = (man.added || []).some(e => e.kind === 'reshade');
  if (installedReShade && Array.isArray(man.before)) {
    const before = new Set(man.before.map(n => n.toLowerCase()));
    for (const n of listDir(exeDir)) {
      if (!before.has(n.toLowerCase()) && RUNTIME_ARTIFACT.test(n)) { try { await fs.promises.rm(path.join(exeDir, n), { force: true }); } catch {} }
    }
  }
  await pruneEmpty(path.join(exeDir, 'reshade-shaders'));
  await fs.promises.rm(manPath, { force: true });
  return status(exeDir);
}

async function pruneEmpty(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  for (const name of entries) {
    const p = path.join(dir, name);
    if ((await fs.promises.stat(p)).isDirectory()) await pruneEmpty(p);
  }
  try { if ((await fs.promises.readdir(dir)).length === 0) await fs.promises.rmdir(dir); } catch {}
}

function status(exeDir) {
  try {
    const man = JSON.parse(fs.readFileSync(path.join(exeDir, MANIFEST), 'utf8'));
    return { installed: true, at: man.at, route: man.route, files: (man.added || []).length + (man.replaced || []).length };
  } catch { return { installed: false }; }
}

module.exports = { install, restore, status, eligible, plan, inspect, routeFor, nrNeeded, ROUTE_LABEL, MANIFEST, ensurePayload: assets.ensurePayload };
