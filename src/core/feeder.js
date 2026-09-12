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
const peversion = require('./peversion');
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
// What the game already has to upscale with. OptiScaler can turn any of these into DLSS calls.
const FSR_FILE = /(^|[^a-z])fsr[23]|amd_fidelityfx|ffx_fsr/i;
const XESS_FILE = /^libxess(_dx11|_fg)?\.dll$/i;
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

// The state of nvngx_dlssnr.dll in a game folder. Without it the add-on loads, hooks DLSS and
// then logs "nvngx_dlssnr.dll was not found ... NR stays off" — the exact failure seen on an
// RTX 3060 — so this is the one file whose state is always reported, never assumed.
function nrState(exeDir, { gpu, unlock } = {}) {
  const tier = (gpu && gpu.dlss5) || 'unknown';
  const file = path.join(exeDir, 'nvngx_dlssnr.dll');
  const present = fs.existsSync(file);
  const optedOut = !!(unlock && unlock.enabled === false);
  const own = unlock && unlock.source === 'own' && unlock.runtime && fs.existsSync(unlock.runtime) ? unlock.runtime : null;
  const want = own ? hashOf(own) : assets.UNIVERSAL_NR_SHA256;
  const hash = present ? hashOf(file) : null;
  const universal = hash === want;
  const legacy = hash === assets.LEGACY_NR_SHA256;
  if (tier === 'unsupported') {
    return { file, present, hash, ok: false, needed: false, why: 'gpu', detail: 'This GPU cannot run DLSS 5 neural rendering.' };
  }
  if (!present) {
    return { file, present, hash, ok: false, needed: !optedOut, why: optedOut ? 'off' : 'missing',
      detail: optedOut
        ? 'Not installed: the neural-rendering runtime is switched off in Settings, so DLSS 5 stays off in this game.'
        : 'Not in the game folder, so the add-on loads and then does nothing.' };
  }
  if (tier === 'patch' && !universal) {
    return { file, present, hash, ok: false, needed: !optedOut, why: legacy ? 'legacy' : 'wrong-build',
      detail: legacy
        ? 'This is Refract 0.2\'s runtime: it has no RTX 30 kernels and its architecture gate refuses Ampere. Repair replaces it.'
        : 'This build is not the universal runtime, and stock NVIDIA builds only run on RTX 50.' };
  }
  return { file, present, hash, ok: true, needed: false, why: null,
    detail: universal ? 'The universal RTX 30/40/50 runtime.' : 'A runtime the game or you provided.' };
}

// Does this folder still need the neural-rendering runtime put right? (see provisionNr)
function nrNeeded(exeDir, opts = {}) { return nrState(exeDir, opts).needed; }

const INI = 'ReShade.ini';
function iniState(exeDir) {
  const p = path.join(exeDir, INI);
  let text = null;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, detail: 'No ReShade.ini, so ReShade starts with defaults and the add-on may stay disabled.' }; }
  const disabled = /^DisabledAddons=(.*)$/im.exec(text);
  const off = disabled ? disabled[1].split(',').map(x => x.trim().toLowerCase()).filter(x => /renodx|dlss5/.test(x)) : [];
  if (off.length) return { ok: false, detail: `ReShade.ini disables ${off.join(', ')}.` };
  return { ok: true, detail: /\[RenoDX\.DLSS5\]/i.test(text) ? 'Tuned DLSS 5 settings present.' : 'Present; the add-on will write its own defaults.' };
}

// A cheap "does this look broken?" for the library shelf: presence only, no hashing, so it can
// run for every installed game on every refresh.
function quickCheck(exeDir) {
  const st = status(exeDir);
  if (!st.installed) return { installed: false, needsAttention: false };
  const i = inspect(exeDir);
  const missing = [];
  if (!i.reshadeProxy || !i.reshadeIsAddonBuild) missing.push('ReShade add-on build');
  if (st.route === 'feeder' ? !i.feedAddons.length : !i.renodxAddons.length) missing.push('the DLSS 5 add-on');
  if (!fs.existsSync(path.join(exeDir, 'nvngx_dlssnr.dll'))) missing.push('the neural-rendering runtime');
  return { installed: true, needsAttention: missing.length > 0, missing, route: st.route };
}

