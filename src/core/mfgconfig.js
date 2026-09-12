'use strict';
// The two config files Multi Frame Generation is steered by, written the same way
// feederconfig.js writes ReShade's: Refract owns the handful of keys that decide whether MFG
// runs and how, and leaves every other line — including anything the user edited — alone.
//
//   dlssg_sm86.ini   the engine: which architecture to route to, and the multiplier ceiling
//   nvngx.ini        the router: DLSS-G vs FSR3, Reflex, and the frame cap
//
// Two honest notes that the UI has to repeat:
//   * MaxGeneratedFrames is a capability ceiling, not a forced multiplier. The game asks for the
//     multiplier it wants; this says what it is allowed to ask for.
//   * dlssg_sm86 has no Reflex Warp. Reflex + a frame cap is the whole latency story.

// 2X/3X/4X -> the engine's MaxGeneratedFrames (number of *generated* frames per real one).
const MULTIPLIERS = { 2: 1, 3: 2, 4: 3 };
const MULTIPLIER_CHOICES = [2, 3, 4];

// SM75 = Turing (RTX 20), SM86 = Ampere (RTX 30). Ada (RTX 40) also routes through SM86: the
// engine's own router only distinguishes the two kernel families.
function routerFor(gpu) {
  const s = gpu && gpu.series;
  if (s === 20) return 'SM75';
  return 'SM86';
}

function clampMultiplier(m) {
  const n = Number(m);
  return MULTIPLIER_CHOICES.includes(n) ? n : 2;
}

// Frame cap. FramerateLimit counts *generated* frames, so the cap belongs just under the
// display's refresh: above it the extra frames are thrown away and latency grows for nothing.
// The real (rendered) rate the game must sustain is that cap divided by the multiplier, which is
// the number worth showing the user — a 165 Hz panel at 3X needs only ~53 real fps.
function frameCap({ refresh = null, multiplier = 2, margin = 3 } = {}) {
  const m = clampMultiplier(multiplier);
  const hz = Number(refresh);
  if (!Number.isFinite(hz) || hz <= 0) return { cap: null, real: null, multiplier: m, why: 'Display refresh rate unknown, so no cap is set.' };
  const cap = Math.max(m * 10, Math.floor(hz) - margin);
  const real = Math.floor((cap / m) * 10) / 10;
  return {
    cap, real, multiplier: m, margin,
    why: `${cap} fps cap on a ${Math.floor(hz)} Hz display at ${m}X — the game itself renders about ${real} fps.`,
  };
}

// ---------------------------------------------------------------- ini editing
// Same contract as feederconfig: set a key inside its section, add the section if missing,
// never reorder or drop anything else.
function setKey(text, section, key, value) {
  const src = String(text == null ? '' : text);
  const eol = /\r\n/.test(src) || src === '' ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const head = new RegExp(`^\\s*\\[${section}\\]\\s*$`, 'i');
  const kre = new RegExp(`^\\s*;?\\s*${key}\\s*=`, 'i');
  let start = lines.findIndex(l => head.test(l));
  if (start === -1) {
    const body = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return [...body, `[${section}]`, `${key}=${value}`, ''].join(eol);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    if (kre.test(lines[i])) { lines[i] = `${key}=${value}`; return lines.join(eol); }
  }
  // Insert after the last non-blank line of the section so comments stay attached above.
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `${key}=${value}`);
  return lines.join(eol);
}

function setAll(text, pairs) {
  let out = text;
  for (const [section, key, value] of pairs) out = setKey(out, section, key, value);
  return out;
}

// ---------------------------------------------------------------- dlssg_sm86.ini
// `exact` (default) keeps HardwareBilinear=0 — the engine's exact output path. The approximate
// path is faster and visibly softer in motion, which is the opposite of what someone chasing
// ghosting wants, so it is opt-in only.
function engineIni(text, { gpu = null, multiplier = 2, exact = true, kernel = 'PTX', logLevel = 1 } = {}) {
  const m = clampMultiplier(multiplier);
  return setAll(text, [
    ['Compatibility', 'Router', routerFor(gpu)],
    // PTX is JIT-compiled by the driver and runs on any matching family; cubin needs an exact
    // GPU match. PTX until cubin is measured on real Ampere.
    ['Compatibility', 'KernelImage', kernel],
    ['Compatibility', 'HardwareBilinear', exact ? 0 : 1],
    ['FrameGeneration', 'MaxGeneratedFrames', MULTIPLIERS[m]],
    ['Logging', 'Level', logLevel],
  ]);
}

// ---------------------------------------------------------------- nvngx.ini (the FG router)
// generator 'dlssg' is the native NVIDIA path, which handles the game's UI itself. 'fsr3' is the
// fallback and always needs OptiScaler's HUDfix, so it ghosts around the HUD unless that is on.
function routerIni(text, { generator = 'dlssg', reflex = 'on', cap = null, mode = 'auto' } = {}) {
  const g = generator === 'fsr3' ? 'fsr3' : 'dlssg';
  const r = ['on', 'boost', 'off'].includes(reflex) ? reflex : 'on';
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : 'off';
  return setAll(text, [
    ['FrameGeneration', 'Generator', g],
    ['FrameGeneration', 'Reflex', r],
    ['FrameGeneration', 'FramerateLimit', limit],
    ['FrameGeneration', 'FrameGenerationMode', mode === 'dynamic' ? 'dynamic' : 'auto'],
  ]);
}

// One place that turns a per-game MFG setting into everything that gets written, so the UI, the
// installer and the verifier all agree on what "3X, lowest latency" means.
function plan({ gpu = null, refresh = null, mfg = {} } = {}) {
  const multiplier = clampMultiplier(mfg.multiplier);
  const generator = mfg.fallback ? 'fsr3' : 'dlssg';
  const reflex = mfg.reflex === 'boost' ? 'boost' : mfg.reflex === 'off' ? 'off' : 'on';
  const cap = mfg.cap === null || mfg.cap === 'off'
    ? { cap: null, real: null, multiplier, why: 'No frame cap — latency will be higher than it needs to be.' }
    : Number.isFinite(Number(mfg.cap))
      ? frameCap({ refresh: Number(mfg.cap) * 1, multiplier, margin: 0 })
      : frameCap({ refresh, multiplier });
  return {
    multiplier,
    maxGeneratedFrames: MULTIPLIERS[multiplier],
    router: routerFor(gpu),
    generator,
    reflex,
    exact: mfg.exact !== false,
    cap: cap.cap,
    realFps: cap.real,
    capWhy: cap.why,
    // What the UI must say, in the app's own words, rather than a promise it cannot keep.
    ghosting: generator === 'dlssg'
      ? 'Native DLSS-G: the game\'s UI is handled by NVIDIA\'s own pass, and exact sampling is on.'
      : 'FSR3 fallback: turn OptiScaler\'s HUDfix on, or the HUD will ghost.',
    latency: reflex === 'off'
      ? 'Reflex is off — frame generation will add noticeable latency.'
      : `Reflex ${reflex}${cap.cap ? ` and a ${cap.cap} fps cap` : ''}. Frame generation still adds latency; this engine has no Reflex Warp.`,
  };
}

module.exports = {
  MULTIPLIERS, MULTIPLIER_CHOICES, routerFor, clampMultiplier, frameCap,
  engineIni, routerIni, setKey, plan,
};
