'use strict';
const { shell } = (() => { try { return require('electron'); } catch { return {}; } })();
const cp = require('child_process');
const path = require('path');
const { pickMode } = require('./display');

// A play session: capture the desktop mode, switch to the tier's output resolution,
// launch, wait for the game process to appear and then exit, and restore.
class Session {
  constructor(win, store, emit) {
    this.win = win; this.store = store; this.emit = emit;
    this.active = null;
  }

  async applyTier(tierId) {
    const native = this.store.get().nativeMode || await this.win.call('current');
    if (!this.store.get().nativeMode) this.store.patch({ nativeMode: native });
    const modes = await this.win.call('modes');
    const target = pickMode(modes, native, tierId);
    if (!target) throw new Error('No matching lower resolution with the same aspect ratio is available.');
    const cur = await this.win.call('current');
    if (cur.width !== target.width || cur.height !== target.height) {
      await this.win.call('setMode', { width: target.width, height: target.height, hz: target.hz });
    }
    if (tierId === 'native') this.store.patch({ nativeMode: null });
    this.emit('display', { tier: tierId, mode: target });
    return target;
  }

  async restore() {
    const native = this.store.get().nativeMode;
    if (!native) return null;
    await this.win.call('setMode', { width: native.width, height: native.height, hz: native.hz });
    this.store.patch({ nativeMode: null });
    this.emit('display', { tier: 'native', mode: native });
    return native;
  }

  async launch(game) {
    if (this.active) {
      // A session left over from a game that is no longer running must not block a new one.
      const st = await this.probe(this.active.name).catch(() => null);
      if (st && st.count > 0) throw new Error(`${this.active.game.name} is still running.`);
      await this.end('stale');
    }
    const cfg = this.store.game(game.id);
    const exe = cfg.exe || game.exe;
    if (!exe) throw new Error('Set the game executable first so Refract knows when it exits.');
    if (cfg.tier && cfg.tier !== 'native') await this.applyTier(cfg.tier);
    if (game.launch && /^[a-z]+:\/\//i.test(game.launch) && shell) await shell.openExternal(game.launch);
    else cp.spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();

    const name = path.basename(exe);
    this.active = { game, name, seen: false, started: Date.now(), lastWindow: 0, failures: 0 };
    this.emit('session', { state: 'launching', game: game.name });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs ?? 3000);
  }

  async probe(name) {
    const r = await this.win.call('procstate', { name }, 8000);
    return { count: Number(r && r.count) || 0, windows: Number(r && r.windows) || 0 };
  }

  // Ended when the process is gone, OR when it has had no visible window for a while (games
  // often linger in the background after you quit), OR when the check itself keeps failing.
  async tick() {
    const a = this.active;
    if (!a || this.ticking) return;
    this.ticking = true;
    try {
      let st;
      try { st = await this.probe(a.name); a.failures = 0; }
      catch { if (++a.failures >= 5) await this.end('lost'); return; }
      const now = Date.now();
      if (st.windows > 0) {
        a.lastWindow = now;
        if (!a.seen) { a.seen = true; this.emit('session', { state: 'running', game: a.game.name }); }
      }
      const gone = a.seen && (st.count === 0 || now - a.lastWindow > (this.lingerMs ?? 15000));
      const neverStarted = !a.seen && now - a.started > (this.startMs ?? 300000);
      if (gone || neverStarted) await this.end(gone ? 'exited' : 'timeout');
    } finally { this.ticking = false; }
  }

  // Also exposed to the UI so a user can always clear a session by hand.
  async end(reason = 'user') {
    const a = this.active;
    clearInterval(this.timer); this.timer = null;
    this.active = null;
    await this.restore().catch(() => {});
    if (a) this.emit('session', { state: 'ended', game: a.game.name, reason });
    return !!a;
  }

  async shutdown() { clearInterval(this.timer); await this.restore().catch(() => {}); }
}

module.exports = { Session };
