'use strict';
const fs = require('fs');
const path = require('path');
const ini = require('./ini');
const { LOOKS, defaults } = require('../shared/looks');

// Refract rides on an existing ReShade install in the game folder. We never replace the
// user's preset: we append one technique ("Refract") to it and add our shader folder to
// the search paths. Both files get a one-time .refract-backup first.

const rt = require('./reshaderuntime');
const { proxyName } = require('./peimports');

const SHADER_SRC = path.join(__dirname, '..', '..', 'shaders', 'Refract.fx');
const TECH = 'Refract@Refract.fx';
const SEARCH = '.\\refract-shaders\\';
const BAK = '.refract-backup';
const RESHADE_NAMES = ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d10.dll', 'd3d9.dll', 'd3d8.dll', 'ddraw.dll', 'opengl32.dll', 'ReShade64.dll', 'ReShade32.dll'];

// Auto-install the ReShade runtime into a game folder if it is not already there, then
// return the path to its ReShade.ini. This is what makes "Install looks" one click.
// It installs the ADD-ON build: the plain build silently refuses every add-on, which would
// switch DLSS 5 off in the same game. Whatever it adds is recorded in refract-reshade.json
// so Restore original can take it out again.
const RUNTIME_MANIFEST = 'refract-reshade.json';
async function ensureRuntime(exeDir, { api = 'dxgi', bitness = 64, cacheRoot } = {}) {
  const iniPath = path.join(exeDir, 'ReShade.ini');
  const proxy = proxyName(api);
  const man = readRuntimeManifest(exeDir) || { version: 1, added: [], before: safeList(exeDir) };
  const note = p => { if (!man.added.some(x => x.toLowerCase() === p.toLowerCase())) man.added.push(p); };
  let installed = false, found = null;
  for (const name of [proxy, ...RESHADE_NAMES]) {
    const f = path.join(exeDir, name);
    if (fs.existsSync(f) && rt.isReShade(f)) { found = name; break; }
  }
  if (!found) {
    if (api === 'vulkan') throw new Error('Vulkan games need a ReShade layer; that route is not automated yet.');
    const dll = await rt.ensureReShade(cacheRoot, { addon: true, bitness });
    const dest = path.join(exeDir, proxy);
    await fs.promises.copyFile(dll, dest);
    note(proxy); installed = true; found = proxy;
  }
  if (!fs.existsSync(iniPath)) {
    await fs.promises.writeFile(iniPath, '[GENERAL]\r\nPresetPath=.\\ReShadePreset.ini\r\n\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\n\r\n[OVERLAY]\r\nTutorialProgress=4\r\n');
    note('ReShade.ini');
  }
  if (man.added.length) await fs.promises.writeFile(path.join(exeDir, RUNTIME_MANIFEST), JSON.stringify(man, null, 2));
  return { iniPath, installed, proxy: found };
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function readRuntimeManifest(exeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(exeDir, RUNTIME_MANIFEST), 'utf8')); } catch { return null; }
}

// Everything the looks feature changed in a game folder, fully undone:
// the Refract technique, its shader folder, any config backups, and the ReShade runtime
// (plus the logs/preset ReShade generated) if Refract was the one that installed it.
async function removeAll(exeDir, reshadeIniPath) {
  const done = [];
  const inis = [...new Set([reshadeIniPath, path.join(exeDir, 'ReShade.ini')])].filter(p => p && fs.existsSync(p));
  const presets = [];
  for (const iniPath of inis) {
    const doc = ini.parse(await read(iniPath));
    const preset = presetPathFor(iniPath, doc);
    presets.push(preset);
    const pdoc = ini.parse(await read(preset));
    const refs = splitList(ini.get(doc, 'GENERAL', 'EffectSearchPaths')).some(p => p.toLowerCase().replace(/\\+$/, '') === SEARCH.toLowerCase().replace(/\\+$/, ''))
      || splitList(ini.get(pdoc, '', 'Techniques')).includes(TECH) || pdoc.sections.some(x => x.name === 'Refract.fx');
    if (refs) { await uninstall(iniPath); if (!done.includes('looks')) done.push('looks'); }
  }
  // The surgical uninstall above reverses exactly what Refract changed. A backup copy can
  // predate settings changed since (DLSS 5 tuning, key bindings), so it is dropped, never
  // copied back over the live file.
  const inExe = [path.join(exeDir, 'ReShade.ini'), path.join(exeDir, 'ReShadePreset.ini')];
  for (const f of new Set([...inis, ...presets, ...inExe])) await fs.promises.rm(f + BAK, { force: true }).catch(() => {});
  const shaderDir = path.join(exeDir, 'refract-shaders');
  if (fs.existsSync(shaderDir)) { await fs.promises.rm(shaderDir, { recursive: true, force: true }); done.push('Refract shader'); }
  const man = readRuntimeManifest(exeDir);
  if (man) {
    for (const rel of man.added || []) { try { await fs.promises.rm(path.join(exeDir, rel), { force: true }); } catch {} }
    if ((man.added || []).some(r => /\.dll$/i.test(r)) && Array.isArray(man.before)) {
      const before = new Set(man.before.map(n => n.toLowerCase()));
      for (const n of safeList(exeDir)) {
        if (!before.has(n.toLowerCase()) && /^(ReShade\.log\d*|ReShadePreset\.ini)$/i.test(n)) { try { await fs.promises.rm(path.join(exeDir, n), { force: true }); } catch {} }
      }
    }
    await fs.promises.rm(path.join(exeDir, RUNTIME_MANIFEST), { force: true });
    done.push('ReShade');
  }
  return done;
}

