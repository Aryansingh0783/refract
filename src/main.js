'use strict';
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, shell, nativeTheme, protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const { Store } = require('./core/store');
const { WinHelper } = require('./core/winhelper');
const nvidia = require('./core/nvidia');
const library = require('./core/library');
const dlss = require('./core/dlss');
const reshade = require('./core/reshade');
const feeder = require('./core/feeder');
const { ladder } = require('./core/display');
const { Session } = require('./core/session');
const { LOOKS, KEYCODES } = require('./shared/looks');

const SELFTEST = process.argv.includes('--selftest');
if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// Game art is served through a private scheme so the renderer never sees raw paths and
// canvas reads (Looks preview) stay untainted.
protocol.registerSchemesAsPrivileged([{ scheme: 'refract-art',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let store, win, session;
let mainWin = null, overlayWin = null;
let games = [];
let gpu = { available: false };
let lastTelemetry = null;
let stopTelemetry = null;
let currentLook = null;
const rendererLog = [];      // console errors from any window (checked by --selftest)
const rendererReady = {};    // window name -> boot info

const RENDERER = path.join(__dirname, 'renderer');
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');
const cacheRoot = () => app.getPath('userData');

// ---------------------------------------------------------------- helpers
function broadcast(ch, data) {
  for (const w of [mainWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send(ch, data);
}

function keyToVk(name) {
  if (!name) return null;
  const k = String(name).trim().toUpperCase();
  let m;
  if ((m = /^F(\d{1,2})$/.exec(k)) && +m[1] >= 1 && +m[1] <= 24) return 0x6f + Number(m[1]);
  if (/^[A-Z]$/.test(k)) return k.charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const named = { INSERT: 0x2d, HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22, PAUSE: 0x13, SCROLLLOCK: 0x91 };
  return named[k] ?? null;
}

function publicGame(g) {
  const art = {};
  for (const k of Object.keys(g.art || {})) art[k] = `refract-art://game/${encodeURIComponent(g.id)}/${k}`;
  return { ...g, art, cfg: store.game(g.id) };
}

async function serveArt(request) {
  const u = new URL(request.url);
  const [, id, kind] = u.pathname.split('/');
  const g = games.find(x => x.id === decodeURIComponent(id || ''));
  const file = g && g.art && g.art[kind];
  if (!file) return new Response('not found', { status: 404 });
  const buf = await fs.promises.readFile(file);
  return new Response(buf, { headers: {
    'content-type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
    'access-control-allow-origin': '*', 'cache-control': 'max-age=3600' } });
}

function watchConsole(name, wc) {
  wc.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    const message = e.message ?? e.params?.message;
    if (level === 'error' || level === 3) rendererLog.push({ window: name, message: String(message).slice(0, 500) });
  });
  wc.on('render-process-gone', (_e, d) => rendererLog.push({ window: name, message: 'renderer gone: ' + d.reason }));
}

async function refreshReshade(g) {
  g.looks = await reshade.status(g.reshadeIni).catch(() => ({ reshade: !!g.reshadeIni, installed: false }));
  return g;
}

function findGame(id) {
  const g = games.find(x => x.id === id);
  if (!g) throw new Error('Unknown game ' + id);
  return g;
}

async function reinspect(id) {
  const i = games.findIndex(x => x.id === id);
  if (i < 0) return null;
  games[i] = await refreshReshade(await library.inspect(games[i]));
  return publicGame(games[i]);
}

function telemetryDemand() {
  const want = (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized())
    || (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  if (want && !stopTelemetry && gpu.available) {
    stopTelemetry = nvidia.watch(s => { lastTelemetry = s; broadcast('telemetry', s); }, 1000);
  } else if (!want && stopTelemetry) {
    stopTelemetry(); stopTelemetry = null;
  }
}

// ---------------------------------------------------------------- windows
function createMain() {
  mainWin = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1080, minHeight: 700,
    show: false,
    title: 'Refract',
    icon: ICON,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#E6E8EA', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  watchConsole('main', mainWin.webContents);
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => { if (!SELFTEST) mainWin.show(); else mainWin.showInactive(); telemetryDemand(); });
  for (const ev of ['show', 'hide', 'minimize', 'restore']) mainWin.on(ev, telemetryDemand);
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
}

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 396, H = 560;
  const saved = store.get().overlay;
  overlayWin = new BrowserWindow({
    width: W, height: H,
    x: saved.x ?? workArea.x + workArea.width - W - 28,
    y: saved.y ?? workArea.y + Math.round((workArea.height - H) / 2),
    frame: false, transparent: true, resizable: false, movable: true,
    icon: ICON,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    focusable: false,           // clicks never steal focus from the game
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  watchConsole('overlay', overlayWin.webContents);
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.on('moved', () => { const [x, y] = overlayWin.getPosition(); store.patch({ overlay: { ...store.get().overlay, x, y } }); });
  for (const ev of ['show', 'hide']) overlayWin.on(ev, telemetryDemand);
  overlayWin.on('closed', () => { overlayWin = null; });
}

function toggleOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  if (overlayWin.isVisible()) overlayWin.hide();
  else { overlayWin.showInactive(); overlayWin.webContents.send('look', { look: currentLook }); }
  return overlayWin.isVisible();
}

// ---------------------------------------------------------------- looks
async function selectLook(id) {
  const look = LOOKS.find(l => l.id === id);
  if (!look) throw new Error('Unknown look ' + id);
  // Looks go to ReShade through the game's message queue (see winhelper PostKey).
  const target = session.active ? path.basename(session.active.name, path.extname(session.active.name)) : '';
  await win.call('postKey', { vk: KEYCODES[id], process: target });
  currentLook = id;
  broadcast('look', { look: id });
  return id;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.get();
  const failed = [];
  const reg = (acc, fn) => { try { if (!globalShortcut.register(acc, fn)) failed.push(acc); } catch { failed.push(acc); } };
  reg(s.overlay.hotkey, toggleOverlay);
  for (const [id, acc] of Object.entries(s.lookHotkeys)) reg(acc, () => selectLook(id).catch(() => {}));
  return failed;
}

// ---------------------------------------------------------------- IPC
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: dlss.explain(err) }; }
  });
}

