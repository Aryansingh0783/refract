'use strict';
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

// In a packaged build the script lives in app.asar.unpacked (see build.asarUnpack):
// powershell.exe is a separate process and cannot read files inside app.asar.
function unpackedPath(p, exists = require('fs').existsSync) {
  const u = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return u !== p && exists(u) ? u : p;
}

// Thin JSON-lines client for scripts/winhelper.ps1 (started once, reused).
class WinHelper {
  constructor(scriptPath) {
    this.scriptPath = unpackedPath(scriptPath || path.join(__dirname, '..', '..', 'scripts', 'winhelper.ps1'));
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
  }

  get supported() { return process.platform === 'win32'; }

  start() {
    if (this.ready) return this.ready;
    if (!this.supported) return (this.ready = Promise.reject(new Error('Windows only')));
    this.ready = new Promise((resolve, reject) => {
      const p = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      const rl = readline.createInterface({ input: p.stdout });
      const timer = setTimeout(() => reject(new Error('helper did not start')), 20000);
      rl.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { clearTimeout(timer); resolve(); return; }
        const job = this.pending.get(msg.id);
        if (!job) return;
        this.pending.delete(msg.id);
        msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
      });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('exit', code => {
        clearTimeout(timer);
        for (const j of this.pending.values()) j.reject(new Error('helper exited ' + code + ' ' + err.slice(0, 400)));
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(new Error('helper exited ' + code + ' ' + err.slice(0, 400)));
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 15000) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(cmd + ' timed out')); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  stop() { if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} } }
}

module.exports = { WinHelper, unpackedPath };
