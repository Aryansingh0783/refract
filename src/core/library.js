'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const vdf = require('./vdf');
const { walk, exists } = require('./fsutil');
const { getFileVersion } = require('./peversion');
const { detectApiDeep, getBitness } = require('./peimports');

const DLSS_RE = /^nvngx_dlss[a-z]*\.dll$/i;          // nvngx_dlss.dll, nvngx_dlssg.dll, nvngx_dlssd.dll, ...
const RESHADE_INI = 'reshade.ini';
const EXE_SKIP = /(anticheat|installer|setup|unins|crash|report|redist|vc_|dxsetup|prereq|battleye|^be_|^eac|cef|helper|dotnet|launcher|updater|bootstrap|touchup|cleanup|benchmark)/i;

function reg(args) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve('');
    execFile('reg.exe', args, { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => resolve(err ? '' : out));
  });
}

function regValue(out, name) {
  const m = new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'mi').exec(out);
  return m ? m[1].trim() : null;
}

// ---- Steam -------------------------------------------------------------
async function steamRoots() {
  const out = await reg(['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const steam = regValue(out, 'SteamPath');
  if (!steam) return { steam: null, libraries: [] };
  const root = path.normalize(steam);
  const libs = new Set([root]);
  try {
    const data = vdf.parse(await fs.promises.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const lf = data.libraryfolders || data.LibraryFolders || {};
    for (const v of Object.values(lf)) {
      const p = typeof v === 'string' ? v : v && v.path;
      if (p && /[\\/]/.test(p)) libs.add(path.normalize(p));
    }
  } catch {}
  return { steam: root, libraries: [...libs] };
}

// Steam caches store art locally. Older clients use flat names (<appid>_library_hero.jpg),
// newer ones a per-app folder that may contain a hashed subfolder.
// Steam renamed some files over time; each kind lists the names we accept, best first.
const ART = { capsule: ['library_600x900', 'library_capsule'], hero: ['library_hero'], logo: ['logo'], header: ['header', 'library_header'] };
async function steamArt(steamRoot, appid) {
  const cache = path.join(steamRoot, 'appcache', 'librarycache');
  const out = {};
  for (const [k, bases] of Object.entries(ART)) {
    for (const base of bases) {
      for (const ext of ['.jpg', '.png']) {
        const p = path.join(cache, `${appid}_${base}${ext}`);
        if (!out[k] && await exists(p)) out[k] = p;
      }
    }
  }
  const files = await walk(path.join(cache, String(appid)), { maxDepth: 2, maxEntries: 400, match: n => /\.(jpe?g|png)$/i.test(n) });
  for (const [k, bases] of Object.entries(ART)) {
    for (const base of bases) {
      if (out[k]) break;
      const re = new RegExp('^' + base + '\\.(jpe?g|png)$', 'i');
      const f = files.find(p => re.test(path.basename(p)));
      if (f) out[k] = f;
    }
  }
  return out;
}

async function scanSteam() {
  const { steam, libraries } = await steamRoots();
  const games = [];
  for (const lib of libraries) {
    const apps = path.join(lib, 'steamapps');
    let files = [];
    try { files = await fs.promises.readdir(apps); } catch { continue; }
    for (const f of files.filter(x => /^appmanifest_\d+\.acf$/i.test(x))) {
      try {
        const st = vdf.parse(await fs.promises.readFile(path.join(apps, f), 'utf8')).AppState || {};
        if (!st.installdir || !st.name) continue;
        const dir = path.join(apps, 'common', st.installdir);
        if (!(await exists(dir))) continue;
        if (/^(Steamworks Common Redistributables|Proton|Steam Linux Runtime)/i.test(st.name)) continue;
        games.push({ id: 'steam:' + st.appid, store: 'steam', name: st.name, dir,
          launch: 'steam://rungameid/' + st.appid, art: await steamArt(steam, st.appid) });
      } catch {}
    }
  }
  return games;
}

// ---- Epic --------------------------------------------------------------
async function scanEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files = [];
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const games = [];
  for (const f of files.filter(x => x.endsWith('.item'))) {
    try {
      const m = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
      if (!m.InstallLocation || !(await exists(m.InstallLocation))) continue;
      games.push({ id: 'epic:' + m.AppName, store: 'epic', name: m.DisplayName || m.AppName,
        dir: m.InstallLocation,
        exe: m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : null,
        launch: `com.epicgames.launcher://apps/${encodeURIComponent(m.AppName)}?action=launch&silent=true` });
    } catch {}
  }
  return games;
}

// ---- GOG ---------------------------------------------------------------
async function scanGog() {
  const out = await reg(['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']);
  if (!out) return [];
  const games = [];
  for (const block of out.split(/\r?\n(?=HKEY_)/)) {
    const name = regValue(block, 'gameName');
    const dir = regValue(block, 'path');
    const exe = regValue(block, 'exe');
    const id = regValue(block, 'gameID');
    if (name && dir && (await exists(dir))) games.push({ id: 'gog:' + (id || name), store: 'gog', name, dir, exe, launch: exe || null });
  }
  return games;
}

// ---- Ubisoft Connect ---------------------------------------------------
async function scanUbisoft() {
  const out = await reg(['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs', '/s']);
  if (!out) return [];
  const games = [];
  for (const block of out.split(/\r?\n(?=HKEY_)/)) {
    const dir = regValue(block, 'InstallDir');
    const id = (/Installs\\(\d+)/.exec(block) || [])[1];
    if (!dir) continue;
    const d = path.normalize(dir.replace(/\//g, '\\'));
    if (await exists(d)) games.push({ id: 'ubisoft:' + (id || d), store: 'ubisoft', name: path.basename(d.replace(/\\$/, '')), dir: d, launch: id ? `uplay://launch/${id}/0` : null });
  }
  return games;
}

// ---- Launcher-agnostic roots -------------------------------------------
// Covers EA, Xbox/Game Pass, Battle.net and loose installs by walking the well-known game
// roots on every fixed drive — the same "find games across the drives" approach the
// one-click DLSS 5 tools use, so Refract is not limited to the launchers it can query.
const ROOT_NAMES = [
  ['XboxGames', 'xbox'],
  ['Program Files\\EA Games', 'ea'],
  ['Program Files (x86)\\Origin Games', 'ea'],
  ['EA Games', 'ea'],
  ['Program Files (x86)\\Battle.net', 'battlenet'],
  ['Games', 'folder'],
  ['GOG Games', 'gog'],
  ['Program Files\\Epic Games', 'epic'],
];

async function drives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const root = String.fromCharCode(c) + ':\\';
    if (await exists(root)) out.push(root);
  }
  return out;
}

async function scanRoots() {
  const games = [];
  const seen = new Set();
  for (const drv of await drives()) {
    for (const [rel, store] of ROOT_NAMES) {
      const root = path.join(drv, rel);
      let names = [];
      try { names = await fs.promises.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, e.name);
        const key = dir.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Xbox titles keep the real game under Content\
        const content = path.join(dir, 'Content');
        const real = (await exists(content)) ? content : dir;
        games.push({ id: store + ':' + key, store, name: e.name, dir: real, launch: null });
      }
    }
  }
  return games;
}

// ---- Per-game inspection ----------------------------------------------
async function inspect(game) {
  const found = await walk(game.dir, {
    maxDepth: 10,
    match: n => DLSS_RE.test(n) || n.toLowerCase() === RESHADE_INI || /\.exe$/i.test(n),
  });
  const dlls = [];
  const exes = [];
  const inis = [];
  for (const p of found) {
    const base = path.basename(p);
    if (DLSS_RE.test(base)) {
      const v = getFileVersion(p);
      dlls.push({ file: base, path: p, version: v ? v.text : null,
        description: v && v.strings.FileDescription || null,
        backup: await exists(p + '.refract-backup') });
    } else if (base.toLowerCase() === RESHADE_INI) inis.push(p);
    else if (!EXE_SKIP.test(base)) exes.push(p);
  }
  // Guess the main executable: prefer the one next to the DLSS runtime, then the largest.
  let exe = game.exe && (await exists(game.exe)) ? game.exe : null;
  if (!exe && exes.length) {
    const near = dlls.length ? exes.filter(e => path.dirname(e) === path.dirname(dlls[0].path)) : [];
    const pool = near.length ? near : exes;
    let best = null, bestSize = -1;
    for (const e of pool) {
      try { const s = (await fs.promises.stat(e)).size; if (s > bestSize) { best = e; bestSize = s; } } catch {}
    }
    exe = best;
  }
  // ReShade reads the ini next to its DLL, which sits next to the game exe.
  const exeDir = exe ? path.dirname(exe) : game.dir;
  const reshadeIni = inis.find(p => path.dirname(p).toLowerCase() === exeDir.toLowerCase()) || inis[0] || null;
  // Render API + bitness from the chosen exe (for ReShade proxy choice + feeder eligibility).
  let api = null, apiLabel = null, bitness = null, dx = null;
  if (exe) { try { const d = detectApiDeep(exe); api = d.api; apiLabel = d.label; dx = d.dx; bitness = getBitness(exe); } catch {} }
  return { ...game, exe, exeDir, api, apiLabel, dx, bitness,
    dlls, reshadeIni, hasDlss: dlls.length > 0, inspectedAt: Date.now() };
}

async function scanAll(manualDirs = []) {
  const lists = await Promise.all([scanSteam(), scanEpic(), scanGog(), scanUbisoft(), scanRoots()]);
  const manual = manualDirs.map(d => ({ id: 'dir:' + d.toLowerCase(), store: 'folder', name: path.basename(d), dir: d, launch: null }));
  // Dedupe by folder: a title found by both its launcher and a root scan is one game.
  const byDir = new Map();
  for (const g of [...lists.flat(), ...manual]) {
    const k = path.normalize(g.dir || '').toLowerCase();
    if (!k) continue;
    const prev = byDir.get(k);
    // Prefer the entry that knows how to launch it (a real launcher record).
    if (!prev || (!prev.launch && g.launch)) byDir.set(k, prev ? { ...g, art: g.art || prev.art } : g);
  }
  const all = [...byDir.values()];
  // Inspect with limited concurrency so HDDs are not thrashed.
  const out = [];
  let i = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (i < all.length) { const g = all[i++]; out.push(await inspect(g)); }
  });
  await Promise.all(workers);
  return out.sort((a, b) => (b.hasDlss - a.hasDlss) || a.name.localeCompare(b.name));
}

module.exports = { scanAll, inspect, scanSteam, scanEpic, scanGog, scanUbisoft, scanRoots, steamRoots, steamArt, DLSS_RE };
