'use strict';
const fs = require('fs');
const path = require('path');
const { defaults } = require('../shared/looks');

const DEFAULTS = {
  version: 1,
  manualDirs: [],
  games: {},            // id -> { tier, exe, neuralKey, lastLook }
  looks: defaults(),    // shader parameter values
  startLook: 'default',
  transition: 0.6,
  overlay: { hotkey: 'Alt+Shift+R', x: null, y: null },
  lookHotkeys: { default: 'Alt+Shift+1', cinematic: 'Alt+Shift+2', natural: 'Alt+Shift+3' },
  ambientMotion: true,
  reducedTransparency: false,
  feederPayloadDir: null,
  nativeMode: null,     // desktop mode captured before Refract changed it
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'refract-settings.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, looks: { ...this.data.looks, ...(saved.looks || {}) },
        overlay: { ...this.data.overlay, ...(saved.overlay || {}) },
        lookHotkeys: { ...this.data.lookHotkeys, ...(saved.lookHotkeys || {}) } };
    } catch {}
  }
  get() { return this.data; }
  game(id) { return this.data.games[id] || { tier: 'native', exe: null, neuralKey: null }; }
  patch(p) { this.data = { ...this.data, ...p }; this.save(); return this.data; }
  patchGame(id, p) { this.data.games[id] = { ...this.game(id), ...p }; this.save(); return this.data.games[id]; }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, DEFAULTS };
