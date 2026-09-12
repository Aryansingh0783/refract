'use strict';
const fs = require('fs');
const path = require('path');
const { defaults } = require('../shared/looks');

const DEFAULTS = {
  version: 1,
  manualDirs: [],
  games: {},            // id -> { tier, exe, neuralKey, lastLook, engine, mfg, gpuPreference (value replaced on install) }
  looks: defaults(),    // shader parameter values
  startLook: 'default',
  transition: 0.6,
  // Not Alt+Shift: that is Windows' keyboard-language switch and swallows the combo on any PC
  // with two input languages installed.
  overlay: { hotkey: 'Ctrl+Alt+R', x: null, y: null, pinned: false },
  lookHotkeys: { default: 'Ctrl+Alt+1', cinematic: 'Ctrl+Alt+2', natural: 'Ctrl+Alt+3' },
  onboarded: false,
  ambientMotion: true,
  reducedTransparency: false,
  feederPayloadDir: null,
  nativeMode: null,     // desktop mode captured before Refract changed it
  dlss5UpgradeSr: true, // upgrade a game's own nvngx_dlss.dll when Refract's build is newer
  // The bundled NeuralScreen engine (screen-space DLSS 5).
  neuralScreen: { profile: 'Natural', faster: false, workScale: 0.65 },
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'refract-settings.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, looks: { ...this.data.looks, ...(saved.looks || {}) },
        overlay: { ...this.data.overlay, ...(saved.overlay || {}) },
        lookHotkeys: { ...this.data.lookHotkeys, ...(saved.lookHotkeys || {}) },
        neuralScreen: { ...this.data.neuralScreen, ...(saved.neuralScreen || {}) } };
      // Move anyone still on the old Alt+Shift defaults to the new ones.
      if (this.data.overlay.hotkey === 'Alt+Shift+R') this.data.overlay.hotkey = DEFAULTS.overlay.hotkey;
      for (const [k, v] of Object.entries(this.data.lookHotkeys)) {
        if (v === `Alt+Shift+${{ default: 1, cinematic: 2, natural: 3 }[k]}`) this.data.lookHotkeys[k] = DEFAULTS.lookHotkeys[k];
      }
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

Store.DEFAULTS = DEFAULTS;
module.exports = { Store, DEFAULTS };
