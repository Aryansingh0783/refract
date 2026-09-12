'use strict';
// NeuralScreen (MIT, github.com/perseval-BLR/DLSS5-NeuralScreen) bundled as Refract's screen
// engine. It captures the screen (or one window) outside the game, runs NVIDIA's DLSS 5 neural
// renderer on it in its own worker process, and draws the result over the desktop. Because
// nothing is injected into the game, it also covers what the in-game route cannot: Vulkan,
// 32-bit, games without DLSS, games with anti-tamper. It needs borderless/windowed mode.
//
// The bundled copy (resources/payload/neuralscreen) is read-only by intent: NeuralScreen keeps
// its log, config and recordings next to itself, so Refract runs a working copy in userData
// that survives updates and uninstalls. The 158 MB runtime is hard-linked into it, not copied.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const bundle = require('./bundle');

const PREFIX = 'neuralscreen/';
// The engine itself, always inside the installer.
const ENGINE_FILES = ['main.py', 'runtime/pythonw.exe', 'native/nvngx.dll'];
// NVIDIA's neural-rendering runtime. Bundled in a full build; in the public (lite) build it is
// downloaded and hash-checked from NeuralScreen's own release the first time it is needed,
// because that DLL is not ours to redistribute.
const RUNTIME_REL = 'native/nvngx_dlssnr.dll';
const KEY_FILES = [...ENGINE_FILES, RUNTIME_REL];
const PROFILES = ['Faithful', 'Natural', 'Strong / Cinematic', 'Extreme / Overdrive'];
const DEFAULTS = { profile: 'Natural', faster: false, workScale: 0.65 };
// NeuralScreen's own hotkeys (upstream defaults; Num Lock must be on).
const HOTKEYS = [['Num2', 'menu'], ['Num1', 'neural rendering on/off'], ['Num5', 'process only the window under the cursor'],
  ['Num3', 'screenshot'], ['Num0', 'record'], ['Ctrl+Alt+Q', 'quit']];

class NeuralScreen {
  constructor({ home, cacheRoot = null, emit = () => {}, spawn = cp.spawn, exec = cp.execFile, source = null } = {}) {
    this.home = home;          // userData/neuralscreen
    this.cacheRoot = cacheRoot; // where a lite build downloads the runtime to
    this.emit = emit;
    this.spawn = spawn;
    this.exec = exec;
    this.sourceOverride = source; // tests
    this.proc = null;
    this.startedFor = null;    // game name when started by a session
    this.logFrom = 0;
  }

  // The bundled app, when every file that matters is present. verify=true also checks the
  // hashes (158 MB for the runtime), which only start() pays for.
  source({ verify = false } = {}) {
    if (this.sourceOverride) return this.sourceOverride;
    const ok = ENGINE_FILES.every(k => (verify ? bundle.file(PREFIX + k) : bundle.has(PREFIX + k)));
    const b = bundle.info();
    return ok && b ? path.join(b.root, 'neuralscreen') : null;
  }

  version() {
    const src = this.source();
    try { return /NeuralScreen\s+([\d.]+)/.exec(fs.readFileSync(path.join(src, 'VERSION.txt'), 'utf8'))[1]; } catch { return null; }
  }

  // RTX 30/40/50 only: Turing and older are refused by every runtime build.
  available(gpu) {
    if (process.platform !== 'win32' && !this.sourceOverride) return { ok: false, reason: 'Windows only.' };
    if (!this.source()) return { ok: false, reason: 'The NeuralScreen engine is missing from this install. Reinstall Refract.' };
    if (gpu && gpu.dlss5 === 'unsupported') {
      return { ok: false, reason: gpu.series === 20 ? 'RTX 20 (Turing) cannot run DLSS 5 neural rendering.' : 'Neural Screen needs an RTX 30, 40 or 50 card.' };
    }
    return { ok: true };
  }

  // Mirror the bundle into the working copy. Code is refreshed when the bundled version
  // changes; the user's config, log, screenshots and recordings are left alone.
  async prepare(onProgress) {
    const src = this.source({ verify: true });
    if (!src) throw new Error('The NeuralScreen engine is missing or damaged in this install. Reinstall Refract.');
    const gone = ENGINE_FILES.filter(k => !fs.existsSync(path.join(src, ...k.split('/'))));
    if (gone.length) throw new Error(`The NeuralScreen engine is damaged: ${gone.join(', ')} missing. Reinstall Refract.`);
    const stampPath = path.join(this.home, '.refract-source');
    const stamp = `${src}|${fs.statSync(path.join(src, 'main.py')).mtimeMs}|${this.version()}`;
    const ready = KEY_FILES.every(k => fs.existsSync(path.join(this.home, ...k.split('/'))));
    if (!(ready && readText(stampPath) === stamp)) {
      const all = listTree(src).filter(rel => !/^(NeuralScreen\.log|recordings\/|screenshots\/|\.extracted$)/i.test(rel));
      let n = 0;
      for (const rel of all) {
        const from = path.join(src, ...rel.split('/'));
        const to = path.join(this.home, ...rel.split('/'));
        if (++n % 100 === 0 && onProgress) onProgress(n / all.length);
        if (rel === 'config.json' && fs.existsSync(to)) continue; // the user's settings
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        if (rel === RUNTIME_REL) { linkOrCopy(from, to); continue; }
        await fs.promises.copyFile(from, to);
      }
      fs.writeFileSync(stampPath, stamp);
    }
    await this.ensureRuntime(onProgress);
    return this.home;
  }

