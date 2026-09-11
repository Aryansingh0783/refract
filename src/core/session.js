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
    if (this.active) throw new Error('A session is already running.');
    const cfg = this.store.game(game.id);
    const exe = cfg.exe || game.exe;
    if (!exe) throw new Error('Set the game executable first so Refract knows when it exits.');
    if (cfg.tier && cfg.tier !== 'native') await this.applyTier(cfg.tier);
    if (game.launch && /^[a-z]+:\/\//i.test(game.launch) && shell) await shell.openExternal(game.launch);
    else cp.spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();

    const name = path.basename(exe);
    this.active = { game, name, seen: false, started: Date.now() };
    this.emit('session', { state: 'launching', game: game.name });
    this.timer = setInterval(() => this.tick().catch(() => {}), 3000);
  }

  async tick() {
    const a = this.active;
    if (!a) return;
    const running = await this.win.call('running', { name: a.name });
    if (running && !a.seen) { a.seen = true; this.emit('session', { state: 'running', game: a.game.name }); }
    const gaveUp = !a.seen && Date.now() - a.started > 180000;
    if ((a.seen && !running) || gaveUp) {
      clearInterval(this.timer);
      this.active = null;
      await this.restore().catch(() => {});
      this.emit('session', { state: 'ended', game: a.game.name });
    }
  }

  async shutdown() { clearInterval(this.timer); await this.restore().catch(() => {}); }
}

module.exports = { Session };