// What a finished install has to look like on disk. Every install and every status read runs
// this, so "installed" always means verified rather than "we copied some files once".
function verify(exeDir, { gpu = null, unlock = null, route = null } = {}) {
  const i = inspect(exeDir);
  const st = status(exeDir);
  const r = route || st.route || null;
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: detail || null });
  if (r === 'optiscaler') {
    const proxy = optiProxyInstalled(exeDir, readManifest(exeDir));
    add('optiscaler', 'OptiScaler bridge next to the game', !!proxy, proxy ? `loaded as ${proxy}` : 'No OptiScaler proxy DLL in this folder.');
    add('xess', 'XeSS runtime for the bridge', fs.existsSync(path.join(exeDir, 'libxess.dll')), 'libxess.dll');
  } else {
    add('reshade', 'ReShade add-on build next to the game',
      i.reshadeProxy && i.reshadeIsAddonBuild,
      !i.reshadeProxy ? 'No ReShade proxy DLL in this folder.' : i.reshadeIsAddonBuild ? i.reshadeProxy : `${i.reshadeProxy} is a ReShade build without add-on support.`);
    if (r === 'feeder') add('addon', 'DLSS 5 Feeder add-on', i.feedAddons.length, i.feedAddons.join(', ') || 'dlss5-feed.addon64 is missing.');
    else add('addon', 'RenoDX DLSS 5 add-on', i.renodxAddons.length, i.renodxAddons.join(', ') || 'renodx-dlss5.addon64 is missing.');
  }
  if (r === 'native+bridge') add('bridge', 'DX11 → DX12 bridge add-on', i.bridgeAddons.length, i.bridgeAddons.join(', ') || 'dlss5-bridge.addon64 is missing.');
  const nr = nrState(exeDir, { gpu, unlock });
  // Installed by Refract, and now gone: something removed it after the install. On Windows that
  // is nearly always real-time protection quarantining a modified NVIDIA binary.
  const weAdded = (readManifest(exeDir).added || []).some(e => /nvngx_dlssnr\.dll$/i.test(e.path || ''));
  const vanished = weAdded && !nr.present;
  add('runtime', 'Neural-rendering runtime (nvngx_dlssnr.dll)', nr.ok,
    vanished ? 'Refract installed it and it is gone. An antivirus most likely quarantined it — exclude the game folder, then repair.' : nr.detail);
  if (r === 'optiscaler') {
    add('config', 'OptiScaler.ini routes FSR/XeSS to DLSS', /Dx12Upscaler\s*=\s*dlss/i.test(readText(path.join(exeDir, 'OptiScaler.ini'))), 'OptiScaler.ini');
  } else {
    const ini = iniState(exeDir);
    add('config', 'ReShade.ini lets the add-on load', ini.ok, ini.detail);
  }
  add('conflicts', 'Only one DLSS add-on in this folder', !i.conflicts.length,
    i.conflicts.length ? `${i.conflicts.join(', ')} fight over the same NGX hooks.` : null);
  const failed = checks.filter(c => !c.ok);
  return { ok: !failed.length, checks, failed, route: r, nr, vanished,
    summary: failed.length ? failed[0].detail || failed[0].label : 'Everything DLSS 5 needs is in place.' };
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
    // Two add-ons driving the same NGX hooks unload each other — the classic "it's listed but
    // does nothing". The feeder pairing (dlss5-feed + renodx-dlss5) is intended, though, and so
    // is the DX11 bridge alongside RenoDX; only duplicates and strangers count.
    conflicts: (() => {
      const renodx = names.filter(n => RENODX_ADDON.test(n));
      const feed = names.filter(n => FEED_ADDON.test(n));
      const known = n => RENODX_ADDON.test(n) || FEED_ADDON.test(n) || BRIDGE_ADDON.test(n);
      const strangers = dlssAddons.filter(n => !known(n));
      const bad = [...(renodx.length > 1 ? renodx : []), ...(feed.length > 1 ? feed : []), ...strangers];
      return [...new Set(bad)];
    })(),
    reshadeProxy: proxy || null,
    reshadeIsAddonBuild: proxy ? rt.isAddonReShade(path.join(exeDir, proxy)) : false,
    fsr: names.filter(n => /\.dll$/i.test(n) && FSR_FILE.test(n)),
    xess: names.filter(n => XESS_FILE.test(n)),
    optiScaler: names.filter(n => /^optiscaler\.(dll|ini)$/i.test(n)),
  };
}

