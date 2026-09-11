'use strict';
// End-to-end self test:  npx electron . --selftest [--out=C:\path]
// Runs every subsystem against the real machine without changing anything permanent:
// display changes are CDS_TEST only, DLL swap and ReShade install run on temp copies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fx2hlsl = require('./core/fx2hlsl');
const { ladder } = require('./core/display');
const reshaderuntime = require('./core/reshaderuntime');
const feeder = require('./core/feeder');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function run(ctx) {
  const outArg = process.argv.find(a => a.startsWith('--out='));
  const out = outArg ? outArg.slice(6) : path.join(ctx.app.getPath('userData'), 'selftest');
  fs.mkdirSync(out, { recursive: true });
  const checks = [];
  const t0 = Date.now();
  async function check(name, fn) {
    const s = Date.now();
    try {
      const r = await fn();
      checks.push({ name, ok: r.ok !== false, detail: r.detail ?? r, ms: Date.now() - s });
    } catch (err) {
      checks.push({ name, ok: false, detail: String(err && err.stack || err).slice(0, 800), ms: Date.now() - s });
    }
  }

  await check('gpu-driver', async () => {
    const g = ctx.gpu;
    return { ok: !!g.available, detail: { name: g.name, driver: g.driver, tested: g.testedDriver, status: g.driverStatus, rtx50: g.rtx50, powerLimit: g.powerLimit } };
  });

  await check('winhelper', async () => {
    const pong = await ctx.win.call('ping');
    const current = await ctx.win.call('current');
    const modes = await ctx.win.call('modes');
    return { ok: pong === 'pong' && current.width > 0 && modes.length > 0, detail: { current, modes: modes.length } };
  });

  await check('display-tiers (CDS_TEST only)', async () => {
    const current = await ctx.win.call('current');
    const modes = await ctx.win.call('modes');
    const rungs = ladder(modes, current);
    const res = [];
    for (const r of rungs) {
      if (!r.mode) { res.push({ tier: r.id, mode: null }); continue; }
      const ok = await ctx.win.call('setMode', { ...r.mode, test: true }).then(() => true, e => e.message);
      res.push({ tier: r.id, mode: `${r.mode.width}x${r.mode.height}@${r.mode.hz}`, test: ok });
    }
    const after = await ctx.win.call('current');
    const unchanged = after.width === current.width && after.height === current.height;
    return { ok: unchanged && res.every(x => x.mode === null || x.test === true), detail: { rungs: res, unchanged } };
  });

  let games = [];
  await check('library-scan', async () => {
    const found = await ctx.library.scanAll(ctx.store.get().manualDirs);
    games = await Promise.all(found.map(ctx.refreshReshade));
    ctx.setGames(games);
    const dl = games.filter(g => g.hasDlss);
    return { ok: games.length > 0, detail: { games: games.length, withDlss: dl.length,
      sample: dl.slice(0, 12).map(g => ({ name: g.name, dlls: g.dlls.map(d => d.file + ' ' + d.version) , exe: g.exe && path.basename(g.exe), reshade: !!g.reshadeIni })) } };
  });

  await check('pe-version', async () => {
    const d = games.flatMap(g => g.dlls)[0];
    if (!d) return { ok: false, detail: 'no DLSS dll on this machine' };
    return { ok: /^\d+\.\d+\.\d+\.\d+$/.test(d.version || ''), detail: { file: d.path, version: d.version, description: d.description } };
  });

  await check('dll-swap-restore (temp copy)', async () => {
    const d = games.flatMap(g => g.dlls).find(x => /^nvngx_dlss\.dll$/i.test(x.file));
    if (!d) return { ok: false, detail: 'no nvngx_dlss.dll found' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-swap-'));
    const target = path.join(dir, 'game', 'nvngx_dlss.dll');
    const source = path.join(dir, 'src', 'nvngx_dlss.dll');
    fs.mkdirSync(path.dirname(target)); fs.mkdirSync(path.dirname(source));
    fs.copyFileSync(d.path, target);
    // make the "new" DLL differ by using another game's copy when available
    const other = games.flatMap(g => g.dlls).find(x => /^nvngx_dlss\.dll$/i.test(x.file) && x.version !== d.version);
    fs.copyFileSync(other ? other.path : d.path, source);
    const before = sha(target);
    const sw = await ctx.dlss.swap(target, source);
    const swapped = sha(target) === sha(source) && fs.existsSync(target + ctx.dlss.SUFFIX);
    const rs = await ctx.dlss.restore(target);
    const restored = sha(target) === before && !fs.existsSync(target + ctx.dlss.SUFFIX);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: swapped && restored, detail: { from: d.version, to: sw.version, restoredTo: rs.version, swapped, restored } };
  });

  await check('reshade-install (temp fixture)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-rs-'));
    const ini = path.join(dir, 'ReShade.ini');
    fs.writeFileSync(ini, '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\nPresetPath=.\\ReShadePreset.ini\r\n');
    fs.writeFileSync(path.join(dir, 'ReShadePreset.ini'), 'Techniques=SMAA@SMAA.fx\r\n');
    const a = await ctx.reshade.install(ini, { startLook: 'cinematic' });
    const b = await ctx.reshade.uninstall(ini);
    const preset = fs.readFileSync(path.join(dir, 'ReShadePreset.ini'), 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: a.installed && a.startLook === 'cinematic' && !b.installed && /SMAA@SMAA\.fx/.test(preset), detail: { installed: a, removed: b } };
  });

  await check('reshade-auto-install (download + extract)', async () => {
    const cache = ctx.app.getPath('userData');
    const plain = await reshaderuntime.ensureReShade(cache, { addon: false, bitness: 64 });
    const addon = await reshaderuntime.ensureReShade(cache, { addon: true, bitness: 64 });
    return { ok: reshaderuntime.isReShade(plain) && reshaderuntime.isAddonReShade(addon),
      detail: { plain: path.basename(plain), plainOk: reshaderuntime.isReShade(plain), addonOk: reshaderuntime.isAddonReShade(addon) } };
  });

  await check('dlss5 additive install/restore (upgrades limited ReShade, keeps game files)', async () => {
    // Offline fixture (no 144 MB download here); the real download path is dlss5assets.
    // This models the real broken case: the game has DLSS and a RenoDX add-on, but a
    // LIMITED ReShade build that silently refuses to load add-ons.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-dlss5-'));
    const P = p => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
    const full = Buffer.concat([Buffer.from('ReShade 6.8.0 '), Buffer.from('Searching for add-ons'), Buffer.alloc(32)]);
    const limited = Buffer.concat([Buffer.from('ReShade 6.8.0 '), Buffer.from('Searching for add-ons'),
      Buffer.from('because this build of ReShade has only limited add-on functionality')]);
    const reshadeDll = P(path.join(dir, 'cache', 'ReShade64.dll')); fs.writeFileSync(reshadeDll, full);
    const addon = P(path.join(dir, 'cache', 'renodx-dlss5-v2.5.addon64')); fs.writeFileSync(addon, 'RENODX');
    const d1 = P(path.join(dir, 'cache', 'sl', 'nvngx_dlss.dll')); fs.writeFileSync(d1, 'PAYLOAD');
    const d2 = P(path.join(dir, 'cache', 'sl', 'nvngx_dlssnr.dll')); fs.writeFileSync(d2, 'PAYLOAD-NR');
    const payload = { ok: true, route: 'native', versions: { renodx5: 'test' }, reshadeDll, addon, addonName: 'renodx-dlss5-v2.5.addon64', dlls: [d1, d2], nvngxDlss: d1 };

    const gameDir = path.join(dir, 'bin'); fs.mkdirSync(gameDir, { recursive: true });
    const exe = path.join(gameDir, 'game.exe'); fs.writeFileSync(exe, 'MZ');
    fs.writeFileSync(path.join(gameDir, 'nvngx_dlss.dll'), 'GAME-OWN');          // version-matched
    fs.writeFileSync(path.join(gameDir, 'renodx-dlss5.addon64'), 'USERS-OWN');   // their add-on
    fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), limited);                   // wrong build

    const gate = feeder.plan(gameDir, { bitness: 64, api: 'dxgi', dx: 12 });
    await feeder.install({ exe, api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64 }, payload, { cacheRoot: path.join(dir, 'cache') });
    const upgraded = reshaderuntime.isAddonReShade(path.join(gameDir, 'dxgi.dll'));
    const ownKept = fs.readFileSync(path.join(gameDir, 'nvngx_dlss.dll'), 'utf8') === 'GAME-OWN';
    const addonKept = fs.readFileSync(path.join(gameDir, 'renodx-dlss5.addon64'), 'utf8') === 'USERS-OWN';
    const noDupe = !fs.existsSync(path.join(gameDir, 'renodx-dlss5-v2.5.addon64'));
    const filled = !fs.existsSync(path.join(gameDir, 'nvngx_dlssnr.dll')); // all-or-nothing: never mix runtimes
    await feeder.restore(gameDir);
    const rolledBack = fs.readFileSync(path.join(gameDir, 'dxgi.dll')).includes(Buffer.from('limited add-on functionality'));
    const leftover = fs.readdirSync(gameDir).filter(f => !['game.exe', 'nvngx_dlss.dll', 'renodx-dlss5.addon64', 'dxgi.dll'].includes(f));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: upgraded && ownKept && addonKept && noDupe && filled && rolledBack && leftover.length === 0,
      detail: { actions: gate.actions, upgraded, ownKept, addonKept, noDupe, filled, rolledBack, leftover } };
  });

  await check('gpu-dlss5-tier (RTX 20/30/40 vs 50)', async () => {
    const cases = [['NVIDIA GeForce RTX 5070', 'native', 50], ['NVIDIA GeForce RTX 3060', 'patch', 30],
      ['NVIDIA GeForce RTX 4090', 'patch', 40], ['NVIDIA GeForce GTX 1080 Ti', 'unsupported', null]];
    const got = cases.map(([n]) => { const i = nvidia.parseInfo(n + ', 616.92, 250, 300, 12288'); return [i.dlss5, i.series]; });
    const ok = cases.every(([, tier, series], k) => got[k][0] === tier && got[k][1] === series);
    return { ok, detail: { live: ctx.gpu && { name: ctx.gpu.name, series: ctx.gpu.series, arch: ctx.gpu.arch, dlss5: ctx.gpu.dlss5 }, cases: got } };
  });

  await check('shader-hlsl-compile (d3dcompiler_47)', async () => {
    const fx = fs.readFileSync(path.join(__dirname, '..', 'shaders', 'Refract.fx'), 'utf8');
    const hlsl = fx2hlsl.lower(fx);
    fs.writeFileSync(path.join(out, 'Refract.lowered.hlsl'), hlsl);
    const res = [];
    for (const e of fx2hlsl.ENTRIES) {
      const r = await ctx.win.call('hlsl', { src: hlsl, entry: e.entry, target: e.profile }, 30000);
      res.push({ ...e, ok: r.ok, log: r.log });
    }
    return { ok: res.every(r => r.ok), detail: res };
  });

  await check('telemetry-stream', async () => {
    const t = await until(() => { const x = ctx.getTelemetry(); return x && x.powerDraw != null && x; }, 8000);
    return { ok: !!t, detail: t };
  });

  await check('renderer-main-boot', async () => {
    const r = await until(() => ctx.rendererReady.main, 20000);
    return { ok: !!r && r.ok !== false, detail: r };
  });

  await check('art-protocol', async () => {
    const withArt = games.filter(g => g.art && (g.art.capsule || g.art.hero));
    if (!withArt.length) return { ok: games.every(g => g.store !== 'steam'), detail: 'no Steam art on disk' };
    const g = ctx.publicGame(withArt[0]);
    const url = g.art.hero || g.art.capsule;
    const status = await ctx.getMain().webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r => r.status)`);
    return { ok: status === 200, detail: { game: g.name, url, status, gamesWithArt: withArt.length } };
  });

  await check('ui-screens', async () => {
    const wc = ctx.getMain().webContents;
    await until(() => wc.executeJavaScript('!!document.querySelector(".capsule")'), 20000, 300);
    await sleep(1600);
    const shots = [];
    for (const v of ['library', 'performance', 'looks', 'settings']) {
      await wc.executeJavaScript(`document.querySelector('.dock [data-view="${v}"]').click()`);
      await sleep(v === 'looks' ? 2600 : 1400);
      const img = await wc.capturePage();
      const f = path.join(out, `screen-${v}.png`);
      fs.writeFileSync(f, img.toPNG());
      shots.push(f);
    }
    await wc.executeJavaScript(`document.querySelector('.dock [data-view="library"]').click()`);
    return { ok: true, detail: shots };
  });

  await check('overlay', async () => {
    ctx.toggleOverlay();
    const r = await until(() => ctx.rendererReady.overlay, 15000);
    await sleep(1800);
    const img = await ctx.getOverlay().webContents.capturePage();
    const f = path.join(out, 'screen-overlay.png');
    fs.writeFileSync(f, img.toPNG());
    ctx.toggleOverlay();
    return { ok: !!r, detail: { ready: r, shot: f } };
  });

  await check('look-key-post (F13 to Refract window)', async () => {
    const own = path.basename(process.execPath, '.exe');
    const who = await ctx.win.call('postKey', { vk: 0x7C, process: own });
    return { ok: typeof who === 'string' && who.length > 0, detail: { receivedBy: who } };
  });

  await check('global-hotkeys', async () => {
    const s = ctx.store.get();
    const accels = [s.overlay.hotkey, ...Object.values(s.lookHotkeys)];
    const reg = accels.map(a => ({ accel: a, registered: ctx.globalShortcut.isRegistered(a) }));
    return { ok: reg.every(r => r.registered) && !ctx.failedShortcuts.length, detail: reg };
  });

  await check('renderer-console-clean', async () => ({ ok: ctx.rendererLog.length === 0, detail: ctx.rendererLog }));

  const report = { at: new Date().toISOString(), ms: Date.now() - t0, pass: checks.every(c => c.ok), checks };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.ms} ms)`);
  console.log(report.pass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED', '->', path.join(out, 'report.json'));
  ctx.win.stop();
  ctx.app.exit(report.pass ? 0 : 1);
}

module.exports = { run };
