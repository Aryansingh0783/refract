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
const reshadelog = require('./core/reshadelog');
const diagnostics = require('./core/diagnostics');
const errorreport = require('./core/errorreport');
const gpupref = require('./core/gpupref');
const mfgcore = require('./core/mfg');
const mfgcfg = require('./core/mfgconfig');
const { ladder } = require('./core/display');
const { Session } = require('./core/session');
const { NeuralScreen, PROFILES: NS_PROFILES, HOTKEYS: NS_HOTKEYS } = require('./core/neuralscreen');
const { LOOKS, KEYCODES } = require('./shared/looks');

const SELFTEST = process.argv.includes('--selftest');
// Headless: undo Refract's changes in every game, then exit. Run by the uninstaller.
const RESTORE_ALL = process.argv.includes('--restore-all');
if (!SELFTEST && !RESTORE_ALL && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// Game art is served through a private scheme so the renderer never sees raw paths and
// canvas reads (Looks preview) stay untainted.
protocol.registerSchemesAsPrivileged([{ scheme: 'refract-art',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let store, win, session, neural;
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

const exeDirOf = g => g.exeDir || (g.exe ? path.dirname(g.exe) : g.dir);

// Is a process with this executable name alive? Used to refuse writing into a running game.
async function isRunning(exeName) {
  try {
    const r = await win.call('procstate', { name: exeName }, 6000);
    return Number(r && r.count) > 0;
  } catch { return false; }
}

// Has Refract changed anything in this game's folder? Drives the "Restore original" button.
function modifiedState(g) {
  const dir = exeDirOf(g);
  const parts = [];
  if (feeder.status(dir).installed) parts.push('DLSS 5');
  if ((g.looks && g.looks.installed) || reshade.touched(dir)) parts.push('Looks');
  if ((g.dlls || []).some(d => d.backup)) parts.push('DLSS files');
  return parts;
}

function publicGame(g) {
  const art = {};
  for (const k of Object.keys(g.art || {})) art[k] = `refract-art://game/${encodeURIComponent(g.id)}/${k}`;
  const dir = exeDirOf(g);
  let dlss5 = { installed: false, needsAttention: false };
  try { dlss5 = feeder.quickCheck(dir); } catch {}
  return { ...g, art, cfg: store.game(g.id), modified: modifiedState(g), dlss5, lastRun: lastRunVerdicts[g.id] || null };
}

// Undo everything Refract ever changed for one game: DLSS 5 components, looks + the ReShade
// runtime it installed (and the files ReShade generated), swapped DLSS DLLs, and a lowered
// desktop resolution. Order matters: the DLSS 5 manifest first (it may have upgraded a
// ReShade that the looks feature installed), then looks/ReShade, then DLLs.
async function restoreGame(g) {
  const dir = exeDirOf(g);
  const done = [];
  if (feeder.status(dir).installed) { await feeder.restore(dir); done.push('DLSS 5 components'); }
  done.push(...await reshade.removeAll(dir, g.reshadeIni));
  for (const d of (g.dlls || []).filter(x => x.backup)) { await dlss.restore(d.path); done.push(d.file); }
  if (store.get().nativeMode) { await session.restore().catch(() => {}); done.push('desktop resolution'); }
  const cfg = store.game(g.id);
  if (cfg.gpuPreference !== undefined && g.exe) {
    await gpupref.restore(g.exe, cfg.gpuPreference).catch(() => {});
    store.patchGame(g.id, { gpuPreference: undefined });
    done.push('graphics preference');
  }
  return done;
}

// Every game Refract touched, restored. Used by Settings and by the uninstaller.
async function restoreEverything() {
  if (!games.length) games = await Promise.all((await library.scanAll(store.get().manualDirs)).map(refreshReshade));
  const report = [];
  for (const g of games) {
    if (!modifiedState(g).length) continue;
    try { report.push({ game: g.name, restored: await restoreGame(g) }); }
    catch (e) { report.push({ game: g.name, error: String(e && e.message || e) }); }
  }
  return report;
}

function unlockSetting() {
  const s = store.get();
  // The universal neural-rendering runtime is on unless the user switched it off.
  return { enabled: s.dlss5Unlock !== false, runtime: s.dlss5PatchedRuntime || null, source: s.dlss5UnlockSource || 'auto' };
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

// The overlay has two states:
//   interactive  opened with the hotkey: shown, focused and clickable. Taking focus makes the
//                game release the mouse, so the panel can actually be used mid-game. Press the
//                hotkey again, Esc, or click back into the game to close it.
//   HUD          optional ("Pin as HUD"): stays on screen after closing, click-through and
//                never focused, so it shows live stats without getting in the way.
// It only draws over borderless/windowed games; exclusive fullscreen covers every window.
const OVERLAY_W = 396, OVERLAY_H = 560;
let overlayGame = null;      // process name to hand focus back to

function overlayBounds() {
  const saved = store.get().overlay;
  const def = screen.getPrimaryDisplay().workArea;
  let x = saved.x ?? def.x + def.width - OVERLAY_W - 28;
  let y = saved.y ?? def.y + Math.round((def.height - OVERLAY_H) / 2);
  // A position saved on a monitor that is no longer there would put it off-screen.
  const onScreen = screen.getAllDisplays().some(d => x >= d.workArea.x - 40 && y >= d.workArea.y - 40
    && x + OVERLAY_W <= d.workArea.x + d.workArea.width + 40 && y + OVERLAY_H <= d.workArea.y + d.workArea.height + 40);
  if (!onScreen) { x = def.x + def.width - OVERLAY_W - 28; y = def.y + Math.round((def.height - OVERLAY_H) / 2); }
  return { x, y, width: OVERLAY_W, height: OVERLAY_H };
}

function createOverlay() {
  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false, transparent: true, resizable: false, movable: true,
    icon: ICON,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    type: 'toolbar',            // no taskbar/alt-tab entry
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watchConsole('overlay', overlayWin.webContents);
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.on('moved', () => { const [x, y] = overlayWin.getPosition(); store.patch({ overlay: { ...store.get().overlay, x, y } }); });
  overlayWin.on('blur', () => { if (overlayWin && overlayWin.isVisible() && overlayInteractive) closeOverlay(); });
  for (const ev of ['show', 'hide']) overlayWin.on(ev, telemetryDemand);
  overlayWin.on('closed', () => { overlayWin = null; overlayInteractive = false; });
}

let overlayInteractive = false;
async function openOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  // Remember the game so focus can go back to it.
  overlayGame = session.active ? session.active.name : (await win.call('foreground', {}, 3000).catch(() => '')) || null;
  if (overlayGame && /^(refract|electron)$/i.test(overlayGame)) overlayGame = session.active ? session.active.name : null;
  overlayInteractive = true;
  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.setFocusable(true);
  overlayWin.setBounds(overlayBounds());
  overlayWin.show();
  overlayWin.moveTop();
  overlayWin.focus();
  overlayWin.webContents.send('overlay:mode', { interactive: true, pinned: !!store.get().overlay.pinned, hotkey: activeHotkeys.overlay });
  overlayWin.webContents.send('look', { look: currentLook });
}

function closeOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayInteractive = false;
  if (store.get().overlay.pinned) {
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.setFocusable(false);
    overlayWin.showInactive();
    overlayWin.webContents.send('overlay:mode', { interactive: false, pinned: true, hotkey: activeHotkeys.overlay });
  } else {
    overlayWin.hide();
  }
  if (overlayGame) win.call('focus', { name: overlayGame }, 3000).catch(() => {});
}

function toggleOverlay() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible() && overlayInteractive) { closeOverlay(); return false; }
  openOverlay().catch(() => {});
  return true;
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

// If another app already owns the overlay hotkey, fall back to the next free one and tell the
// UI which is live, so the hint on screen is always the key that actually works.
const OVERLAY_FALLBACKS = ['Ctrl+Alt+R', 'Ctrl+Shift+F10', 'Alt+F10', 'Ctrl+F12'];
const activeHotkeys = { overlay: null, looks: {} };
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.get();
  const failed = [];
  const tryReg = (acc, fn) => { try { return !!acc && globalShortcut.register(acc, fn); } catch { return false; } };
  activeHotkeys.overlay = null;
  for (const acc of [s.overlay.hotkey, ...OVERLAY_FALLBACKS.filter(a => a !== s.overlay.hotkey)]) {
    if (tryReg(acc, toggleOverlay)) { activeHotkeys.overlay = acc; break; }
    failed.push(acc);
  }
  activeHotkeys.looks = {};
  for (const [id, acc] of Object.entries(s.lookHotkeys)) {
    if (tryReg(acc, () => selectLook(id).catch(() => {}))) activeHotkeys.looks[id] = acc; else failed.push(acc);
  }
  broadcast('hotkeys', activeHotkeys);
  return failed;
}

// ---------------------------------------------------------------- IPC
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: dlss.explain(err) }; }
  });
}

