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
const nvidia = require('./core/nvidia');

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
    const nr = P(path.join(dir, 'cache', 'ngx', 'nvngx_dlssnr.dll')); fs.writeFileSync(nr, 'UNIVERSAL-NR');
    const payload = { ok: true, route: 'native', versions: { renodx5: 'test', dlssnr: 'test' }, reshadeDll, addon, addonName: 'renodx-dlss5-v2.5.addon64', dlls: [d1, d2], nvngxDlss: d1, nvngxNrUniversal: nr };

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
    // The neural-rendering runtime must be added (without it NR stays off — the RTX 3060 bug).
    const filled = fs.existsSync(path.join(gameDir, 'nvngx_dlssnr.dll')) && !fs.existsSync(path.join(gameDir, 'sl.dlss_nr.dll'));
    await feeder.restore(gameDir);
    const rolledBack = fs.readFileSync(path.join(gameDir, 'dxgi.dll')).includes(Buffer.from('limited add-on functionality'));
    const leftover = fs.readdirSync(gameDir).filter(f => !['game.exe', 'nvngx_dlss.dll', 'renodx-dlss5.addon64', 'dxgi.dll'].includes(f));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: upgraded && ownKept && addonKept && noDupe && filled && rolledBack && leftover.length === 0,
      detail: { actions: gate.actions, upgraded, ownKept, addonKept, noDupe, filled, rolledBack, leftover } };
  });

  await check('bundled payload (installer ships every dependency)', async () => {
    const bundle = require('./core/bundle');
    const info = bundle.info();
    if (!info) return { ok: false, detail: 'no payload found (run npm run payload, or reinstall)' };
    const assets = require('./core/dlss5assets');
    const need = ['reshade/ReShade64.dll', 'addons/renodx-dlss5.addon64', 'addons/dlss5-bridge.addon64', assets.NR_REL,
      'feeder/dlss5-feed.addon64', 'feeder/DLSS5_Feed.fx', 'feeder/headers/ReShade.fxh',
      'neuralscreen/main.py', 'neuralscreen/runtime/pythonw.exe', 'neuralscreen/native/nvngx.dll'];
    const bad = need.filter(r => !bundle.file(r));
    const nr = bundle.file(assets.NR_REL);
    const nrOk = !!nr && bundle.sha256File(nr) === assets.UNIVERSAL_NR_SHA256;
    const lumenite = bundle.list('lumenite/Shaders/').length, streamline = bundle.list('streamline/').length;
    return { ok: bad.length === 0 && nrOk && lumenite > 0 && streamline > 0, detail: { root: info.root, files: info.files, bad, nrUniversal: nrOk, lumenite, streamline, components: info.components } };
  });

  await check('install verification + log verdicts (the RTX 3060 failure is caught)', async () => {
    const reshadelog = require('./core/reshadelog');
    const diagnostics = require('./core/diagnostics');
    const dir = path.join(os.tmpdir(), 'refract-selftest-verify', 'bin', 'x64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'game.exe'), 'MZ');
    fs.writeFileSync(path.join(dir, 'nvngx_dlss.dll'), 'GAME-DLSS');
    fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade 6.8.0 Searching for add-ons');
    fs.writeFileSync(path.join(dir, 'renodx-dlss5.addon64'), 'ADDON');
    fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[GENERAL]\r\n');
    fs.writeFileSync(path.join(dir, 'refract-feeder.json'), JSON.stringify({ version: 5, route: 'native', added: [], replaced: [] }));
    fs.writeFileSync(path.join(dir, 'ReShade.log'), `12:00:00:000 [1] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) loaded from '${dir}\\dxgi.dll' into '${dir}\\game.exe' ...\n` +
      `12:00:01:000 [1] | INFO  | Registered add-on "DLSS 5 Neural Rendering" v0.2026.828.517 using ReShade API version 18.\n` +
      `12:00:02:000 [1] | ERROR | [DLSS 5 Neural Rendering] DLSS5 Generic: nvngx_dlssnr.dll was not found in ${dir}. Place NVIDIA's signed nvngx_dlssnr.dll in that folder and restart the game; NR stays off until then\n`);
    const ampere = { name: 'RTX 3060', dlss5: 'patch', series: 30, arch: 'Ampere' };
    const v = feeder.verify(dir, { gpu: ampere, unlock: { enabled: true }, route: 'native' });
    const quick = feeder.quickCheck(dir);
    const plan = feeder.plan(dir, { bitness: 64, api: 'dxgi', dx: 12, gpu: ampere, unlock: { enabled: true } });
    const log = reshadelog.inspectGame(dir);
    const bundleOut = diagnostics.collect({ game: { name: 'Selftest' }, exeDir: dir, gpu: ctx.gpu, appVersion: 'selftest' });
    const ok = !v.ok && v.failed[0].id === 'runtime' && quick.needsAttention
      && plan.ok && plan.actions.includes('nr-runtime')
      && log.verdict === 'runtime-missing' && bundleOut.buffer.length > 300
      && /^refract-diagnostics-selftest-/.test(bundleOut.name);
    fs.rmSync(path.join(os.tmpdir(), 'refract-selftest-verify'), { recursive: true, force: true });
    return { ok, detail: { verifyFailed: v.failed.map(f => f.id), quick, planActions: plan.actions, verdict: log.verdict, zipBytes: bundleOut.buffer.length, zip: bundleOut.name } };
  });

  await check('neuralscreen engine (bundled, RTX 30/40/50)', async () => {
    const { NeuralScreen } = require('./core/neuralscreen');
    const ns = new NeuralScreen({ home: path.join(os.tmpdir(), 'refract-selftest-ns') });
    const src = ns.source({ verify: true });
    const av = ns.available(ctx.gpu);
    const cmd = ns.command();
    const ok = !!src && fs.existsSync(path.join(src, 'runtime', 'pythonw.exe')) && /pythonw\.exe$/.test(cmd.file) && cmd.args.includes('--config');
    return { ok: ok && (av.ok || (ctx.gpu && ctx.gpu.dlss5 === 'unsupported')), detail: { src, version: ns.version(), available: av, gpu: ctx.gpu && ctx.gpu.name } };
  });

  await check('gpu-dlss5-tier (RTX 20/30/40 vs 50)', async () => {
    const cases = [['NVIDIA GeForce RTX 5070', 'native', 50], ['NVIDIA GeForce RTX 3060', 'patch', 30],
      ['NVIDIA GeForce RTX 4090', 'patch', 40], ['NVIDIA GeForce RTX 2080 Ti', 'unsupported', 20], ['NVIDIA GeForce GTX 1080 Ti', 'unsupported', null]];
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
    // The Neural Screen panel sits below the DLSS 5 block in the Setup tab.
    await sleep(1400);
    const ns = await wc.executeJavaScript(`(() => { const b = document.querySelector('#nsBlock'); if (!b) return null; b.scrollIntoView({ block: 'start' }); return { html: b.innerHTML.length, start: !!b.querySelector('[data-ns]'), auto: !!b.querySelector('#nsAuto'), profiles: b.querySelectorAll('#nsProfile button').length }; })()`);
    await sleep(700);
    const nsShot = path.join(out, 'screen-neuralscreen.png');
    fs.writeFileSync(nsShot, (await wc.capturePage()).toPNG());
    shots.push(nsShot);
    const nsOk = !ctx.gpu || ctx.gpu.dlss5 === 'unsupported' || !!(ns && ns.start && ns.auto && ns.profiles === 4);
    return { ok: nsOk, detail: { shots, neuralScreenPanel: ns } };
  });

  await check('overlay (opens interactive, closes on second press)', async () => {
    ctx.toggleOverlay();
    const r = await until(() => ctx.rendererReady.overlay, 15000);
    const shown = await until(() => ctx.getOverlay() && ctx.getOverlay().isVisible(), 5000);
    await sleep(1200);
    const ow = ctx.getOverlay();
    const img = await ow.webContents.capturePage();
    const f = path.join(out, 'screen-overlay.png');
    fs.writeFileSync(f, img.toPNG());
    const clickable = ow.isFocusable();
    if (ow.isVisible()) ctx.toggleOverlay();
    const closed = await until(() => !ctx.getOverlay().isVisible(), 3000);
    return { ok: !!r && !!shown && clickable && !!closed, detail: { ready: r, shown: !!shown, clickable, closed: !!closed, shot: f } };
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
