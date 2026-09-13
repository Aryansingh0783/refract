'use strict';
// When DLSS 5 fails on a card that is not RTX 50 — the RTX 30 and RTX 40 machines Refract has
// never been able to test on — nobody should have to find a menu, click Export and mail a zip.
// Refract writes the report itself, onto the Desktop, named after the card, the moment it knows
// the attempt did not work: after a failed install, and after a play session whose ReShade log
// says the pass never ran.
//
//   Refract-error-NVIDIA-GeForce-RTX-3060-2026-09-12.log
//
// One file per card per day, appended to, with a signature line per block so the same failure
// reported twice does not write twice. A diagnostics zip is dropped beside it once a day.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Log verdicts that mean "DLSS 5 did not run and it is not the user idling in a menu".
const BAD_VERDICTS = new Set(['runtime-missing', 'arch-refused', 'host-state', 'addon-error',
  'limited-reshade', 'addon-missing', 'hook-partial']);
// Multi Frame Generation failures, reported the same way and on the same cards.
const MFG_VERDICTS = new Set(['mfg-engine-missing', 'mfg-slot-taken', 'mfg-not-running',
  'mfg-arch-refused']);
// Verdicts that are not failures: nothing ran yet, or the user simply has DLSS off.
const QUIET_VERDICTS = new Set(['evaluating', 'idle', 'no-dlss', 'reshade-missing', 'unknown']);

const NEXT_STEPS = {
  'runtime-missing': [
    'Open Refract, select the game and press Repair — the runtime is copied again and verified.',
    'If it disappears again, an antivirus is deleting it: add the game folder to Windows Security → Virus & threat protection → Exclusions, then repair.',
  ],
  'arch-refused': [
    'This GPU architecture is refused by every DLSS neural-rendering runtime that exists.',
    'Use Neural Screen instead (Refract → Neural Screen): it runs the same model over the screen image and does not need the game to cooperate.',
  ],
  'host-state': [
    'The add-on loaded but the game\'s own DLSS state was incomplete, so the pass was skipped.',
    'Turn on Refract → Settings → "Upgrade the game\'s DLSS runtime" and repair the game, then turn DLSS Super Resolution (not DLAA-off) on in the game.',
    'If the game uses FSR or XeSS rather than DLSS, set it to DLSS in its graphics menu.',
  ],
  'hook-partial': [
    'Press Repair in Refract. Builds from 0.5.1 leave a game\'s own Streamline alone, which is what caused the crashes.',
    'If it still crashes, the game folder has another DLSS or frame-generation mod in it — move that out and repair again.',
  ],
  'addon-error': [
    'The add-on could not create the neural-rendering feature. Update the NVIDIA driver, then repair the game.',
  ],
  'limited-reshade': [
    'Another tool installed a ReShade build without add-on support. Remove that ReShade (or let Refract restore the folder), then set the game up again in Refract.',
  ],
  'addon-missing': [
    'ReShade started but the DLSS 5 add-on never loaded. Press Repair in Refract.',
    'Check that no other DLSS mod (OptiScaler, DLSS Swapper, a Nukem dlssg wrapper) is installed in the same folder.',
  ],
  'install-failed': [
    'Press Repair in Refract and watch which check fails.',
    'If files vanish right after the install, exclude the game folder in Windows Security and repair again.',
  ],
  'install-error': [
    'Close the game and any launcher that keeps its folder open, then try again.',
    'If the folder is under Program Files, run Refract as administrator once.',
  ],
  // Multi Frame Generation on RTX 30/40. Same rule as everything else here: only steps that
  // exist, and no claim that frame generation can be made latency-free.
  'mfg-engine-missing': [
    'version.dll (the frame-generation engine) is not in the game folder. Press Repair in Refract.',
    'If it keeps disappearing, exclude the game folder in Windows Security — a modified NVIDIA-adjacent DLL is exactly what real-time protection removes.',
  ],
  'mfg-slot-taken': [
    'Another mod already owns version.dll in this game folder. The engine can only load under that name, so remove the other mod first.',
    'If it is ReShade, reinstall it under dxgi.dll (Refract\'s default) and set the game up again.',
  ],
  'mfg-not-running': [
    'Turn DLSS Frame Generation on in the game\'s own graphics settings — Refract only makes it available, the game still has to ask for it.',
    'Frame generation needs DLSS Super Resolution or DLAA on as well.',
    'Check dlssg_sm86\\logs next to the game: it records which architecture route was taken and whether the kernels loaded.',
  ],
  'mfg-arch-refused': [
    'The engine refused this GPU. RTX 30 uses the SM86 route and RTX 20 the SM75 one; anything older cannot run it.',
    'Update the NVIDIA driver — the PTX kernels are compiled by the driver at first run.',
  ],
};

