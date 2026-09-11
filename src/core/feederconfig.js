'use strict';
// ReShade configuration for the DLSS 5 routes.
//
// native / native+bridge: the RenoDX DLSS add-on is a ReShade *add-on*, not an .fx effect.
//   It registers itself in the Add-ons tab once ReShade loads it from the game folder, so
//   nothing beyond a valid ReShade.ini is required — and we never clobber an existing one.
//
// feeder: for games with no DLSS of their own, DLSS5_Feed.fx is a real effect and needs
//   motion vectors. LumeniteFX supplies them (DLSS5_MV_PROVIDER=3), and the Lumenite kernel
//   must run ABOVE DLSS5_Feed in the technique list.
const ini = require('./ini');

const MV_PROVIDER = 3; // 1=Launchpad, 2=VORT, 3=Lumenite
const FEED_TECHNIQUES = [
  'Lumenite_Kernel@lumenite_Kernel.fx',
  'Lumenite_QuantMotion@lumenite_QuantMotion.fx',
  'DLSS5_Feed@DLSS5_Feed.fx',
];
const FEED_DEFAULTS = {
  enabled: '1', mode: '2', hdr: '-1', depth_inverted: '-1', flags: '-1',
  reset_every: '0', warmup_rebuild: '180', rebuild: '0', log_frames: '3',
  create_delay: '60', preset: '0', work_resolution: '100',
  mv_scale_x: '1.000', mv_scale_y: '1.000', host_window: '0', async_home: '1',
};

const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const techName = t => t.split('@')[0].trim().toLowerCase();

function mergeDefs(cur, def) {
  const key = s => s.split('=')[0].trim().toLowerCase();
  const kept = list(cur).filter(x => key(x) !== key(def));
  return [def, ...kept].join(',');
}

function addSearchPath(doc, key, want) {
  const paths = list(ini.get(doc, 'GENERAL', key));
  const norm = s => s.toLowerCase().replace(/\\+$/, '');
  if (!paths.some(p => norm(p) === norm(want))) paths.push(want);
  ini.set(doc, 'GENERAL', key, paths.join(','));
}

// Minimal, non-destructive config for the native / bridge routes.
function gameReShade(text) {
  const doc = ini.parse(text || '');
  if (!ini.get(doc, 'GENERAL', 'PresetPath')) ini.set(doc, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  ini.set(doc, 'GENERAL', 'NoReloadOnInit', '0');
  return ini.stringify(doc);
}

// Feeder route: shader search paths + the motion-vector provider definition.
function feederReShade(text) {
  const doc = ini.parse(text || '');
  addSearchPath(doc, 'EffectSearchPaths', '.\\reshade-shaders\\Shaders\\**');
  addSearchPath(doc, 'TextureSearchPaths', '.\\reshade-shaders\\Textures\\**');
  if (!ini.get(doc, 'GENERAL', 'PresetPath')) ini.set(doc, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  ini.set(doc, 'GENERAL', 'NoReloadOnInit', '0');
  ini.set(doc, 'GENERAL', 'PreprocessorDefinitions',
    mergeDefs(ini.get(doc, 'GENERAL', 'PreprocessorDefinitions'), `DLSS5_MV_PROVIDER=${MV_PROVIDER}`));
  return ini.stringify(doc);
}

// Feeder preset: our techniques first (kernel above feed), the user's kept after.
function feederPreset(text) {
  const doc = ini.parse(text || '');
  const ours = FEED_TECHNIQUES.map(techName);
  for (const key of ['Techniques', 'TechniqueSorting']) {
    const kept = list(ini.get(doc, '', key)).filter(t => !ours.includes(techName(t)));
    ini.set(doc, '', key, [...FEED_TECHNIQUES, ...kept].join(','));
  }
  ini.set(doc, '', 'PreprocessorDefinitions',
    mergeDefs(ini.get(doc, '', 'PreprocessorDefinitions'), `DLSS5_MV_PROVIDER=${MV_PROVIDER}`));
  ini.set(doc, 'DLSS5_Feed.fx', 'PreprocessorDefinitions',
    mergeDefs(ini.get(doc, 'DLSS5_Feed.fx', 'PreprocessorDefinitions'), `DLSS5_MV_PROVIDER=${MV_PROVIDER}`));
  return ini.stringify(doc);
}

// dlss5-feed.cfg defaults for the feeder host.
function feed(text) {
  const doc = ini.parse(text || '');
  for (const [k, v] of Object.entries(FEED_DEFAULTS)) if (ini.get(doc, '', k) == null) ini.set(doc, '', k, v);
  return ini.stringify(doc);
}

module.exports = { gameReShade, feederReShade, feederPreset, feed, MV_PROVIDER, FEED_TECHNIQUES };
