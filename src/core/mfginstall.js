'use strict';
// Where the Multi Frame Generation engine goes in a game folder, and who it has to negotiate
// with to get there.
//
// dlssg_sm86.dll is a proxy DLL, and a proxy DLL only works under the name whose exports it
// carries. Reading its export table: 17 version.dll entries (GetFileVersionInfo*, VerQueryValue*,
// VerFindFile*, VerInstallFile*, VerLanguageName*) and 50 NGX entries — and nothing from winmm,
// dinput8 or dxgi. So unlike OptiScaler, which Refract can place under any of four names, this
// build has exactly one home: version.dll. Rename it to winmm.dll and the game fails to start
// with missing imports.
//
// That makes slot allocation a real negotiation rather than a preference:
//   ReShade   picks from RESHADE_PROXIES and in practice takes dxgi.dll — rarely a problem
//   OptiScaler picks from OPTI_PROXIES, which *includes* version.dll — so it must be told to
//             leave that name alone whenever MFG is also wanted
//   anything else already sitting on version.dll is somebody else's mod, and MFG is refused
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const mfgassets = require('./mfgassets');

// The only name this build can be loaded under.
const MFG_PROXY = 'version.dll';
const INI_NAME = 'dlssg_sm86.ini';
// The pinned engine hash, as stored in the catalog (a 16-char prefix).
const ENGINE_HASH = (mfgassets.FILES.find(f => f.rel === mfgassets.MFG_DLL_REL) || {}).sha256 || null;

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function sha256Head(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

// Is the version.dll sitting here the engine Refract installs? Manifest first (cheap and
// authoritative for our own installs), then the pinned hash, which settles it for a folder
// Refract has never touched.
function isOurEngine(exeDir, man = {}) {
  const p = path.join(exeDir, MFG_PROXY);
  if (!fs.existsSync(p)) return false;
  if (man.mfgProxy && man.mfgProxy.toLowerCase() === MFG_PROXY) return true;
  const got = sha256Head(p);
  return !!(got && ENGINE_HASH && got.startsWith(ENGINE_HASH));
}

const CODES = {
  taken: 'Another mod already uses version.dll in this folder. Remove it, or install Multi Frame Generation into a copy of the game that does not have it.',
  reshade: 'ReShade is installed as version.dll here, and the frame-generation engine needs that exact name. Reinstall ReShade under a different proxy (Refract normally uses dxgi.dll) and try again.',
};

// Can MFG have its slot in this folder?
//   { ok: true,  proxy: 'version.dll', replacing: bool }
//   { ok: false, code, reason }
// `reshadeProxy` is what ReShade owns (from feeder.inspect), `man` the Refract manifest.
function slotFor(exeDir, { reshadeProxy = null, man = {} } = {}) {
  if ((reshadeProxy || '').toLowerCase() === MFG_PROXY) return { ok: false, code: 'reshade', reason: CODES.reshade };
  const present = listDir(exeDir).some(n => n.toLowerCase() === MFG_PROXY);
  if (!present) return { ok: true, proxy: MFG_PROXY, replacing: false };
  // Ours already (an earlier install or a repair): fine, we overwrite our own file.
  if (isOurEngine(exeDir, man)) return { ok: true, proxy: MFG_PROXY, replacing: true };
  // OptiScaler placed by Refract under version.dll: solvable, but the caller has to move it
  // rather than us clobbering a working bridge.
  if (man.optiProxy && man.optiProxy.toLowerCase() === MFG_PROXY) {
    return { ok: false, code: 'optiscaler', reason: 'The OptiScaler bridge is installed as version.dll here, which the frame-generation engine needs. Remove DLSS 5 from this game and set it up again with Multi Frame Generation on, and Refract will give OptiScaler a different name.' };
  }
  return { ok: false, code: 'taken', reason: CODES.taken };
}

// The names OptiScaler must not take when MFG is wanted for this game. Passed into the existing
// allocator as a reservation so an MFG install never has to fight a bridge Refract placed itself.
function reservedFor({ mfg = false } = {}) {
  return mfg ? [MFG_PROXY] : [];
}

// Everything MFG puts in the game folder, as {from -> to} plus the inis the caller writes.
// Kept as data so the installer, the verifier and the tests all read the same list.
function fileMap(exeDir, files) {
  const out = [];
  const add = (rel, name) => { const src = files[rel]; if (src) out.push({ rel, src, dest: path.join(exeDir, name) }); };
  add(mfgassets.MFG_DLL_REL, MFG_PROXY);          // the engine, under its only valid name
  add(mfgassets.DLSSG_REL, 'nvngx_dlssg.dll');    // the DLSS-G runtime it serves
  add(mfgassets.REFLEX_REL, 'sl.reflex.dll');     // Reflex: the latency lever
  add(mfgassets.PCL_REL, 'sl.pcl.dll');
  add(mfgassets.NOTICES_REL, 'dlssg_sm86_THIRD_PARTY_NOTICES.txt');
  return out;
}

// The files an MFG install owns, by name in the game folder — used by verify and by restore.
function ownedNames() {
  return [MFG_PROXY, 'nvngx_dlssg.dll', 'sl.reflex.dll', 'sl.pcl.dll', INI_NAME,
    'dlssg_sm86_THIRD_PARTY_NOTICES.txt'];
}

module.exports = { MFG_PROXY, INI_NAME, ENGINE_HASH, slotFor, reservedFor, fileMap, ownedNames, isOurEngine, CODES };