// Which DLSS 5 route fits this game?
function routeFor({ api = 'dxgi', dx = null, hasDlss = false, hasFsr = false, hasXess = false } = {}) {
  if (api === 'vulkan') {
    return { route: null, reason: 'This is a Vulkan game. ReShade hooks Vulkan through an installed layer rather than a proxy DLL, and the DLSS 5 add-ons are Direct3D only.' };
  }
  if (api && api !== 'dxgi') {
    return { route: null, reason: `This is a ${api} game. DLSS 5 needs DirectX 11 or 12.` };
  }
  if (hasDlss) return { route: dx === 11 ? 'native+bridge' : 'native' };
  // No DLSS, but the game upscales with FSR or XeSS: OptiScaler turns those calls into DLSS
  // calls, which is what the neural pass needs (1-Click-DLSS5 calls this mode 2).
  if (hasFsr || hasXess) return { route: 'optiscaler' };
  return { route: 'feeder' };
}

const ROUTE_LABEL = {
  native: 'DLSS 5 neural rendering over this game\'s own DLSS',
  'native+bridge': 'DLSS 5 over this DX11 game\'s DLSS, via the D3D11→D3D12 bridge',
  feeder: 'DLSS 5 Feeder — this game has no DLSS, so motion vectors are generated for it',
  optiscaler: 'OptiScaler bridge — this game\'s FSR/XeSS upscaling is routed to DLSS 5',
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
      reason: gpu.series === 20
        ? `${gpu.name || 'RTX 20'} (Turing) can't run DLSS 5 neural rendering: every available runtime refuses Turing. RTX 30, 40 and 50 cards are supported.`
        : `${gpu.name || 'This GPU'} has no DLSS hardware. DLSS 5 needs an RTX 30, 40 or 50 card.` };
  }
  if (gpu && gpu.dlss5 === 'patch' && unlock && unlock.enabled === false) {
    warnings.push(`RTX ${gpu.series} (${gpu.arch}): the universal neural-rendering runtime is switched off, so DLSS 5 will stay off on this card. Turn it back on in the DLSS 5 panel.`);
  }
  if (bitness !== 64) return { ok: false, route: null, actions: [], warnings, inspect: i, reason: 'DLSS 5 is 64-bit only; this game is 32-bit.' };

  const r = routeFor({ api, dx, hasDlss: i.hasDlss, hasFsr: i.fsr.length > 0, hasXess: i.xess.length > 0 });
  if (!r.route) return { ok: false, route: null, actions: [], warnings, inspect: i, reason: r.reason };

  const actions = [];
  if (r.route !== 'optiscaler') {
    if (!i.reshadeProxy) actions.push('reshade-install');
    else if (!i.reshadeIsAddonBuild) actions.push('reshade-upgrade');
  }
  if (r.route === 'optiscaler') {
    if (!i.optiScaler.length) actions.push('optiscaler-install');
  } else if (r.route === 'feeder') {
    if (!i.feedAddons.length) actions.push('feeder-install');
  } else {
    if (!i.renodxAddons.length) actions.push('addon-install');
    if (r.route === 'native+bridge' && !i.bridgeAddons.length) actions.push('bridge-install');
  }
  // Without nvngx_dlssnr.dll the add-on loads, hooks DLSS, and then does nothing at all.
  if (nrNeeded(exeDir, { gpu, unlock })) actions.push('nr-runtime');

  const nr = nrState(exeDir, { gpu, unlock });
  if (!actions.length) {
    // "Already set up" with no runtime next to the game is the lie that cost an RTX 3060 user a
    // week: the add-on loads, logs "nvngx_dlssnr.dll was not found" and nothing happens.
    if (!nr.ok) {
      return { ok: false, already: true, blocked: nr.why, route: r.route, actions, warnings, inspect: i, nr,
        reason: `DLSS 5 is installed here, but neural rendering is off: ${nr.detail}` };
    }
    const tail = warnings.length ? ' ' + warnings[0] : ' If it still does nothing, turn DLSS on in the game\'s graphics settings.';
    return { ok: false, already: true, route: r.route, actions, warnings, inspect: i, nr,
      reason: `DLSS 5 is already set up here (ReShade add-on build + ${(i.dlssAddons.join(', ') || 'add-on')}).` + tail };
  }
  const repair = status(exeDir).installed;
  return { ok: true, route: r.route, label: ROUTE_LABEL[r.route], actions, warnings, inspect: i, repair, nr,
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

// The neural-rendering runtime is 158 MB: worth a progress line, and worth proving it arrived
// intact. A half-written copy (full disk, antivirus, a locked file) is exactly the state that
// makes a game log "nvngx_dlssnr.dll was not found" — or load a truncated one.
async function copyVerified(man, src, dest, kind, onProgress, label) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await track(man, dest, kind);
  const total = fs.statSync(src).size;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    let done = 0, last = 0;
    rs.on('data', c => {
      done += c.length;
      if (onProgress && done - last > (4 << 20)) { last = done; onProgress({ label, frac: done / total }); }
    });
    rs.on('error', reject); ws.on('error', reject);
    ws.on('close', resolve);
    rs.pipe(ws);
  }).catch(e => {
    try { fs.rmSync(dest, { force: true }); } catch {}
    throw new Error(`Could not write ${path.basename(dest)} into the game folder (${e.code || e.message}). Check free space and that the game is closed.`);
  });
  const got = bundle.sha256File(dest), want = bundle.sha256File(src);
  if (got !== want) {
    try { fs.rmSync(dest, { force: true }); } catch {}
    throw new Error(`${path.basename(dest)} did not copy correctly (checksum mismatch). Check free disk space and any antivirus that may be scanning the game folder.`);
  }
  return dest;
}
async function writeInto(man, dest, text, kind) {
  await track(man, dest, kind);
  await fs.promises.writeFile(dest, text);
}
async function read(p) { try { return await fs.promises.readFile(p, 'utf8'); } catch { return ''; } }