// What the game's own ReShade.log said after the last session, per game.
const lastRunVerdicts = {};
function readGameLog(g) {
  const r = reshadelog.inspectGame(exeDirOf(g));
  const out = { verdict: r.verdict, line: r.line, at: r.at, file: r.file, evaluations: r.evaluations,
    adapter: r.adapter, driver: r.driver, addon: r.addon, ...(reshadelog.VERDICTS[r.verdict] || {}) };
  lastRunVerdicts[g.id] = out;
  return out;
}

// ---------------------------------------------------------------- automatic failure reports
// RTX 30 and RTX 40 are the cards Refract cannot test on. When DLSS 5 does not work on one of
// them, the app does not wait to be asked: it writes a named report onto the Desktop (and a
// diagnostics zip beside it, once a day) so the failure can be read without a screenshot.
const reportedToday = new Set();

async function reportFailure({ game = null, verify = null, log = null, error = null, phase = null,
  route = null, notes = null } = {}) {
  try {
    const failure = errorreport.failureOf({ gpu, verify, log, error, phase });
    if (!failure) return null;
    const exeDir = game ? exeDirOf(game) : null;
    const redact = diagnostics.redactor();
    let antivirus = null;
    if (failure.code === 'files-removed' || failure.code === 'runtime-missing') {
      try {
        const def = require('./core/defender');
        antivirus = def.explain(await def.detectionsFor([exeDir].filter(Boolean)));
      } catch {}
    }
    const desktop = safeDesktop();
    const res = errorreport.write({
      gpu, game, verify, log, failure, route, notes, antivirus, redact, desktop,
      appVersion: app.getVersion(),
      folder: exeDir ? diagnostics.folderInventory(exeDir, redact) : null,
      payload: diagnostics.payloadCheck(),
    });
    if (res && res.written) {
      await dropDiagnostics({ game, exeDir, desktop });
      logInstall({ event: 'error-report', game: game && game.name, code: res.code, file: res.path });
      broadcast('errorreport', { path: res.path, code: res.code, summary: res.summary,
        game: game ? game.name : null, gpu: gpu && gpu.name || null });
    }
    return res;
  } catch (e) {
    try { logInstall({ event: 'error-report-failed', error: String(e && e.message || e) }); } catch {}
    return null;
  }
}

