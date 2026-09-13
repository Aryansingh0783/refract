'use strict';
// The game's own ReShade.log is the only witness to what actually happened last run: whether the
// add-on loaded, whether the neural-rendering runtime was found, whether feature 18 was created
// and evaluated, or why the pass was skipped. Refract reads it after a session so a failure has a
// name and a fix instead of a green badge.
//
// Verdicts, worst first:
//   reshade-missing     no log at all — ReShade never loaded (wrong proxy DLL, or never launched)
//   addon-missing       ReShade ran, the DLSS 5 add-on never registered
//   limited-reshade     the log is from a build without add-on support
//   runtime-missing     "nvngx_dlssnr.dll was not found ..." — the runtime is not next to the exe
//   arch-refused        the runtime refused this GPU architecture
//   host-state          the add-on ran but skipped the pass (host DLSS/DLSSD state incomplete)
//   no-dlss             the game never asked for DLSS, so there is nothing to run NR on
//   idle                everything loaded, no evaluation seen yet (game sat in a menu)
//   evaluating          neural rendering ran
const fs = require('fs');
const path = require('path');

const LOG_NAMES = /^ReShade(\d*)\.log$/i;
const MAX_BYTES = 8 << 20; // tail only: these logs reach hundreds of MB with verbose add-ons

const RULES = [
  // The add-on hooking a Streamline the game itself uses, and only getting part-way in. Seen on
  // an RTX 3060 in The Witcher 3 (DX12): slSetTag/slSetTagForFrame never hooked, the neural pass
  // never ran, and the game crashed in-session. Hook mode 2 leaves that Streamline alone.
  ['hook-partial', /Failed to find (slSetTagForFrame|slSetTag|slEvaluateFeature)/i],
  ['runtime-missing', /nvngx_dlssnr\.dll was not found/i],
  ['arch-refused', /Unsupported GPU architecture|FeatureNotSupported|0xBAD00001/i],
  ['host-state', /left host state incomplete;\s*skipping inline NR|skipping inline NR/i],
  ['addon-error', /\[DLSS 5 Neural Rendering\][^\n]*\b(feature create failed|create failed|unavailable)/i],
];

