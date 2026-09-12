'use strict';
// One file that answers "why is DLSS 5 off on this machine?" without a screenshot of a log
// window. Everything a remote RTX 3060 or 4050 needs to send back: the game's own ReShade log,
// what Refract installed, what the folder actually contains, the payload's integrity, the GPU
// and driver, and the app's settings with the user's name taken out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zip } = require('./zip');
const bundle = require('./bundle');
const feeder = require('./feeder');
const reshadelog = require('./reshadelog');
const assets = require('./dlss5assets');

const MAX_LOG = 2 << 20;
const INTERESTING = /\.(dll|addon\d*|ini|json|cfg|log)$/i;

function redactor(extra = []) {
  const home = os.homedir();
  const user = path.basename(home || '') || null;
  const pairs = [[home, '%USERPROFILE%'], ...extra.map(e => [e, '<redacted>'])].filter(([a]) => a && a.length > 2);
  return function redact(text) {
    let out = String(text == null ? '' : text);
    for (const [from, to] of pairs) out = out.split(from).join(to).split(from.replace(/\\/g, '\\\\')).join(to);
    if (user && user.length > 2) out = out.split(user).join('<user>');
    return out;
  };
}

function folderInventory(dir, redact) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { error: String(e.code || e.message) }; }
  const files = [];
  for (const n of names) {
    if (!INTERESTING.test(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const entry = { name: n, size: st.size, modified: new Date(st.mtimeMs).toISOString() };
    // Hash only the files whose identity decides whether DLSS 5 can run.
    if (/^(nvngx_dlssnr|nvngx_dlss|dxgi|d3d1[12]|winmm|version)\.dll$|\.addon\d*$/i.test(n) && st.size < 400 << 20) {
      try { entry.sha256 = bundle.sha256File(p); } catch {}
    }
    files.push(entry);
  }
  return { path: redact(dir), count: names.length, files };
}

function payloadCheck() {
  const info = bundle.info();
  if (!info) return { present: false };
  const need = ['reshade/ReShade64.dll', 'addons/renodx-dlss5.addon64', assets.NR_REL, 'neuralscreen/main.py'];
  return { present: true, files: info.files, components: info.components, missing: need.filter(r => !bundle.file(r)) };
}

function readTail(p, max = MAX_LOG) {
  try {
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, 'r');
    try {
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return (start ? `... (first ${start} bytes trimmed)\n` : '') + buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

// Everything about one game (or the whole app when game is null), as a zip in memory.
function collect({ game = null, exeDir = null, gpu = null, settings = null, appVersion = null,
  userData = null, session = null, extraFiles = [], now = new Date() } = {}) {
  const redact = redactor([]);
  const entries = [];
  const report = {
    generated: now.toISOString(),
    refract: { version: appVersion, packaged: !!process.resourcesPath && /resources$/i.test(process.resourcesPath || '') },
    system: { platform: process.platform, release: os.release(), arch: process.arch, node: process.versions.node,
      electron: process.versions.electron || null, memoryGB: Math.round(os.totalmem() / 1073741824) },
    gpu: gpu ? { name: gpu.name, driver: gpu.driver, series: gpu.series, arch: gpu.arch, dlss5: gpu.dlss5,
      memoryTotal: gpu.memoryTotal, driverStatus: gpu.driverStatus } : null,
    payload: payloadCheck(),
    session: session || null,
    game: null,
  };

  if (exeDir) {
    const st = feeder.status(exeDir);
    const v = feeder.verify(exeDir, { gpu, unlock: settings ? unlockFrom(settings) : null, route: st.route });
    const log = reshadelog.inspectGame(exeDir);
    report.game = {
      name: game && game.name || null,
      store: game && game.store || null,
      exe: redact(game && game.exe || ''),
      api: game && game.apiLabel || null,
      bitness: game && game.bitness || null,
      install: st,
      verify: { ok: v.ok, checks: v.checks, summary: v.summary },
      log: { ...log, file: log.file ? redact(log.file) : null },
      logVerdict: reshadelog.VERDICTS[log.verdict] || null,
      folder: folderInventory(exeDir, redact),
    };
    for (const n of ['refract-feeder.json', 'refract-reshade.json', 'ReShade.ini', 'ReShadePreset.ini', 'dlss5-feed.cfg', 'OptiScaler.ini']) {
      const t = readTail(path.join(exeDir, n), 256 << 10);
      if (t != null) entries.push({ name: `game/${n}`, data: redact(t) });
    }
    for (const l of reshadelog.logsIn(exeDir).slice(0, 2)) {
      const t = readTail(l.path);
      if (t != null) entries.push({ name: `game/${l.name}`, data: redact(t) });
    }
  }

  if (userData) {
    for (const n of ['install.log', 'restore-report.json']) {
      const t = readTail(path.join(userData, n), 512 << 10);
      if (t != null) entries.push({ name: `refract/${n}`, data: redact(t) });
    }
    const nsLog = readTail(path.join(userData, 'neuralscreen', 'NeuralScreen.log'), 512 << 10);
    if (nsLog != null) entries.push({ name: 'refract/NeuralScreen.log', data: redact(nsLog) });
    const selftest = readTail(path.join(userData, 'selftest', 'report.json'), 512 << 10);
    if (selftest != null) entries.push({ name: 'refract/selftest-report.json', data: redact(selftest) });
  }

  if (settings) {
    const safe = { ...settings };
    delete safe.games; // per-game paths add nothing here and are the most identifying part
    safe.gamesConfigured = Object.keys(settings.games || {}).length;
    entries.push({ name: 'refract/settings.json', data: redact(JSON.stringify(safe, null, 2)) });
  }
  for (const f of extraFiles) {
    const t = readTail(f.path, 512 << 10);
    if (t != null) entries.push({ name: f.name, data: redact(t) });
  }

  entries.unshift({ name: 'report.json', data: JSON.stringify(report, null, 2) });
  entries.push({ name: 'README.txt', data: readme(report) });
  const slug = (game && game.name || 'refract').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { name: `refract-diagnostics-${slug}-${stamp}.zip`, buffer: zip(entries, now), report };
}

function unlockFrom(s) {
  return { enabled: s.dlss5Unlock !== false, runtime: s.dlss5PatchedRuntime || null, source: s.dlss5UnlockSource || 'auto' };
}

function readme(report) {
  const g = report.game;
  return [
    'Refract diagnostics bundle',
    '',
    `Generated: ${report.generated}`,
    `Refract:   ${report.refract.version || 'unknown'}`,
    `GPU:       ${report.gpu ? `${report.gpu.name} (driver ${report.gpu.driver}, DLSS 5 tier: ${report.gpu.dlss5})` : 'unknown'}`,
    `Windows:   ${report.system.release}`,
    g ? `Game:      ${g.name || 'unknown'} — install ${g.install.installed ? 'present' : 'absent'}, verify ${g.verify.ok ? 'passed' : 'FAILED: ' + g.verify.summary}` : 'Game:      (whole app)',
    g ? `Last run:  ${g.log.verdict}${g.log.line ? ' — ' + g.log.line : ''}` : '',
    '',
    'report.json has the full picture. game/ holds the game\'s own ReShade log and configs,',
    'refract/ the app\'s logs and settings. User paths are replaced with %USERPROFILE%.',
  ].filter(Boolean).join('\n');
}

module.exports = { collect, folderInventory, payloadCheck, redactor };