// The full bundle lands beside the log, but only once per card per day: it is ~1 MB and the
// point is a Desktop the user can still read.
async function dropDiagnostics({ game, exeDir, desktop }) {
  const name = errorreport.fileName(gpu, new Date(), 'zip');
  const target = path.join(desktop, name);
  if (reportedToday.has(name) || fs.existsSync(target)) return null;
  reportedToday.add(name);
  try {
    const out = await diagnostics.collectAsync({
      game, exeDir, gpu, settings: store.get(), appVersion: app.getVersion(),
      userData: app.getPath('userData'),
    });
    fs.writeFileSync(target, out.buffer);
    return target;
  } catch { return null; }
}

function safeDesktop() {
  try {
    const d = app.getPath('desktop');
    if (d && fs.existsSync(d)) return d;
  } catch {}
  const home = require('os').homedir();
  const d = path.join(home, 'Desktop');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

// A durable record of every install, so a machine that failed can be understood later.
function logInstall(entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(app.getPath('userData'), 'install.log'), line);
  } catch {}
}

// The display's refresh rate, for the frame cap. Cached: it only changes when the user does.
let lastRefresh = null;
async function refreshHz() {
  try { const c = await win.call('current'); if (c && c.hz) lastRefresh = c.hz; } catch {}
  return lastRefresh;
}

// Multi Frame Generation for one game: whether this card and game can have it, what is set,
// and what enabling it would actually write.
function mfgInfo(g, dir) {
  const cfg = store.game(g.id).mfg || mfgcore.defaults();
  const gate = mfgcore.eligible(gpu, { dx: g.dx, bitness: g.bitness, apiLabel: g.apiLabel },
    { experimentalTuring: store.get().mfgExperimental === true });
  let installed = null;
  try { installed = (feeder.status(dir).mfg) || null; } catch {}
  const preview = mfgcfg.plan({ gpu, refresh: lastRefresh, mfg: { ...cfg, enabled: true } });
  return {
    eligible: gate.ok, reason: gate.reason || null, code: gate.code || null,
    experimental: !!gate.experimental, multipliers: gate.multipliers || mfgcfg.MULTIPLIER_CHOICES,
    setting: cfg, installed, refresh: lastRefresh, preview,
    engine: require('./core/mfgassets').ENGINE_VERSION,
  };
}