async function install(game, payload, { cacheRoot, onProgress, gpu = null, unlock = null, upgradeSr = true, hooks = null } = {}) {
  const exeDir = path.dirname(game.exe);
  const api = game.api || 'dxgi';
  const bitness = game.bitness || 64;
  const dx = game.dx || null;

  const gate = plan(exeDir, { bitness, api, dx, gpu, unlock });
  if (!gate.ok) throw new Error(gate.reason);
  hooks = hooks === 1 || hooks === 2 ? hooks : hooksFor(gpu);
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
  Object.assign(man, { version: 5, route, at: Date.now(), notes: [], hooks: hooks || hooksFor(gpu) });
  man.added = man.added || []; man.replaced = man.replaced || [];

  // The bridge route replaces the upscaler instead of adding a ReShade pass, so it takes the
  // proxy slot itself and skips everything ReShade-shaped.
  if (route === 'optiscaler') {
    await installOptiScaler(man, exeDir, payload, before);
    await provisionNr(man, exeDir, payload, { gpu, unlock, cacheRoot, onProgress });
    await fs.promises.writeFile(path.join(exeDir, MANIFEST), JSON.stringify(man, null, 2));
    const checkedBridge = verify(exeDir, { gpu, unlock, route });
    return { ...status(exeDir), route, label: ROUTE_LABEL[route], notes: man.notes, verify: checkedBridge, ok: checkedBridge.ok };
  }

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
    await installFeeder(man, exeDir, payload, before, hooks);
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
    await writeIni(man, exeDir, { feeder: false, hooks });
  }

  if (route !== 'feeder' && route !== 'optiscaler') await provisionDlssSr(man, exeDir, payload, { upgradeSr, onProgress });
  await provisionNr(man, exeDir, payload, { gpu, unlock, cacheRoot, onProgress });

  await fs.promises.writeFile(path.join(exeDir, MANIFEST), JSON.stringify(man, null, 2));
  // Never report success on trust: read the folder back and check every part DLSS 5 needs.
  const checked = verify(exeDir, { gpu, unlock, route });
  return { ...status(exeDir), route, label: ROUTE_LABEL[route], notes: man.notes, verify: checked, ok: checked.ok };
}

