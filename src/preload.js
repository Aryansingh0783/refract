'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('refract', {
  state: () => invoke('app:state'),
  scan: () => invoke('library:scan'),
  addFolder: () => invoke('library:addFolder'),
  patchGame: (id, patch) => invoke('game:patch', id, patch),
  pickExe: id => invoke('game:pickExe', id),
  swapDll: (gameId, dllPath) => invoke('dlss:swap', gameId, dllPath),
  restoreDll: (gameId, dllPath) => invoke('dlss:restore', gameId, dllPath),
  installLooks: gameId => invoke('reshade:install', gameId),
  feederStatus: gameId => invoke('feeder:status', gameId),
  feederInstall: gameId => invoke('feeder:install', gameId),
  feederRestore: gameId => invoke('feeder:restore', gameId),
  pickPatchedRuntime: () => invoke('dlss5:pickPatchedRuntime'),
  restoreAll: gameId => invoke('game:restoreAll', gameId),
  restoreEverything: () => invoke('library:restoreEverything'),
  endSession: () => invoke('session:end'),
  gameLog: gameId => invoke('game:log', gameId),
  exportDiagnostics: gameId => invoke('diagnostics:export', gameId),
  writeErrorReport: gameId => invoke('errorreport:write', gameId),
  setMfg: (gameId, patch) => invoke('mfg:set', gameId, patch),
  neuralStatus: () => invoke('neuralscreen:status'),
  neuralStart: gameId => invoke('neuralscreen:start', gameId),
  neuralStop: () => invoke('neuralscreen:stop'),
  closeOverlay: () => invoke('overlay:close'),
  pinOverlay: on => invoke('overlay:pin', on),
  markOnboarded: () => invoke('app:onboarded'),
  removeLooks: gameId => invoke('reshade:uninstall', gameId),
  saveLooks: payload => invoke('looks:save', payload),
  selectLook: id => invoke('look:select', id),
  ladder: () => invoke('display:ladder'),
  applyTier: tier => invoke('display:apply', tier),
  restoreDisplay: () => invoke('display:restore'),
  launch: gameId => invoke('session:launch', gameId),
  toggleNeural: gameId => invoke('neural:toggle', gameId),
  toggleOverlay: () => invoke('overlay:toggle'),
  overlayContext: () => invoke('overlay:context'),
  hideOverlay: () => invoke('overlay:hide'),
  openFolder: id => invoke('game:openFolder', id),
  ready: info => ipcRenderer.send('renderer:ready', info),
  latestScreenshot: gameId => invoke('screenshot:latest', gameId),
  pickScreenshot: () => invoke('screenshot:pick'),
  patchSettings: p => invoke('settings:patch', p),
  openExternal: url => invoke('shell:open', url),
  on: (ch, fn) => {
    const allowed = ['telemetry', 'look', 'display', 'session', 'settings', 'library', 'dlss5:progress', 'hotkeys', 'overlay:mode', 'neuralscreen', 'gamelog', 'errorreport'];
    if (!allowed.includes(ch)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
