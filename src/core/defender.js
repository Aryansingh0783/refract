'use strict';
// Windows Defender quarantines some of what DLSS 5 needs. Observed on this project: the
// 1-Click-DLSS5 archive is removed on download, and a patched nvngx_dlssnr.dll is exactly the
// kind of file real-time protection takes away seconds after it is written — which looks, from
// inside the game, identical to Refract never having installed it. So Refract asks Defender what
// it removed lately and says so, instead of leaving the user with "the file was not found".
const cp = require('child_process');

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const SCRIPT = `try {
  Get-MpThreatDetection -ErrorAction Stop |
    Sort-Object InitialDetectionTime -Descending |
    Select-Object -First 25 |
    ForEach-Object { [pscustomobject]@{ at = $_.InitialDetectionTime.ToString('o'); id = $_.ThreatID; action = "$($_.ActionSuccess)"; files = @($_.Resources) } } |
    ConvertTo-Json -Depth 4 -Compress
} catch { '[]' }`;

function run(exec = cp.execFile) {
  return new Promise(resolve => {
    try {
      exec('powershell.exe', [...PS, SCRIPT], { windowsHide: true, timeout: 15000, maxBuffer: 4 << 20 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(String(stdout || '[]').trim() || '[]');
          resolve(Array.isArray(j) ? j : [j]);
        } catch { resolve([]); }
      });
    } catch { resolve([]); }
  });
}

// Detections that mention any of these paths (a game folder, Refract's cache), newest first.
async function detectionsFor(paths = [], { exec, sinceHours = 72 } = {}) {
  if (process.platform !== 'win32') return [];
  const all = await run(exec);
  const cutoff = Date.now() - sinceHours * 3600e3;
  const want = paths.filter(Boolean).map(p => String(p).toLowerCase());
  return all
    .filter(d => {
      const t = Date.parse(d.at);
      if (Number.isFinite(t) && t < cutoff) return false;
      if (!want.length) return true;
      const files = (d.files || []).join(' ').toLowerCase();
      return want.some(w => files.includes(w));
    })
    .map(d => ({ at: d.at, id: d.id, action: d.action, files: (d.files || []).map(f => String(f).replace(/^\w+:_/, '')) }));
}

// One line for the UI when a file Refract wrote is gone and Defender took something nearby.
function explain(list) {
  if (!list || !list.length) return null;
  const names = [...new Set(list.flatMap(d => d.files.map(f => f.split(/[\\/]/).pop())))].slice(0, 3);
  return `Windows Defender removed ${names.join(', ')} recently. DLSS 5's runtime is a modified NVIDIA file, so real-time protection can quarantine it moments after Refract writes it. Add an exclusion for the game folder, then repair.`;
}

module.exports = { detectionsFor, explain };