function slug(text, max = 64) {
  return String(text || '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'unknown-GPU';
}

// "NVIDIA GeForce RTX 3060 Laptop GPU" -> "NVIDIA-GeForce-RTX-3060-Laptop-GPU"
function hardwareSlug(gpu) {
  return slug(gpu && gpu.name ? gpu.name : 'unknown GPU');
}

function stampDay(when) {
  const d = when instanceof Date ? when : new Date(when || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function stampTime(when) {
  const d = when instanceof Date ? when : new Date(when || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${stampDay(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileName(gpu, when = new Date(), ext = 'log') {
  return `Refract-error-${hardwareSlug(gpu)}-${stampDay(when)}.${ext}`;
}

// Does this card get an automatic report at all? RTX 50 works and is verified; RTX 20 and GTX
// are refused by design and already say so in the UI. The unverified middle — RTX 30 and 40,
// tier 'patch' — is what this exists for.
function watched(gpu) {
  if (!gpu) return false;
  if (gpu.dlss5 === 'patch') return true;
  return gpu.series === 30 || gpu.series === 40;
}

// The decision: is this a failure worth a file on the Desktop? Returns null when it is not.
// Precedence: a thrown install beats everything; during an install the verification is the live
// truth; after a session the game's own log is, because it says what actually happened in-game.
function failureOf({ gpu = null, verify = null, log = null, error = null, phase = null } = {}) {
  if (!watched(gpu)) return null;
  if (error) {
    return { code: 'install-error', phase: phase || 'install', level: 'bad',
      summary: `Refract could not finish setting the game up: ${String(error.message || error)}` };
  }
  const fromVerify = () => {
    if (!verify || verify.ok !== false) return null;
    const first = (verify.failed && verify.failed[0]) || null;
    return { code: verify.vanished ? 'files-removed' : 'install-failed', phase: phase || 'install', level: 'bad',
      summary: verify.vanished
        ? 'Refract installed the neural-rendering runtime and something deleted it again (almost always antivirus).'
        : `Install verification failed: ${verify.summary || (first && first.label) || 'unknown check'}` };
  };
  const fromLog = () => {
    if (!log || !(BAD_VERDICTS.has(log.verdict) || MFG_VERDICTS.has(log.verdict))) return null;
    return { code: log.verdict, phase: phase || 'session', level: 'bad',
      summary: log.text || `The game's ReShade log reports: ${log.verdict}` };
  };
  const order = phase === 'install' ? [fromVerify, fromLog] : [fromLog, fromVerify];
  for (const f of order) { const r = f(); if (r) return r; }
  return null;
}

function sigOf(f, game) {
  const h = crypto.createHash('sha256');
  h.update([f.code, f.phase, game && game.name || '', f.summary || ''].join('\u0000'));
  return h.digest('hex').slice(0, 16);
}

// Grouped by thousands regardless of the machine's locale: toLocaleString() on an en-IN Windows
// prints 73,40,032, which reads like a different number to anyone reading the report.
function groups(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function pad(label, width = 12) { return (label + ':').padEnd(width, ' '); }

function checkLines(verify) {
  if (!verify || !verify.checks) return ['  (no verification was run)'];
  return verify.checks.map(c => `  ${c.ok ? 'ok    ' : 'FAILED'}  ${c.label}${c.detail ? ' — ' + c.detail : ''}`);
}

function folderLines(inv) {
  if (!inv) return ['  (not inspected)'];
  if (inv.error) return [`  (could not read the folder: ${inv.error})`];
  const want = ['nvngx_dlssnr.dll', 'nvngx_dlss.dll', 'dxgi.dll', 'd3d11.dll', 'd3d12.dll',
    'renodx-dlss5.addon64', 'dlss5-feed.addon64', 'dlss5-bridge.addon64', 'OptiScaler.dll', 'libxess.dll',
    // Multi Frame Generation
    'version.dll', 'nvngx_dlssg.dll', 'sl.reflex.dll', 'sl.pcl.dll'];
  const byName = new Map((inv.files || []).map(f => [f.name.toLowerCase(), f]));
  const lines = [];
  for (const n of want) {
    const f = byName.get(n.toLowerCase());
    lines.push(`  ${n.padEnd(24)} ${f ? `${groups(f.size)} bytes${f.sha256 ? '  sha256 ' + f.sha256.slice(0, 16) : ''}` : 'MISSING'}`);
  }
  return lines;
}

// The body of one report. Pure: everything it prints is passed in.
function render({ gpu = null, game = null, verify = null, log = null, failure, appVersion = null,
  route = null, install = null, folder = null, antivirus = null, payload = null, notes = null,
  when = new Date(), redact = s => s } = {}) {
  const L = [];
  L.push('='.repeat(78));
  L.push(`Refract error report — ${failure.code}`);
  L.push(`Written ${stampTime(when)}  (Refract ${appVersion || 'unknown'})`);
  L.push('='.repeat(78));
  L.push('');
  L.push('HARDWARE');
  L.push(`  ${pad('GPU')} ${gpu && gpu.name || 'unknown'}${gpu && gpu.memoryTotal ? ` (${Math.round(gpu.memoryTotal / 1024)} GB)` : ''}`);
  L.push(`  ${pad('Driver')} ${gpu && gpu.driver || 'unknown'}${gpu && gpu.driverStatus ? ` (${gpu.driverStatus === 'tested' ? 'the driver this was tested against' : gpu.driverStatus + ' than the tested driver'})` : ''}`);
  L.push(`  ${pad('Series')} ${gpu && gpu.series ? `RTX ${gpu.series}` : 'unknown'}${gpu && gpu.arch ? ` — ${gpu.arch}` : ''} — DLSS 5 tier: ${gpu && gpu.dlss5 || 'unknown'}`);
  L.push(`  ${pad('Windows')} ${os.release()} (${process.arch})`);
  L.push(`  ${pad('Memory')} ${Math.round(os.totalmem() / 1073741824)} GB`);
  L.push('');
  L.push('GAME');
  if (game) {
    L.push(`  ${pad('Name')} ${game.name || 'unknown'}${game.store ? ` (${game.store})` : ''}`);
    L.push(`  ${pad('Folder')} ${redact(game.exeDir || (game.exe ? path.dirname(game.exe) : '') || '')}`);
    L.push(`  ${pad('API')} ${game.apiLabel || game.api || 'unknown'} — ${game.bitness || 64}-bit`);
  } else {
    L.push('  (no game — this report is about the app itself)');
  }
  L.push(`  ${pad('Route')} ${route || (install && install.route) || 'unknown'}`);
  L.push('');
  L.push('WHAT FAILED');
  L.push(`  ${pad('Stage')} ${failure.phase}`);
  L.push(`  ${pad('Code')} ${failure.code}`);
  L.push(`  ${pad('Summary')} ${failure.summary}`);
  if (log && log.line) L.push(`  ${pad('Log line')} ${redact(log.line)}`);
  if (log && log.verdict) L.push(`  ${pad('Verdict')} ${log.verdict}${log.at ? ` (last log entry ${log.at})` : ''}`);
  if (notes && notes.length) for (const n of notes) L.push(`  ${pad('Note')} ${n}`);
  L.push('');
  L.push('INSTALL VERIFICATION');
  for (const l of checkLines(verify)) L.push(l);
  L.push('');
  L.push('FILES IN THE GAME FOLDER');
  for (const l of folderLines(folder)) L.push(l);
  L.push('');
  if (log) {
    L.push('LAST RUN (from the game\'s own ReShade log)');
    L.push(`  ${pad('ReShade')} ${log.reshade || 'unknown'}${log.addon ? `, add-on ${log.addon} ${log.addonVersion || ''}` : ', no DLSS 5 add-on registered'}`);
    L.push(`  ${pad('Adapter')} ${log.adapter || 'unknown'}${log.driver ? ` driver ${log.driver}` : ''}`);
    L.push(`  ${pad('NR passes')} ${log.evaluations || 0}`);
    L.push(`  ${pad('Log file')} ${redact(log.file || 'none')}`);
    L.push('');
  }
  if (antivirus) {
    L.push('ANTIVIRUS');
    L.push(`  ${typeof antivirus === 'string' ? antivirus : JSON.stringify(antivirus)}`);
    L.push('');
  }
  if (payload) {
    L.push('BUNDLED PAYLOAD');
    L.push(`  ${pad('Files')} ${payload.files == null ? 'unknown' : payload.files}`);
    if (payload.missing && payload.missing.length) L.push(`  ${pad('MISSING')} ${payload.missing.join(', ')}`);
    L.push('');
  }
  L.push('WHAT TO TRY NEXT');
  const steps = NEXT_STEPS[failure.code] || NEXT_STEPS['install-failed'];
  steps.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));
  L.push('');
  L.push(failure.phase === 'manual'
    ? 'This file was written because you asked for it in DIHLSS5 -> Settings.'
    : 'This file was written automatically because DLSS 5 did not work on an RTX 30/40 card.');
  L.push('Send it (and the .zip beside it, if there is one) to the developer — paths have been');
  L.push('replaced with %USERPROFILE% and your Windows account name with <user>.');
  L.push(`#sig ${sigOf(failure, game)}`);
  L.push('');
  return L.join('\n');
}

// Append one report to today's file for this card, unless the identical failure is already in it.
// `desktop` is passed in so this is testable and so the caller decides where "Desktop" is.
function write(ctx = {}) {
  const failure = ctx.failure || failureOf(ctx);
  if (!failure) return null;
  const desktop = ctx.desktop || path.join(os.homedir(), 'Desktop');
  const when = ctx.when || new Date();
  const file = path.join(desktop, fileName(ctx.gpu, when));
  const sig = `#sig ${sigOf(failure, ctx.game)}`;
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  if (existing.includes(sig)) return { path: file, code: failure.code, written: false, reason: 'already reported today' };
  const body = render({ ...ctx, failure, when });
  try {
    fs.mkdirSync(desktop, { recursive: true });
    fs.appendFileSync(file, (existing ? '\n' : '') + body, 'utf8');
  } catch (e) {
    return { path: file, code: failure.code, written: false, error: String(e && e.message || e) };
  }
  return { path: file, code: failure.code, written: true, summary: failure.summary };
}

module.exports = { write, render, failureOf, fileName, hardwareSlug, watched, sigOf,
  BAD_VERDICTS, MFG_VERDICTS, QUIET_VERDICTS, NEXT_STEPS };