// What the game's own DLSS Super Resolution runtime is, and what Refract could put there.
function srInfo(exeDir) {
  const bundled = require('./core/bundle').file(require('./core/dlss5assets').SR_REL);
  const ours = require('./core/dlss5assets').SR_VERSION;
  const d = feeder.srDecision(bundled ? ours : null, path.join(exeDir, 'nvngx_dlss.dll'));
  return { ours: bundled ? ours : null, theirs: d.theirs || null, upgrade: !!d.upgrade, why: d.why };
}

function neuralInfo() {
  const av = neural.available(gpu);
  return { available: av.ok, reason: av.reason || null, version: neural.version(), state: neural.state(),
    settings: store.get().neuralScreen, profiles: NS_PROFILES, hotkeys: NS_HOTKEYS };
}

// Games set to the screen engine get NeuralScreen started when their window appears and
// stopped when the session ends (only if Refract started it for that game).
async function onSessionEvent(ch, d) {
  if (ch !== 'session' || !neural || !d) return;
  try {
    if (d.state === 'running') {
      const g = session.active && session.active.game;
      if (g && store.game(g.id).engine === 'screen' && neural.available(gpu).ok) {
        await neural.start({ ...store.get().neuralScreen, gpu }, g.name);
      }
    } else if (d.state === 'ended') {
      if (neural.startedFor && neural.startedFor === d.game) await neural.stop();
      // The game just wrote its log. Read it and say what actually happened.
      const g = games.find(x => x.name === d.game);
      if (g) setTimeout(() => {
        try {
          const log = readGameLog(g);
          broadcast('gamelog', { gameId: g.id, log });
          // Only for games Refract actually set up: a game with no install has nothing to fail.
          if (feeder.status(exeDirOf(g)).installed) {
            reportFailure({ game: g, log, phase: 'session', route: feeder.status(exeDirOf(g)).route }).catch(() => {});
          }
        } catch {}
      }, 1500);
    }
  } catch (e) { broadcast('neuralscreen', { state: 'error', error: String(e && e.message || e) }); }
}

