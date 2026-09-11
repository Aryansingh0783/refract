// Test-only mock of window.refract for rendering the UI outside Electron.
(function () {
  const ok = data => Promise.resolve({ ok: true, data });
  const mk = (id, name, store, v, extra = {}) => ({
    id, name, store, dir: 'D:\\SteamLibrary\\steamapps\\common\\' + name, exe: 'D:\\SteamLibrary\\steamapps\\common\\' + name + '\\bin\\x64\\game.exe',
    hasDlss: !!v, dlls: v ? [
      { file: 'nvngx_dlss.dll', path: 'D:\\x\\nvngx_dlss.dll', version: v, description: 'NVIDIA Deep Learning SuperSampling', backup: false },
      { file: 'nvngx_dlssg.dll', path: 'D:\\x\\nvngx_dlssg.dll', version: v, description: 'NVIDIA DLSS Frame Generation', backup: true }] : [],
    looks: extra.looks || { reshade: false, installed: false }, cfg: { tier: extra.tier || 'native', neuralKey: extra.key || null },
    art: extra.art || {},
  });
  function scene(w, h, hue, title) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `hsl(${hue} 55% 62%)`); g.addColorStop(.55, `hsl(${hue + 30} 70% 70%)`); g.addColorStop(.56, `hsl(${hue + 180} 30% 22%)`); g.addColorStop(1, `hsl(${hue + 180} 30% 8%)`);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,245,215,.9)'; x.beginPath(); x.arc(w * .7, h * .42, h * .1, 0, 7); x.fill();
    for (let i = 0; i < 18; i++) { x.fillStyle = `hsl(${hue + 200} 25% ${10 + i * 2}%)`; x.fillRect(i * w / 18, h * (.58 - (i % 5) * .06), w / 20, h); }
    if (title) { x.fillStyle = '#fff'; x.font = `700 ${Math.round(w / 9)}px sans-serif`; x.fillText(title, w * .08, h * .9); }
    return c.toDataURL('image/jpeg', .85);
  }
  const art = (hue, t) => ({ hero: scene(1920, 620, hue), capsule: scene(300, 450, hue, t) });
  const games = [
    mk('steam:1', 'Cyberpunk 2077', 'steam', '310.4.0.0', { looks: { reshade: true, installed: true, startLook: 'cinematic' }, tier: 'balanced', key: 'F9', art: art(20, 'CP') }),
    mk('steam:2', 'Alan Wake 2', 'epic', '310.2.1.0', { looks: { reshade: true, installed: false }, art: art(200, 'AW') }),
    mk('steam:3', 'Black Myth Wukong', 'steam', '310.3.0.0', { art: art(40, 'BM') }),
    mk('steam:4', 'Indiana Jones and the Great Circle', 'steam', '310.4.0.0'),
    mk('steam:5', 'Hades II', 'steam', null),
  ];
  const settings = { theme: 'system', overlay: { hotkey: 'Alt+Shift+R' }, lookHotkeys: { default: 'Alt+Shift+1', cinematic: 'Alt+Shift+2', natural: 'Alt+Shift+3' },
    looks: {}, startLook: 'default', transition: 0.6 };
  const tel = { powerDraw: 247.3, powerLimit: 250, util: 99, temp: 71, clock: 2610, memUsed: 9012, memTotal: 12227, pstate: 'P0', powerLimited: true };
  const listeners = {};
  function shot() {
    const c = document.createElement('canvas'); c.width = 960; c.height = 540;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 540); g.addColorStop(0, '#8fb3d9'); g.addColorStop(0.55, '#f1c38a'); g.addColorStop(0.56, '#3b4a3a'); g.addColorStop(1, '#141a14');
    x.fillStyle = g; x.fillRect(0, 0, 960, 540);
    x.fillStyle = '#fff6d8'; x.beginPath(); x.arc(700, 250, 60, 0, 7); x.fill();
    for (let i = 0; i < 14; i++) { x.fillStyle = `rgb(${30 + i * 6},${40 + i * 5},${38 + i * 3})`; x.fillRect(i * 70, 330 - (i % 4) * 30, 60, 220); }
    return { name: 'test-frame.png', dataUrl: c.toDataURL() };
  }
  window.refract = {
    state: () => ok({ settings, gpu: { available: true, name: 'NVIDIA GeForce RTX 5070', driver: '616.92', rtx50: true, driverStatus: 'tested', testedDriver: '616.92', powerLimit: 250, powerMax: 300, memoryTotal: 12227 },
      telemetry: tel, games, looks: [], currentLook: 'cinematic', platform: 'win32' }),
    scan: () => ok(games), addFolder: () => ok(null), patchGame: (id, p) => ok({ ...games.find(g => g.id === id), cfg: { ...games.find(g => g.id === id).cfg, ...p } }),
    pickExe: id => ok(games.find(g => g.id === id)), swapDll: () => ok(games[0]), restoreDll: () => ok(games[0]),
    installLooks: () => ok(games[1]), removeLooks: () => ok(games[0]), saveLooks: () => ok({ updated: 1 }), selectLook: id => ok(id),
    ladder: () => ok({ current: { width: 1920, height: 1080, hz: 239 }, native: { width: 1920, height: 1080, hz: 239 }, ladder: [
      { id: 'native', label: 'Native', mode: { width: 1920, height: 1080, hz: 239, pixelSaving: 0 } },
      { id: 'balanced', label: 'Balanced', mode: { width: 1600, height: 900, hz: 239, pixelSaving: 0.3056 } },
      { id: 'performance', label: 'Performance', mode: { width: 1280, height: 720, hz: 239, pixelSaving: 0.5556 } }] }),
    applyTier: () => ok({ width: 1600, height: 900 }), restoreDisplay: () => ok(null), launch: () => ok(true), toggleNeural: () => ok('F9'),
    toggleOverlay: () => ok(true), hideOverlay: () => ok(null),
    overlayContext: () => ok({ foreground: 'Cyberpunk2077', game: games[0], look: 'cinematic', display: { width: 1600, height: 900 }, tier: 'balanced' }),
    latestScreenshot: () => ok(shot()), pickScreenshot: () => ok(shot()), patchSettings: p => ok({ settings: { ...settings, ...p }, failedShortcuts: [] }),
    openExternal: () => ok(null), openFolder: () => ok(true), ready: i => { window.__ready = i; },
    feederStatus: id => ok({ installed: false, eligible: true, apiLabel: 'DirectX 12',
      payload: id === 'steam:5' ? { ok: true, root: 'C:/.../DLSS 5 Swapper', missing: [] } : { ok: true, root: 'C:/.../DLSS 5 Swapper', missing: [] } }),
    feederInstall: id => ok(games.find(g => g.id === id)), feederRestore: id => ok(games.find(g => g.id === id)),
    feederPickPayload: () => ok({ payload: { ok: true, root: 'C:/x', missing: [] }, dir: 'C:/x' }),
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); if (ch === 'telemetry') setTimeout(() => fn(tel), 50); return () => {}; },
  };
})();