// Every DLSS 5 route needs NVIDIA's neural-rendering runtime, nvngx_dlssnr.dll, next to the
// game. Stock games don't ship it — without it the add-on logs "nvngx_dlssnr.dll was not
// found ... NR stays off" and the game looks untouched. Refract provides the universal
// RTX 30/40/50 build (sm_86/89/120 kernels; its architecture gate accepts Ampere and Ada).
// Stock NVIDIA files and Refract 0.2's Ada-only build refuse RTX 30. Rules:
//   missing                         -> add the universal build (or the user's own file)
//   present, RTX 30/40              -> must be the universal (or user's) build; replace, backed up
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
  const src = own || payload.nvngxNrUniversal || await assets.ensureUniversalRuntime(cacheRoot, onProgress);
  await copyVerified(man, src, dest, 'runtime-nr', onProgress, 'Neural-rendering runtime');
  // The bridge looks for the runtime under NGX's own name pattern as well (1-Click does the
  // same); a hard link keeps it to one 158 MB file where the filesystem allows.
  if (man.route === 'optiscaler') {
    const alias = path.join(exeDir, 'nvngx.dll_dlssnr.dll');
    await track(man, alias, 'runtime-nr');
    try { await fs.promises.rm(alias, { force: true }); await fs.promises.link(dest, alias); }
    catch { await fs.promises.copyFile(dest, alias); }
  }
  man.notes.push(`Installed the ${own ? 'your' : 'universal'} neural-rendering runtime (nvngx_dlssnr.dll) for ${label}.`);
}

// The add-on's neural pass rides on the game's own DLSS/DLSSD work. A game shipping an older
// DLSS Super Resolution runtime can leave that state incomplete — the RTX 4050 log reads "real
// DLSS/DLSSD work left host state incomplete; skipping inline NR" — so the game's nvngx_dlss.dll
// is upgraded when Refract's is newer. Rules, deliberately timid:
//   * only nvngx_dlss.dll, never the Streamline set around it (mixing those crashes games);
//   * only when both versions can be read and ours is strictly newer;
//   * the original is backed up, so Restore original puts the game's own build back.
function srDecision(ourVersion, theirFile) {
  if (!ourVersion) return { upgrade: false, why: 'Refract has no DLSS runtime bundled.' };
  if (!fs.existsSync(theirFile)) return { upgrade: false, why: 'The game has no nvngx_dlss.dll of its own.', missing: true };
  let theirs = null;
  try { const v = peversion.getFileVersion(theirFile); theirs = v && v.text; } catch {}
  if (!theirs) return { upgrade: false, why: 'Could not read the game\'s DLSS version, so it is left alone.' };
  const cmp = peversion.compare(ourVersion, theirs);
  return cmp > 0
    ? { upgrade: true, theirs, why: `The game ships DLSS ${theirs}; Refract has ${ourVersion}.` }
    : { upgrade: false, theirs, why: `The game's DLSS ${theirs} is already current.` };
}