function touched(exeDir) {
  return !!readRuntimeManifest(exeDir) || fs.existsSync(path.join(exeDir, 'refract-shaders'));
}

async function read(p) { try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; } }
async function backupOnce(p) {
  try { await fs.promises.access(p + BAK); } catch { try { await fs.promises.copyFile(p, p + BAK); } catch {} }
}

function presetPathFor(reshadeIniPath, doc) {
  const dir = path.dirname(reshadeIniPath);
  const raw = (ini.get(doc, 'GENERAL', 'PresetPath') || '.\\ReShadePreset.ini').replace(/[\\/]/g, path.sep);
  return path.isAbsolute(raw) || /^[a-z]:/i.test(raw) ? raw : path.join(dir, raw);
}

function splitList(v) { return (v || '').split(',').map(s => s.trim()).filter(Boolean); }

async function status(reshadeIniPath) {
  if (!reshadeIniPath) return { reshade: false, installed: false };
  const doc = ini.parse(await read(reshadeIniPath));
  const preset = presetPathFor(reshadeIniPath, doc);
  const pdoc = ini.parse(await read(preset));
  const installed = splitList(ini.get(pdoc, '', 'Techniques')).includes(TECH)
    && fs.existsSync(path.join(path.dirname(reshadeIniPath), 'refract-shaders', 'Refract.fx'));
  const start = Number(ini.get(pdoc, 'Refract.fx', 'RefractStartLook') || 0);
  return { reshade: true, installed, preset, startLook: (LOOKS[start] || LOOKS[0]).id };
}

function writeLookValues(pdoc, values, startLookId, transition) {
  const v = { ...defaults(), ...(values || {}) };
  const start = (LOOKS.find(l => l.id === startLookId) || LOOKS[0]).index;
  ini.set(pdoc, 'Refract.fx', 'RefractStartLook', String(start));
  ini.set(pdoc, 'Refract.fx', 'RefractTransition', (transition ?? 0.6).toFixed(3));
  for (const [k, val] of Object.entries(v)) ini.set(pdoc, 'Refract.fx', k, Number(val).toFixed(6));
}

async function install(reshadeIniPath, { values, startLook = 'default', transition } = {}) {
  if (!reshadeIniPath) throw new Error('ReShade is not installed for this game. Install ReShade first (reshade.me), then retry.');
  const dir = path.dirname(reshadeIniPath);
  await fs.promises.mkdir(path.join(dir, 'refract-shaders'), { recursive: true });
  await fs.promises.copyFile(SHADER_SRC, path.join(dir, 'refract-shaders', 'Refract.fx'));

  await backupOnce(reshadeIniPath);
  const doc = ini.parse(await read(reshadeIniPath));
  const paths = splitList(ini.get(doc, 'GENERAL', 'EffectSearchPaths'));
  if (!paths.some(p => p.toLowerCase().replace(/\\+$/, '') === SEARCH.toLowerCase().replace(/\\+$/, ''))) {
    paths.push(SEARCH);
    ini.set(doc, 'GENERAL', 'EffectSearchPaths', paths.join(','));
  }
  const preset = presetPathFor(reshadeIniPath, doc);
  if (!ini.get(doc, 'GENERAL', 'PresetPath')) ini.set(doc, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  await fs.promises.writeFile(reshadeIniPath, ini.stringify(doc));

  const existing = await read(preset);
  if (existing !== null) await backupOnce(preset);
  const pdoc = ini.parse(existing || '');
  const techs = splitList(ini.get(pdoc, '', 'Techniques'));
  if (!techs.includes(TECH)) { techs.push(TECH); ini.set(pdoc, '', 'Techniques', techs.join(',')); }
  const sorting = splitList(ini.get(pdoc, '', 'TechniqueSorting'));
  if (!sorting.includes(TECH)) { sorting.push(TECH); ini.set(pdoc, '', 'TechniqueSorting', sorting.join(',')); }
  writeLookValues(pdoc, values, startLook, transition);
  await fs.promises.writeFile(preset, ini.stringify(pdoc));
  return status(reshadeIniPath);
}

async function updateLooks(reshadeIniPath, opts) {
  const doc = ini.parse(await read(reshadeIniPath));
  const preset = presetPathFor(reshadeIniPath, doc);
  const pdoc = ini.parse(await read(preset));
  writeLookValues(pdoc, opts.values, opts.startLook, opts.transition);
  await fs.promises.writeFile(preset, ini.stringify(pdoc));
}

async function uninstall(reshadeIniPath) {
  const doc = ini.parse(await read(reshadeIniPath));
  const paths = splitList(ini.get(doc, 'GENERAL', 'EffectSearchPaths'))
    .filter(p => p.toLowerCase().replace(/\\+$/, '') !== SEARCH.toLowerCase().replace(/\\+$/, ''));
  ini.set(doc, 'GENERAL', 'EffectSearchPaths', paths.join(','));
  await fs.promises.writeFile(reshadeIniPath, ini.stringify(doc));
  const preset = presetPathFor(reshadeIniPath, doc);
  if (fs.existsSync(preset)) {
    const pdoc = ini.parse(await read(preset));
    for (const key of ['Techniques', 'TechniqueSorting']) {
      ini.set(pdoc, '', key, splitList(ini.get(pdoc, '', key)).filter(t => t !== TECH).join(','));
    }
    pdoc.sections = pdoc.sections.filter(s => s.name !== 'Refract.fx');
    await fs.promises.writeFile(preset, ini.stringify(pdoc));
  }
  return status(reshadeIniPath);
}

module.exports = { status, install, updateLooks, uninstall, ensureRuntime, removeAll, touched, TECH, RUNTIME_MANIFEST };