function registerIpc() {
  handle('app:state', async () => ({
    settings: store.get(), gpu, telemetry: lastTelemetry, games: games.map(publicGame),
    looks: LOOKS, currentLook, platform: process.platform, session: session.active ? { game: session.active.game.name } : null,
  }));

  handle('library:scan', async () => {
    const found = await library.scanAll(store.get().manualDirs);
    games = await Promise.all(found.map(refreshReshade));
    return games.map(publicGame);
  });

  handle('library:addFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'], title: 'Add a game folder' });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const dirs = [...new Set([...store.get().manualDirs, dir])];
    store.patch({ manualDirs: dirs });
    const g = await refreshReshade(await library.inspect({ id: 'dir:' + dir.toLowerCase(), store: 'folder', name: path.basename(dir), dir, launch: null }));
    games = [g, ...games.filter(x => x.id !== g.id)];
    return publicGame(g);
  });

  handle('game:patch', async (id, patch) => {
    const allowed = {};
    if (patch.tier) allowed.tier = patch.tier;
    if ('neuralKey' in patch) {
      if (patch.neuralKey && keyToVk(patch.neuralKey) == null) throw new Error('Use a key like F9, K or Insert.');
      allowed.neuralKey = patch.neuralKey ? String(patch.neuralKey).toUpperCase() : null;
    }
    if (patch.startLook) allowed.startLook = patch.startLook;
    store.patchGame(id, allowed);
    const g = findGame(id);
    if (allowed.startLook && g.looks && g.looks.installed) {
      const s = store.get();
      await reshade.updateLooks(g.reshadeIni, { values: s.looks, startLook: allowed.startLook, transition: s.transition });
      await refreshReshade(g);
    }
    return publicGame(g);
  });

  handle('game:pickExe', async id => {
    const g = findGame(id);
    const r = await dialog.showOpenDialog(mainWin, { defaultPath: g.dir, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (r.canceled || !r.filePaths[0]) return publicGame(g);
    store.patchGame(id, { exe: r.filePaths[0] });
    return publicGame(g);
  });

  handle('dlss:swap', async (gameId, dllPath) => {
    const g = findGame(gameId);
    if (!g.dlls.some(d => d.path === dllPath)) throw new Error('That DLL is not part of this game.');
    const name = path.basename(dllPath);
    const r = await dialog.showOpenDialog(mainWin, { title: `Pick a replacement ${name}`, properties: ['openFile'], filters: [{ name, extensions: ['dll'] }] });
    if (r.canceled || !r.filePaths[0]) return publicGame(g);
    await dlss.swap(dllPath, r.filePaths[0]);
    return reinspect(gameId);
  });

  handle('dlss:restore', async (gameId, dllPath) => {
    const g = findGame(gameId);
    if (!g.dlls.some(d => d.path === dllPath)) throw new Error('That DLL is not part of this game.');
    await dlss.restore(dllPath);
    return reinspect(gameId);
  });

  handle('reshade:install', async gameId => {
    const g = findGame(gameId);
    const s = store.get();
    const runtime = await reshade.ensureRuntime(g.exeDir || path.dirname(g.exe || g.dir), { api: g.api || 'dxgi', bitness: g.bitness || 64, cacheRoot: cacheRoot() });
    await reshade.install(runtime.iniPath, { values: s.looks, startLook: store.game(gameId).startLook || s.startLook, transition: s.transition });
    const out = await reinspect(gameId);
    out.reshadeAutoInstalled = runtime.installed;
    return out;
  });

  handle('reshade:uninstall', async gameId => {
    const g = findGame(gameId);
    await reshade.uninstall(g.reshadeIni);
    return reinspect(gameId);
  });

  handle('feeder:status', async gameId => {
    const g = findGame(gameId);
    const dir = g.exeDir || (g.exe ? path.dirname(g.exe) : g.dir);
    const s = store.get();
    const unlock = { enabled: !!s.dlss5Unlock, runtime: s.dlss5PatchedRuntime || null, source: s.dlss5UnlockSource || 'auto' };
    const gate = feeder.plan(dir, { bitness: g.bitness || 64, api: g.api || 'dxgi', dx: g.dx || null, gpu, unlock });
    return {
      installed: feeder.status(dir).installed,
      eligible: gate.ok,
      reason: gate.reason || null,
      already: !!gate.already,
      warnings: gate.warnings || [],
      route: gate.route || null,
      routeLabel: gate.label || null,
      apiLabel: g.apiLabel,
      gpuSupport: gpu && gpu.dlss5 || null,
      unlock,
    };
  });

  handle('feeder:install', async gameId => {
    const g = findGame(gameId);
    const s = store.get();
    await feeder.install(
      { exe: g.exe, api: g.api || 'dxgi', apiLabel: g.apiLabel, bitness: g.bitness || 64, dx: g.dx || null },
      null,
      {
        cacheRoot: cacheRoot(),
        onProgress: p => broadcast('dlss5:progress', { gameId, ...p }),
        gpu,
        unlock: { enabled: !!s.dlss5Unlock, runtime: s.dlss5PatchedRuntime || null, source: s.dlss5UnlockSource || 'auto' },
      },
    );
    return reinspect(gameId);
  });

  // The patched neural-rendering runtime for RTX 20/30/40. The user supplies their own file;
  // Refract only records where it is.
  handle('dlss5:pickPatchedRuntime', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Select your patched nvngx_dlssnr.dll',
      properties: ['openFile'],
      filters: [{ name: 'nvngx_dlssnr.dll', extensions: ['dll'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { runtime: store.get().dlss5PatchedRuntime || null };
    const file = r.filePaths[0];
    if (!/^nvngx_dlssnr\.dll$/i.test(path.basename(file))) throw new Error('That file must be named nvngx_dlssnr.dll.');
    store.patch({ dlss5PatchedRuntime: file, dlss5Unlock: true, dlss5UnlockSource: 'own' });
    return { runtime: file, enabled: true, source: 'own' };
  });

  handle('feeder:restore', async gameId => {
    const g = findGame(gameId);
    await feeder.restore(g.exeDir || (g.exe ? path.dirname(g.exe) : g.dir));
    return reinspect(gameId);
  });

  handle('looks:save', async ({ values, startLook, transition }) => {
    store.patch({ looks: { ...store.get().looks, ...values }, startLook, transition });
    const s = store.get();
    let updated = 0;
    for (const g of games.filter(x => x.looks && x.looks.installed)) {
      await reshade.updateLooks(g.reshadeIni, { values: s.looks, startLook: store.game(g.id).startLook || s.startLook, transition: s.transition });
      updated++;
    }
    return { updated };
  });

  handle('look:select', selectLook);

  handle('display:ladder', async () => {
    const [current, modes] = await Promise.all([win.call('current'), win.call('modes')]);
    const native = store.get().nativeMode || current;
    return { current, native, ladder: ladder(modes, native) };
  });
  handle('display:apply', tier => session.applyTier(tier));
  handle('display:restore', () => session.restore());

  handle('session:launch', async gameId => { await session.launch(findGame(gameId)); return true; });

  handle('neural:toggle', async gameId => {
    const key = store.game(gameId).neuralKey;
    const vk = keyToVk(key);
    if (vk == null) throw new Error('Set this game’s neural rendering key first (Library, game settings).');
    await win.call('tap', { vk });
    return key;
  });

  handle('overlay:toggle', async () => toggleOverlay());

  handle('game:openFolder', async id => { const e = await shell.openPath(findGame(id).dir); if (e) throw new Error(e); return true; });

  ipcMain.on('renderer:ready', (e, info) => {
    const name = mainWin && e.sender === mainWin.webContents ? 'main' : 'overlay';
    rendererReady[name] = { ...info, at: Date.now() };
  });

  // Which game is the overlay looking at: the running session, else the foreground process.
  handle('overlay:context', async () => {
    let g = session.active ? session.active.game : null;
    let fg = '';
    try { fg = await win.call('foreground'); } catch {}
    if (!g && fg) {
      const f = fg.toLowerCase();
      g = games.find(x => {
        const exe = (store.game(x.id).exe || x.exe || '');
        return exe && path.basename(exe, path.extname(exe)).toLowerCase() === f;
      }) || null;
    }
    let display = null;
    try { display = await win.call('current'); } catch {}
    return { foreground: fg, game: g ? publicGame(g) : null, look: currentLook, display,
      tier: g ? store.game(g.id).tier || 'native' : null };
  });

  handle('overlay:hide', async () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); });

  // Newest Steam screenshot, preferring the given game's own (gameId like "steam:1091500").
  handle('screenshot:latest', async gameId => {
    const { steam } = await library.steamRoots();
    if (!steam) return null;
    const base = path.join(steam, 'userdata');
    const appid = /^steam:(\d+)$/.exec(gameId || '');
    const pick = async only => {
    let newest = null;
    for (const user of await fs.promises.readdir(base).catch(() => [])) {
      const remote = path.join(base, user, '760', 'remote');
      for (const app of await fs.promises.readdir(remote).catch(() => [])) {
        if (only && app !== only) continue;
        const dir = path.join(remote, app, 'screenshots');
        for (const f of await fs.promises.readdir(dir).catch(() => [])) {
          if (!/\.(jpe?g|png)$/i.test(f)) continue;
          const p = path.join(dir, f);
          const st = await fs.promises.stat(p).catch(() => null);
          if (st && (!newest || st.mtimeMs > newest.t)) newest = { p, t: st.mtimeMs };
        }
      }
    }
    return newest;
    };
    const hit = (appid && await pick(appid[1])) || (gameId === undefined ? await pick(null) : null);
    return hit ? readImage(hit.p) : null;
  });

  handle('screenshot:pick', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return readImage(r.filePaths[0]);
  });

  handle('settings:patch', async p => {
    const allowed = {};
    for (const k of ['overlay', 'lookHotkeys', 'transition', 'reducedTransparency', 'ambientMotion', 'dlss5Unlock', 'dlss5PatchedRuntime', 'dlss5UnlockSource']) if (k in p) allowed[k] = p[k];
    store.patch(allowed);
    const failed = registerShortcuts();
    broadcast('settings', store.get());
    return { settings: store.get(), failedShortcuts: failed };
  });

  handle('shell:open', async url => {
    if (!/^https:\/\/(reshade\.me|www\.nvidia\.com|developer\.nvidia\.com)\//.test(url)) throw new Error('Blocked URL');
    await shell.openExternal(url);
  });
}

async function readImage(p) {
  const buf = await fs.promises.readFile(p);
  if (buf.length > 25 * 1024 * 1024) throw new Error('Image is too large to preview.');
  const mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
  return { name: path.basename(p), dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(async () => {
  app.setAppUserModelId('com.refract.app');
  store = new Store(app.getPath('userData'));
  win = new WinHelper(path.join(__dirname, '..', 'scripts', 'winhelper.ps1'));
  session = new Session(win, store, broadcast);
  nativeTheme.themeSource = 'dark';
  protocol.handle('refract-art', req => serveArt(req).catch(() => new Response('error', { status: 500 })));
  registerIpc();
  gpu = await nvidia.getInfo();
  // If Refract crashed mid-session, put the desktop back first.
  if (store.get().nativeMode) session.restore().catch(() => {});
  createMain();
  if (SELFTEST) {
    const failedShortcuts = registerShortcuts();
    require('./selftest').run({ app, win, store, session, library, dlss, reshade, nvidia, globalShortcut, failedShortcuts,
      getGames: () => games, setGames: g => { games = g; }, refreshReshade, publicGame,
      getMain: () => mainWin, getOverlay: () => overlayWin, toggleOverlay, rendererLog, rendererReady,
      getTelemetry: () => lastTelemetry, gpu });
    return;
  }
  registerShortcuts();
  win.start().catch(() => {});
});

app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

let quitting = false;
app.on('before-quit', async e => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  globalShortcut.unregisterAll();
  if (stopTelemetry) stopTelemetry();
  await session.shutdown().catch(() => {});
  win.stop();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