async function provisionDlssSr(man, exeDir, payload, { upgradeSr = true, onProgress } = {}) {
  const src = payload && payload.nvngxDlssSr;
  const dest = path.join(exeDir, 'nvngx_dlss.dll');
  if (!upgradeSr) { man.notes.push('Left the game\'s DLSS runtime alone (upgrades are switched off).'); return; }
  let ourVersion = null;
  try { const v = src && peversion.getFileVersion(src); ourVersion = (v && v.text) || assets.SR_VERSION; } catch { ourVersion = assets.SR_VERSION; }
  const d = srDecision(src ? ourVersion : null, dest);
  man.dlssSr = { ...d, at: Date.now() };
  if (!d.upgrade || !src) { if (d.why) man.notes.push(d.why); return; }
  await copyVerified(man, src, dest, 'runtime-sr', onProgress, 'DLSS Super Resolution runtime');
  man.notes.push(`Upgraded the game's DLSS runtime ${d.theirs} → ${ourVersion} (original backed up).`);
}

// The feeder route: the game has no upscaler at all, so DLSS5-Feeder builds a synthetic DLAA
// device and LumeniteFX supplies motion vectors through ReShade. Everything goes next to the exe
// or into reshade-shaders/, and nothing the game already ships is overwritten.
async function installFeeder(man, exeDir, payload, before, hooks) {
  const shaders = path.join(exeDir, 'reshade-shaders', 'Shaders');
  const textures = path.join(exeDir, 'reshade-shaders', 'Textures');

  await copyInto(man, payload.feedAddon, path.join(exeDir, payload.feedAddonName), 'feeder');
  man.notes.push(`Added ${payload.feedAddonName} (DLSS5-Feeder ${payload.versions.feeder}).`);
  if (payload.addon && !before.renodxAddons.length) {
    await copyInto(man, payload.addon, path.join(exeDir, payload.addonName), 'addon');
    man.notes.push(`Added ${payload.addonName} (RenoDX DLSS 5 ${payload.versions.renodx5}).`);
  }

  await copyInto(man, payload.feedFx, path.join(shaders, 'DLSS5_Feed.fx'), 'feeder');
  for (const f of payload.lumeniteShaders || []) await copyInto(man, f, path.join(shaders, path.basename(f)), 'feeder');
  for (const f of payload.lumeniteIncludes || []) await copyInto(man, f, path.join(shaders, 'include', path.basename(f)), 'feeder');
  for (const f of payload.lumeniteTextures || []) await copyInto(man, f, path.join(textures, path.basename(f)), 'feeder');
  // ReShade's own headers: only where the folder does not already have them.
  for (const f of payload.shaderHeaders || []) {
    const dest = path.join(shaders, path.basename(f));
    if (!fs.existsSync(dest)) await copyInto(man, f, dest, 'feeder');
  }
  man.notes.push(`Installed the feeder shaders (LumeniteFX ${payload.versions.lumenite}) into reshade-shaders.`);

  // NVIDIA's runtime set, but only the files the game does not already have: mixing a game's
  // own Streamline DLLs with another version is what crashes games before ReShade even loads.
  let added = 0;
  for (const f of payload.dlls || []) {
    const dest = path.join(exeDir, path.basename(f));
    if (fs.existsSync(dest)) continue;
    await copyInto(man, f, dest, 'runtime');
    added++;
  }
  if (payload.nvngxDlssSr && !fs.existsSync(path.join(exeDir, 'nvngx_dlss.dll'))) {
    await copyVerified(man, payload.nvngxDlssSr, path.join(exeDir, 'nvngx_dlss.dll'), 'runtime', null, 'DLSS runtime');
    added++;
  }
  man.notes.push(added ? `Added ${added} NVIDIA runtime files the game did not have.` : 'The game already had every runtime file it needs.');

  await writeInto(man, path.join(exeDir, 'dlss5-feed.cfg'), cfg.feed(await read(path.join(exeDir, 'dlss5-feed.cfg'))), 'config');
  await writeIni(man, exeDir, { feeder: true, hooks });
  const presetPath = path.join(exeDir, 'ReShadePreset.ini');
  await writeInto(man, presetPath, cfg.feederPreset(await read(presetPath)), 'config');
  man.notes.push('Wrote the feeder preset: the motion-vector shaders run before the neural pass.');
}

