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
  if (gpu && gpu.dlss5 === 'patch' && !(unlock && unlock.enabled)) {
    warnings.push(`RTX ${gpu.series} (${gpu.arch}): DLSS 5 neural rendering is only enabled on RTX 50 by default. Turn on the RTX 20/30/40 unlock in Settings and supply your own patched nvngx_dlssnr.dll to run it here.`);
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

  if (!actions.length) {
    const tail = warnings.length ? ' ' + warnings[0] : ' If it still does nothing, turn DLSS on in the game\'s graphics settings.';
    return { ok: false, already: true, route: r.route, actions, warnings, inspect: i,
      reason: `DLSS 5 is already set up here (ReShade add-on build + ${(i.dlssAddons.join(', ') || 'add-on')}).` + tail };
  }
  return { ok: true, route: r.route, label: ROUTE_LABEL[r.route], actions, warnings, inspect: i };
}

function eligible(o = {}) { return plan(o.exeDir, o); }

async function track(man, dest, kind) {
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

  const man = { version: 4, route, exeDir, at: Date.now(), added: [], replaced: [], notes: [] };

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
    // The game's own DLSS runtime is what the add-on hooks — never touch it.
    man.notes.push(`Left the game's own DLSS/Streamline runtime untouched (${before.dlssRuntime.length} files).`);
    const iniPath = path.join(exeDir, 'ReShade.ini');
    if (!fs.existsSync(iniPath)) await writeInto(man, iniPath, cfg.gameReShade(''), 'config');
    else man.notes.push('Kept the existing ReShade.ini.');
  }

  await applyUnlock(man, exeDir, { gpu, unlock, cacheRoot, onProgress });

  await fs.promises.writeFile(path.join(exeDir, MANIFEST), JSON.stringify(man, null, 2));
  return { ...status(exeDir), route, label: ROUTE_LABEL[route], notes: man.notes };
}

// RTX 20/30/40 (Turing/Ampere/Ada) can run DLSS 5 neural rendering with a patched
// nvngx_dlssnr.dll. Refract never ships or downloads that file — the user points at their
// own, the same condition the upstream unlock mods state. RTX 50 needs nothing here.
async function applyUnlock(man, exeDir, { gpu, unlock, cacheRoot, onProgress }) {
  if (!gpu || gpu.dlss5 !== 'patch') return;
  if (!unlock || !unlock.enabled) {
    man.notes.push(`RTX ${gpu.series} (${gpu.arch}): neural rendering stays off until you enable the RTX 20/30/40 unlock in Settings.`);
    return;
  }
  let src = unlock.runtime && fs.existsSync(unlock.runtime) ? unlock.runtime : null;
  let origin = 'your own file';
  if (!src) {
    if (unlock.source === 'own') {
      throw new Error('The RTX 20/30/40 unlock is set to use your own file, but no patched nvngx_dlssnr.dll is selected. Choose one in the DLSS 5 panel.');
    }
    src = await assets.ensurePatchedRuntime(cacheRoot, onProgress);
    origin = 'the community Universal RTX 20/30/40/50 build';
  }
  await copyInto(man, src, path.join(exeDir, 'nvngx_dlssnr.dll'), 'unlock');
  man.notes.push(`Installed a patched nvngx_dlssnr.dll (${origin}) so DLSS 5 runs on RTX ${gpu.series} (${gpu.arch}). Expect a large frame-rate cost versus RTX 50.`);
}

// Games with no DLSS: the feeder add-on plus the effects that generate motion vectors.
async function installFeeder(man, exeDir, payload, before) {
  const shaders = path.join(exeDir, 'reshade-shaders', 'Shaders');
  const textures = path.join(exeDir, 'reshade-shaders', 'Textures');

  await copyInto(man, payload.feedAddon, path.join(exeDir, payload.feedAddonName), 'addon');
  await copyInto(man, payload.feedFx, path.join(shaders, path.basename(payload.feedFx)), 'shader');
  for (const fx of payload.lumeniteShaders) await copyInto(man, fx, path.join(shaders, path.basename(fx)), 'shader');
  for (const fxh of payload.lumeniteIncludes) await copyInto(man, fxh, path.join(shaders, 'include', path.basename(fxh)), 'shader');
  for (const tex of payload.lumeniteTextures) await copyInto(man, tex, path.join(textures, path.basename(tex)), 'shader');
  man.notes.push(`Added the DLSS 5 Feeder ${payload.versions.feeder} and LumeniteFX motion-vector shaders.`);

  // This game has no DLSS of its own, so it needs NVIDIA's runtime — but still only the
  // files it is actually missing, and never over a set the game already ships.
  if (before.dlssRuntime.length) {
    man.notes.push(`Left the game's existing runtime files untouched (${before.dlssRuntime.length}).`);
  } else {
    for (const dll of payload.dlls) await copyInto(man, dll, path.join(exeDir, path.basename(dll)), 'runtime');
    man.notes.push(`Installed the DLSS runtime (${payload.dlls.length} files).`);
  }

  const iniPath = path.join(exeDir, 'ReShade.ini');
  await writeInto(man, iniPath, cfg.feederReShade(await read(iniPath)), 'config');
  const presetPath = path.join(exeDir, 'ReShadePreset.ini');
  await writeInto(man, presetPath, cfg.feederPreset(await read(presetPath)), 'config');
  const feedCfg = path.join(exeDir, 'dlss5-feed.cfg');
  await writeInto(man, feedCfg, cfg.feed(await read(feedCfg)), 'config');
  if (payload.verify) await copyInto(man, payload.verify, path.join(exeDir, path.basename(payload.verify)), 'diagnostics');
}

async function restore(exeDir) {
  const manPath = path.join(exeDir, MANIFEST);
  let man;
  try { man = JSON.parse(await fs.promises.readFile(manPath, 'utf8')); } catch { return status(exeDir); }
  for (const e of man.added || []) { try { await fs.promises.rm(e.path, { force: true }); } catch {} }
  for (const e of man.replaced || []) {
    const bak = e.path + BAK;
    try { if (fs.existsSync(bak)) { await fs.promises.copyFile(bak, e.path); await fs.promises.rm(bak, { force: true }); } } catch {}
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

module.exports = { install, restore, status, eligible, plan, inspect, routeFor, ROUTE_LABEL, ensurePayload: assets.ensurePayload };