function registerIpc() {
  handle('app:state', async () => ({
    settings: store.get(), gpu, telemetry: lastTelemetry, games: games.map(publicGame),
    looks: LOOKS, currentLook, platform: process.platform, selftest: SELFTEST,
    session: session.active ? { state: session.active.seen ? 'running' : 'launching', game: session.active.game.name } : null,
    hotkeys: activeHotkeys, payload: require('./core/bundle').info(), neuralScreen: neuralInfo(),
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
    if (patch.engine) allowed.engine = patch.engine === 'screen' ? 'screen' : 'ingame';
    if ('hooks' in patch) allowed.hooks = patch.hooks === 1 || patch.hooks === 2 ? patch.hooks : null;
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
    await refreshHz();
    const unlock = unlockSetting();
    const gate = feeder.plan(dir, { bitness: g.bitness || 64, api: g.api || 'dxgi', dx: g.dx || null, gpu, unlock });
    const installed = feeder.status(dir).installed;
    return {
      installed,
      verify: installed ? feeder.verify(dir, { gpu, unlock, route: feeder.status(dir).route }) : null,
      dlssSr: srInfo(dir),
      hooks: { perGame: store.game(gameId).hooks || null, auto: feeder.hooksFor(gpu) },
      upgradeSr: store.get().dlss5UpgradeSr !== false,
      log: readGameLog(g),
      mfg: mfgInfo(g, dir),
      eligible: gate.ok,
      reason: gate.reason || null,
      already: !!gate.already,
      warnings: gate.warnings || [],
      route: gate.route || null,
      routeLabel: gate.label || null,
      repair: !!gate.repair,
      blocked: gate.blocked || null,
      nr: gate.nr || null,
      actions: gate.actions || [],
      gpuName: gpu && gpu.name || null,
      gpuSeries: gpu && gpu.series || null,
      apiLabel: g.apiLabel,
      gpuSupport: gpu && gpu.dlss5 || null,
      unlock,
    };
  });

  handle('feeder:install', async gameId => {
    const g = findGame(gameId);
    // Writing into a folder the game has open is how half-copied DLLs happen.
    if (g.exe && await isRunning(path.basename(g.exe))) {
      throw new Error(`${g.name} is running. Close it first — Refract writes files into its folder.`);
    }
    let result;
    try {
      result = await feeder.install(
        { exe: g.exe, api: g.api || 'dxgi', apiLabel: g.apiLabel, bitness: g.bitness || 64, dx: g.dx || null },
        null,
        {
          cacheRoot: cacheRoot(),
          onProgress: p => broadcast('dlss5:progress', { gameId, ...p }),
          gpu,
          unlock: unlockSetting(),
          upgradeSr: store.get().dlss5UpgradeSr !== false,
          hooks: store.game(gameId).hooks || null,
          mfg: store.game(gameId).mfg || null,
          refresh: await refreshHz(),
        },
      );
    } catch (e) {
      logInstall({ game: g.name, exe: g.exe, ok: false, error: String(e && e.message || e), gpu: gpu && gpu.name });
      await reportFailure({ game: g, error: e, phase: 'install' });
      throw e;
    }
    // Hybrid laptops: a game Windows runs on the iGPU can never do DLSS 5.
    try {
      const cfg = store.game(g.id);
      if (g.exe && cfg.gpuPreference === undefined) {
        const pref = await gpupref.preferHighPerformance(g.exe);
        if (pref.changed) store.patchGame(g.id, { gpuPreference: pref.previous });
      }
    } catch {}
    // A file we just wrote that is already gone is an antivirus, not a bug in the copy.
    let antivirus = null;
    if (result.verify && result.verify.vanished) {
      try { antivirus = require('./core/defender').explain(await require('./core/defender').detectionsFor([exeDirOf(g)])); } catch {}
    }
    logInstall({ game: g.name, exe: g.exe, ok: result.ok, route: result.route, gpu: gpu && gpu.name,
      notes: result.notes, failed: (result.verify && result.verify.failed || []).map(f => f.id), antivirus });
    // The install checked itself and something is wrong: say so on the Desktop, not just in a toast.
    let errorReport = null;
    if (!result.ok) {
      errorReport = await reportFailure({ game: g, verify: result.verify, phase: 'install',
        route: result.route, notes: result.notes });
    }
    const out = await reinspect(gameId);
    return { ...out, install: { ok: result.ok, route: result.route, notes: result.notes, verify: result.verify, antivirus, errorReport } };
  });

  // Multi Frame Generation. Turning it on records the choice and then runs the ordinary
  // install, which is what actually puts the engine in the folder — so Enable and Repair are
  // the same code path and can never drift apart.
  handle('mfg:set', async (gameId, patch) => {
    const g = findGame(gameId);
    const cur = store.game(gameId).mfg || mfgcore.defaults();
    const next = { ...cur, ...(patch || {}) };
    if (next.enabled) {
      const gate = mfgcore.eligible(gpu, { dx: g.dx, bitness: g.bitness, apiLabel: g.apiLabel },
        { experimentalTuring: store.get().mfgExperimental === true });
      if (!gate.ok) throw new Error(gate.reason);
    }
    store.patchGame(gameId, { mfg: next });
    await refreshHz();
    return mfgInfo(g, exeDirOf(g));
  });

  // The game's own log, re-read on demand (the card asks after a session ends).
  handle('game:log', async gameId => readGameLog(findGame(gameId)));

  // The same report the app writes by itself, on demand — for a card that fails silently or a
  // user who wants to send something before playing again.
  handle('errorreport:write', async gameId => {
    const g = gameId ? findGame(gameId) : null;
    const dir = g ? exeDirOf(g) : null;
    const verify = dir && feeder.status(dir).installed
      ? feeder.verify(dir, { gpu, unlock: unlockSetting(), route: feeder.status(dir).route }) : null;
    const log = g ? readGameLog(g) : null;
    const failure = errorreport.failureOf({ gpu, verify, log, phase: 'manual' }) || {
      code: 'manual', phase: 'manual', level: 'warn',
      summary: verify && verify.ok
        ? 'No failure detected — this report was written on request.'
        : 'Written on request; see the checks below.',
    };
    const res = await reportFailure({ game: g, verify, log, phase: 'manual',
      route: dir ? feeder.status(dir).route : null }) ||
      errorreport.write({ gpu, game: g, verify, log, failure, desktop: safeDesktop(),
        appVersion: app.getVersion(), redact: diagnostics.redactor(),
        folder: dir ? diagnostics.folderInventory(dir, diagnostics.redactor()) : null,
        payload: diagnostics.payloadCheck() });
    if (res && res.path) { try { shell.showItemInFolder(res.path); } catch {} }
    return res;
  });

  // Everything needed to debug a machine that isn't this one.
  handle('diagnostics:export', async gameId => {
    const g = gameId ? findGame(gameId) : null;
    const out = await diagnostics.collectAsync({
      game: g, exeDir: g ? exeDirOf(g) : null, gpu, settings: store.get(),
      appVersion: app.getVersion(), userData: app.getPath('userData'),
      session: session.active ? { game: session.active.game.name, seen: session.active.seen } : null,
    });
    const r = await dialog.showSaveDialog(mainWin, { title: 'Save diagnostics', defaultPath: path.join(app.getPath('downloads'), out.name), filters: [{ name: 'Zip archive', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, out.buffer);
    shell.showItemInFolder(r.filePath);
    return { path: r.filePath, verdict: out.report.game && out.report.game.log ? out.report.game.log.verdict : null };
  });

  // Undo everything Refract ever changed for this game: DLSS 5 components, looks + the
  // ReShade runtime it installed (and the files ReShade generated), swapped DLSS DLLs, and a
  // lowered desktop resolution. Order matters: the DLSS 5 manifest first (it may have
  // upgraded a ReShade that the looks feature installed), then looks/ReShade, then DLLs.
  handle('game:restoreAll', async gameId => {
    const g = findGame(gameId);
    if (session.active && session.active.game.id === g.id) throw new Error('Close the game first, then restore.');
    const done = await restoreGame(g);
    const out = await reinspect(gameId);
    out.restored = done;
    return out;
  });
  handle('library:restoreEverything', async () => restoreEverything());

  // An alternative neural-rendering runtime for RTX 30/40. The user supplies their own file;
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
  handle('overlay:close', async () => { closeOverlay(); return true; });
  handle('overlay:pin', async on => {
    store.patch({ overlay: { ...store.get().overlay, pinned: !!on } });
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:mode', { interactive: overlayInteractive, pinned: !!on, hotkey: activeHotkeys.overlay });
    return !!on;
  });
  handle('session:end', async () => session.end('user'));

  // ---- NeuralScreen (screen-space DLSS 5 engine)
  handle('neuralscreen:status', async () => neuralInfo());
  handle('neuralscreen:start', async gameId => {
    const g = gameId ? findGame(gameId) : null;
    await neural.start({ ...store.get().neuralScreen, gpu }, g ? g.name : null);
    return neuralInfo();
  });
  handle('neuralscreen:stop', async () => { await neural.stop(); return neuralInfo(); });
  handle('app:onboarded', async () => { store.patch({ onboarded: true }); return true; });

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

  handle('overlay:hide', async () => { closeOverlay(); return true; });

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
    for (const k of ['overlay', 'lookHotkeys', 'transition', 'reducedTransparency', 'ambientMotion', 'dlss5Unlock', 'dlss5PatchedRuntime', 'dlss5UnlockSource', 'dlss5UpgradeSr']) if (k in p) allowed[k] = p[k];
    if (p.neuralScreen) {
      const n = p.neuralScreen, cur = store.get().neuralScreen;
      allowed.neuralScreen = { ...cur,
        ...(NS_PROFILES.includes(n.profile) ? { profile: n.profile } : {}),
        ...('faster' in n ? { faster: !!n.faster } : {}),
        ...(Number.isFinite(+n.workScale) ? { workScale: Math.min(1, Math.max(0.3, +n.workScale)) } : {}) };
    }
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
  session = new Session(win, store, (ch, d) => { broadcast(ch, d); onSessionEvent(ch, d); });
  neural = new NeuralScreen({ home: path.join(app.getPath('userData'), 'neuralscreen'), cacheRoot: cacheRoot(), emit: broadcast });
  nativeTheme.themeSource = 'dark';
  protocol.handle('refract-art', req => serveArt(req).catch(() => new Response('error', { status: 500 })));
  if (RESTORE_ALL) {
    let report;
    try { report = await restoreEverything(); } catch (e) { report = [{ error: String(e && e.message || e) }]; }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'restore-report.json'), JSON.stringify({ at: new Date().toISOString(), report }, null, 2)); } catch {}
    win.stop();
    app.exit(0);
    return;
  }
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
  if (neural && neural.startedFor) await neural.stop().catch(() => {});
  win.stop();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