// Which hook mode suits this card by default. RTX 50 is verified on NGX-only hooks; on Ampere and
// Ada the add-on has to reach the game's Streamline modules too, which is the mode 1-Click ships.
function hooksFor(gpu) {
  const tier = (gpu && gpu.dlss5) || 'unknown';
  return tier === 'patch' ? 1 : 2;
}

// The OptiScaler bridge: the game's FSR 2/3 or XeSS calls are turned into DLSS calls, so the
// neural runtime has real DLSS work to attach to. OptiScaler is loaded as the game's proxy DLL;
// when ReShade already owns dxgi.dll it takes winmm.dll instead, so the two never fight.
const OPTI_PROXIES = ['dxgi.dll', 'winmm.dll', 'version.dll', 'dbghelp.dll'];
function optiProxyFor(exeDir, before) {
  const taken = new Set(listDir(exeDir).map(n => n.toLowerCase()));
  const reshade = (before.reshadeProxy || '').toLowerCase();
  for (const name of OPTI_PROXIES) {
    if (name === reshade) continue;           // never overwrite a working ReShade
    if (!taken.has(name)) return name;
  }
  return null;
}

// Which file in this folder is OptiScaler? It is installed under a proxy name, so identity comes
// from the manifest, or failing that from the DLL's own marker.
function optiProxyInstalled(exeDir, man = {}) {
  if (man.optiProxy && fs.existsSync(path.join(exeDir, man.optiProxy))) return man.optiProxy;
  for (const name of OPTI_PROXIES) {
    const p = path.join(exeDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(4 << 20, fs.statSync(p).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        if (buf.includes(Buffer.from('OptiScaler'))) return name;
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  return null;
}

async function installOptiScaler(man, exeDir, payload, before) {
  const proxy = optiProxyFor(exeDir, before);
  if (!proxy) throw new Error('Every DLL name OptiScaler can load under is already taken in this folder. Move the extra proxy DLLs out and try again.');
  await copyVerified(man, payload.optiScaler, path.join(exeDir, proxy), 'optiscaler', null, 'OptiScaler');
  man.notes.push(`Installed the OptiScaler bridge ${payload.versions.optiscaler} as ${proxy}.`);
  await copyVerified(man, payload.optiXess, path.join(exeDir, 'libxess.dll'), 'runtime', null, 'XeSS runtime');
  man.notes.push('Added libxess.dll (XeSS translation runtime).');
  await writeInto(man, path.join(exeDir, 'OptiScaler.ini'), cfg.optiScalerIni(), 'config');
  man.notes.push('Wrote OptiScaler.ini: the game\'s FSR/XeSS calls now go to DLSS.');
  man.optiProxy = proxy;
}

// ReShade.ini: create a tuned one, or add only what is missing to the user's (backed up).
async function writeIni(man, exeDir, { feeder, hooks = null }) {
  const iniPath = path.join(exeDir, 'ReShade.ini');
  const cur = await read(iniPath);
  const next = feeder ? cfg.feederReShade(cur, { hooks }) : cfg.dlss5ReShade(cur, { hooks });
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

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function readManifest(exeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(exeDir, MANIFEST), 'utf8')); } catch { return {}; }
}

function status(exeDir) {
  try {
    const man = JSON.parse(fs.readFileSync(path.join(exeDir, MANIFEST), 'utf8'));
    return { installed: true, at: man.at, route: man.route, files: (man.added || []).length + (man.replaced || []).length };
  } catch { return { installed: false }; }
}

module.exports = { install, restore, status, verify, quickCheck, srDecision, hooksFor, eligible, plan, inspect, routeFor, nrNeeded, nrState, ROUTE_LABEL, MANIFEST, ensurePayload: assets.ensurePayload };
