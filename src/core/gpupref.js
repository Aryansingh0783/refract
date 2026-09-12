'use strict';
// On a laptop with switchable graphics, Windows decides per executable which GPU a game runs on.
// A game that lands on the iGPU cannot run DLSS 5 at all — the add-on loads, finds no NVIDIA
// device to hook and quietly does nothing. Windows keeps that choice in one registry value, the
// same one the Graphics settings page writes, so Refract sets it for the games it touches and
// puts it back on restore.
const cp = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const HIGH = 'GpuPreference=2;';

function run(args, exec = cp.execFile) {
  return new Promise(resolve => {
    try {
      exec('reg.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
    } catch { resolve({ ok: false, out: '' }); }
  });
}

// The current value for this exe, or null when Windows has no preference for it.
async function get(exe, exec) {
  const r = await run(['query', KEY, '/v', exe], exec);
  if (!r.ok) return null;
  const m = /REG_SZ\s+(.+)$/im.exec(r.out);
  return m ? m[1].trim() : null;
}

// Ask Windows to run this exe on the discrete GPU. Returns what was there before, so a restore
// can put it back exactly (null means "there was no preference").
async function preferHighPerformance(exe, exec) {
  if (process.platform !== 'win32' || !exe) return { changed: false, previous: null };
  const previous = await get(exe, exec);
  if (previous === HIGH) return { changed: false, previous };
  const r = await run(['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', HIGH, '/f'], exec);
  return { changed: r.ok, previous: previous === null ? null : previous };
}

async function restore(exe, previous, exec) {
  if (process.platform !== 'win32' || !exe) return false;
  const r = previous == null
    ? await run(['delete', KEY, '/v', exe, '/f'], exec)
    : await run(['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', previous, '/f'], exec);
  return r.ok;
}

module.exports = { preferHighPerformance, restore, get, KEY, HIGH };