function parse(text) {
  const t = String(text || '');
  const out = {
    reshade: null, addon: null, addonVersion: null, runtimeLoaded: false, runtimeSha: null,
    featureCreated: false, evaluations: 0, adapter: null, driver: null, game: null,
    limitedBuild: false, dlssSeen: false, errors: [], verdict: 'unknown', line: null, at: null,
  };
  if (!t.trim()) return { ...out, verdict: 'reshade-missing' };

  let m;
  if ((m = /Initializing crosire's ReShade version '([^']+)'[^\n]*loaded from '([^']*)'[^\n]*into '([^']*)'/i.exec(t))) {
    out.reshade = m[1]; out.proxy = m[2] || null; out.game = m[3] || null;
  }
  out.limitedBuild = /only limited add-on functionality/i.test(t);
  if ((m = /Registered add-on "([^"]+)" v([\w.]+)/i.exec(t))) { out.addon = m[1]; out.addonVersion = m[2]; }
  if ((m = /Running on ([^,]+?) Driver ([\d.]+?)\.?\s*$/im.exec(t))) { out.adapter = m[1].trim(); out.driver = m[2]; }
  if ((m = /signed runtime sha256 ([0-9A-F]{64})/i.exec(t))) out.runtimeSha = m[1].toLowerCase();
  out.runtimeLoaded = /signed NR runtime \(nvngx_dlssnr\.dll\) pre-loaded|signed DLSSNR [\d.]+ D3D12 runtime initialized/i.test(t);
  out.featureCreated = /feature 18 (created|ready)/i.test(t);
  out.dlssSeen = /NGX feature create intercepted|first NGX evaluate intercepted|NGX module scan/i.test(t);
  const ev = t.match(/inline feature 18 evaluation succeeded \(count=(\d+)/gi);
  if (ev && ev.length) out.evaluations = Math.max(...ev.map(s => Number(/count=(\d+)/i.exec(s)[1])));

  // The last matching error wins: a later successful run supersedes an earlier failure.
  for (const [verdict, re] of RULES) {
    const all = [...t.matchAll(new RegExp(re.source, 'gim'))];
    if (all.length) out.errors.push({ verdict, count: all.length, line: lineAt(t, all[all.length - 1].index) });
  }
  const worst = out.errors[0] ? out.errors[out.errors.length - 1] : null;

  if (out.evaluations > 0) { out.verdict = 'evaluating'; out.line = lastLine(t, /evaluation succeeded/i); }
  else if (out.errors.find(e => e.verdict === 'runtime-missing')) pick(out, 'runtime-missing');
  else if (out.errors.find(e => e.verdict === 'arch-refused')) pick(out, 'arch-refused');
  else if (out.errors.find(e => e.verdict === 'host-state')) pick(out, 'host-state');
  // Only a problem when nothing ever evaluated — a run that worked is not retro-diagnosed.
  else if (out.errors.find(e => e.verdict === 'hook-partial')) pick(out, 'hook-partial');
  else if (out.errors.find(e => e.verdict === 'addon-error')) pick(out, 'addon-error');
  else if (out.limitedBuild) { out.verdict = 'limited-reshade'; out.line = lastLine(t, /limited add-on functionality/i); }
  else if (!out.addon) { out.verdict = 'addon-missing'; out.line = lastLine(t, /Searching for add-ons/i); }
  else if (!out.dlssSeen) { out.verdict = 'no-dlss'; }
  else out.verdict = 'idle';
  if (worst && !out.line && out.verdict !== 'evaluating') out.line = worst.line;
  out.at = lastTimestamp(t);
  return out;
}

function pick(out, verdict) {
  out.verdict = verdict;
  const e = out.errors.find(x => x.verdict === verdict);
  out.line = e ? e.line : null;
}
function lineAt(t, index) {
  const start = t.lastIndexOf('\n', index) + 1;
  const end = t.indexOf('\n', index);
  return t.slice(start, end === -1 ? undefined : end).trim().slice(0, 400);
}
function lastLine(t, re) {
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i].trim().slice(0, 400);
  return null;
}
function lastTimestamp(t) {
  const m = t.match(/(\d{2}:\d{2}:\d{2}):\d{3}/g);
  return m && m.length ? m[m.length - 1].slice(0, 8) : null;
}

// Every ReShade log in a game folder, newest first (ReShade rotates to ReShade1.log, ...).
function logsIn(exeDir) {
  let names = [];
  try { names = fs.readdirSync(exeDir).filter(n => LOG_NAMES.test(n)); } catch { return []; }
  return names
    .map(n => ({ name: n, path: path.join(exeDir, n), mtime: statTime(path.join(exeDir, n)) }))
    .sort((a, b) => b.mtime - a.mtime);
}
function statTime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function readTail(p, max = MAX_BYTES) {
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - max);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// What the newest log in this game folder says. { verdict: 'reshade-missing' } when there is none.
function inspectGame(exeDir) {
  const logs = logsIn(exeDir);
  if (!logs.length) return { ...parse(''), file: null };
  const r = parse(readTail(logs[0].path));
  return { ...r, file: logs[0].path, fileAt: logs[0].mtime };
}

// One line for the UI, and the action that follows from it.
const VERDICTS = {
  evaluating: { level: 'ok', text: 'Neural rendering ran last time you played.', action: null },
  idle: { level: 'warn', text: 'Everything loaded, but no neural-rendering pass ran. Turn DLSS or DLAA on in the game and play a few seconds.', action: null },
  'runtime-missing': { level: 'bad', text: 'The neural-rendering runtime (nvngx_dlssnr.dll) is not in the game folder, so DLSS 5 stayed off.', action: 'repair' },
  'arch-refused': { level: 'bad', text: 'The runtime refused this GPU. RTX 20 cards cannot run DLSS 5 neural rendering.', action: 'neural-screen' },
  'host-state': { level: 'bad', text: 'The add-on loaded but skipped the pass: the game\'s own DLSS state was not complete. Upgrading the game\'s DLSS runtime usually fixes this.', action: 'upgrade-dlss' },
  'addon-error': { level: 'bad', text: 'The add-on could not create the neural-rendering feature.', action: 'diagnostics' },
  'hook-partial': { level: 'bad', text: 'The add-on only partly hooked the game\'s own Streamline, which is what makes these games crash. Repair the game — Refract now leaves a game\'s own Streamline alone.', action: 'repair' },
  'limited-reshade': { level: 'bad', text: 'This game has a ReShade build without add-on support, so the DLSS 5 add-on never loads.', action: 'repair' },
  'addon-missing': { level: 'bad', text: 'ReShade ran but the DLSS 5 add-on did not load.', action: 'repair' },
  'no-dlss': { level: 'warn', text: 'The game never asked for DLSS last run. Turn DLSS Super Resolution or DLAA on in its graphics settings.', action: null },
  'reshade-missing': { level: 'warn', text: 'No ReShade log yet — play the game once and come back.', action: null },
  unknown: { level: 'warn', text: 'The log did not say what happened.', action: 'diagnostics' },
};

module.exports = { parse, inspectGame, logsIn, readTail, VERDICTS, LOG_NAMES };