  // The 158 MB runtime, in place under the working copy. Bundled builds link it out of the
  // payload; the public build downloads it once (hash-checked) into the app's cache and links
  // that. Either way it lands at <home>/native/nvngx_dlssnr.dll, which is what the worker loads.
  async ensureRuntime(onProgress) {
    const to = path.join(this.home, ...RUNTIME_REL.split('/'));
    if (fs.existsSync(to) && fs.statSync(to).size > 0) return to;
    let from = bundle.file(PREFIX + RUNTIME_REL);
    if (!from) {
      if (!this.cacheRoot) throw new Error('The neural-rendering runtime is not available and there is nowhere to download it to.');
      const assets = require('./dlss5assets');
      from = await assets.ensureUniversalRuntime(this.cacheRoot, p => {
        this.emit('neuralscreen', { state: 'downloading', label: 'Neural-rendering runtime', frac: p && p.frac });
        if (onProgress && p && typeof p.frac === 'number') onProgress(p.frac);
      });
    }
    if (!from) throw new Error('Could not obtain the neural-rendering runtime (nvngx_dlssnr.dll).');
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    linkOrCopy(from, to);
    return to;
  }

  configPath() { return path.join(this.home, 'config.json'); }

  // Refract owns a few fields; everything else (menu position, hotkeys, presets) stays as
  // NeuralScreen saved it.
  writeConfig(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')); } catch {}
    cfg.profile = PROFILES.includes(o.profile) ? o.profile : DEFAULTS.profile;
    cfg.nr_small = !!o.faster;
    cfg.work_scale = Math.min(1, Math.max(0.3, Number(o.workScale) || DEFAULTS.workScale));
    cfg.open_menu_on_start = false; // a short alert instead of a menu over the game
    cfg.fullscreen = true;
    if (!cfg.lang) cfg.lang = 'en';
    if (!cfg.theme) cfg.theme = 'dark';
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.configPath(), JSON.stringify(cfg, null, 2));
    return cfg;
  }

  command() {
    return {
      file: path.join(this.home, 'runtime', 'pythonw.exe'),
      args: ['-u', path.join(this.home, 'main.py'), '--config', this.configPath()],
      cwd: this.home,
    };
  }

  running() { return !!(this.proc && this.proc.exitCode == null && !this.proc.killed); }

  start(opts = {}, forGame = null) {
    if (this.running()) { if (forGame) this.startedFor = forGame; return Promise.resolve(this.state()); }
    if (!this.starting) this.starting = this._start(opts, forGame).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(opts, forGame) {
    const ok = this.available(opts.gpu);
    if (!ok.ok) throw new Error(ok.reason);
    await this.prepare(f => this.emit('neuralscreen', { state: 'preparing', frac: f }));
    this.writeConfig(opts);
    this.logFrom = fileSize(path.join(this.home, 'NeuralScreen.log'));
    const { file, args, cwd } = this.command();
    const child = this.spawn(file, args, { cwd, windowsHide: false, stdio: 'ignore' });
    this.proc = child;
    this.startedFor = forGame;
    this.startedAt = Date.now();
    child.on('exit', code => {
      if (this.proc !== child) return;
      this.proc = null;
      const was = this.startedFor; this.startedFor = null;
      // Exit code 1 within a few seconds = another NeuralScreen already holds the screen.
      const dup = code === 1 && Date.now() - this.startedAt < 8000;
      this.emit('neuralscreen', { state: 'stopped', code, game: was, reason: dup ? 'already-running' : null });
    });
    child.on('error', e => { if (this.proc === child) { this.proc = null; this.emit('neuralscreen', { state: 'stopped', error: e.message }); } });
    this.emit('neuralscreen', { state: 'running', game: forGame });
    return this.state();
  }

  // Close the whole tree (pythonw + its nvngx.dll worker): politely first, then forced.
  async stop() {
    const child = this.proc;
    if (!child) return false;
    const pid = child.pid;
    const kill = force => new Promise(r => this.exec('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true }, () => r()));
    await kill(false);
    for (let i = 0; i < 20 && this.running(); i++) await new Promise(r => setTimeout(r, 150));
    if (this.running()) await kill(true);
    return true;
  }

  // What the log says since this run started: the pipeline's FPS line and the worker's
  // architecture/failure lines.
  state() {
    const out = { running: this.running(), pid: this.proc ? this.proc.pid : null, game: this.startedFor, fps: null, nr: null, arch: null };
    if (!this.home) return out;
    const text = readTail(path.join(this.home, 'NeuralScreen.log'), this.logFrom);
    let m;
    for (const line of text.split(/\r?\n/)) {
      if ((m = /\| FPS\s+([\d.]+)/.exec(line))) { out.fps = Number(m[1]); out.nr = /NR OFF|bypass/i.test(line) ? 'off' : 'on'; }
      if (/\[arch\]/.test(line)) out.arch = line.replace(/^.*\[arch\]\s*/, '').trim();
      if (/NR OFF$|worker silent\/dying|failed to start|feature 18 create failed|NR feature unavailable/i.test(line)) out.nr = 'failed';
    }
    return out;
  }
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function readTail(p, from) {
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(from > size ? 0 : from, size - 256 * 1024);
    const fd = fs.openSync(p, 'r');
    try { const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
function listTree(root) {
  const out = [];
  (function rec(dir, rel) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) rec(path.join(dir, d.name), r); else out.push(r);
    }
  })(root, '');
  return out;
}
function linkOrCopy(from, to) {
  try {
    const a = fs.statSync(from), b = fs.existsSync(to) ? fs.statSync(to) : null;
    if (b && b.size === a.size && b.ino && b.ino === a.ino) return; // already the same file
    if (b) fs.rmSync(to, { force: true });
    fs.linkSync(from, to);
  } catch { fs.copyFileSync(from, to); }
}

module.exports = { NeuralScreen, ENGINE_FILES, RUNTIME_REL, PROFILES, DEFAULTS, HOTKEYS, KEY_FILES };
