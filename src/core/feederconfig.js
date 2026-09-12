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

// Tuned RenoDX DLSS 5 neural-rendering settings (the values the one-click reference
// installers ship). The add-on's own defaults (preset/style "Default", every strength 1.0)
// are very subtle — part of why a working install can look "the same as vanilla".
// Only written when the game has no [RenoDX.DLSS5] section yet, so a user's own tuning
// is never overwritten.
const NR_SECTION = 'RenoDX.DLSS5';
const NR_TUNED = {
  EnableHooks: '2', NeuralUplift: '1', NRAutoMask: '1', NRDepthMode: '0', NRDiffuseWhiteNits: '203',
  NRGlobalTone: '0.9', NRLocalStructure: '0.44', NRLocalTone: '1.22', NRPreset: '2',
  NRSkinStructure: '1.16', NRStyle: '1', NRUICorrection: '1',
};
// ReShade's own "Generic Depth" and "Effect Runtime Sync" add-ons interfere with the DLSS
// hooks and cost frames; the reference installers disable them on fresh configs.
const DISABLED_BUILTINS = 'Generic Depth,Effect Runtime Sync';

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

const hasSection = (doc, name) => doc.sections.some(s => s.name.toLowerCase() === name.toLowerCase());

// Never let a user's DisabledAddons list switch off the DLSS 5 add-ons we depend on.
function scrubDisabled(doc) {
  const cur = ini.get(doc, 'ADDON', 'DisabledAddons');
  if (cur == null) return;
  const kept = list(cur).filter(a => !/renodx|dlss5|dlss 5/i.test(a));
  if (kept.join(',') !== list(cur).join(',')) ini.set(doc, 'ADDON', 'DisabledAddons', kept.join(','));
}

// ReShade.ini for the native / bridge / feeder routes.
//   fresh config  -> sensible defaults, Home opens the overlay, tutorial skipped, tuned NR
//   existing one  -> only adds what is missing; the user's own [RenoDX.DLSS5] is kept as-is
// EnableHooks: 2 hooks NGX only and leaves the game's Streamline modules alone — what an RTX 50
// was verified on. 1 also patches Streamline, which is what 1-Click-DLSS5 ships by default and
// what a Streamline game on Ampere/Ada may need before the add-on ever sees a DLSS call.
function dlss5ReShade(text, { feeder = false, hooks = null } = {}) {
  const fresh = !String(text || '').trim();
  const doc = ini.parse(text || '');
  if (!ini.get(doc, 'GENERAL', 'PresetPath')) ini.set(doc, 'GENERAL', 'PresetPath', '.\\ReShadePreset.ini');
  if (fresh) {
    ini.set(doc, 'GENERAL', 'NoReloadOnInit', '0');
    ini.set(doc, 'ADDON', 'DisabledAddons', DISABLED_BUILTINS);
    ini.set(doc, 'INPUT', 'KeyOverlay', '36,0,0,0');          // Home
    ini.set(doc, 'OVERLAY', 'TutorialProgress', '4');         // skip ReShade's first-run tutorial
  }
  scrubDisabled(doc);
  if (!hasSection(doc, NR_SECTION)) {
    for (const [k, v] of Object.entries(NR_TUNED)) ini.set(doc, NR_SECTION, k, v);
    if (feeder) ini.set(doc, NR_SECTION, 'NREnableUpscaling', '0');
  } else if (feeder && ini.get(doc, NR_SECTION, 'NREnableUpscaling') == null) {
    ini.set(doc, NR_SECTION, 'NREnableUpscaling', '0');
  }
  // The hook mode is Refract's to set even in a config the user already tuned: it decides
  // whether the add-on can see this game's DLSS at all.
  if (hooks === 1 || hooks === 2) ini.set(doc, NR_SECTION, 'EnableHooks', String(hooks));
  return ini.stringify(doc);
}

// Feeder route: shader search paths + the motion-vector provider definition.
function feederReShade(text, { hooks = null } = {}) {
  const doc = ini.parse(dlss5ReShade(text, { feeder: true, hooks }));
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

// OptiScaler's config for the bridge route. The upstream ini is 47 kB of defaults; only these
// keys matter here, and they are the ones 1-Click-DLSS5 ships: force DLSS as the DX12 upscaler so
// the game's FSR/XeSS calls become DLSS calls, hook every upscaler input, leave OptiScaler's own
// overlay off (ReShade's Home overlay owns the UI), and keep logging out of the frame time.
const OPTI_SECTIONS = {
  Upscalers: { Dx12Upscaler: 'dlss', Dx11Upscaler: 'auto', VulkanUpscaler: 'auto' },
  FrameGen: { Enabled: 'auto' },
  Inputs: { EnableDlssInputs: 'true', EnableXeSSInputs: 'true', EnableFsr2Inputs: 'true', EnableFsr3Inputs: 'true',
    EnableFfxInputs: 'true', UseFsr2Inputs: 'true', UseFsr3Inputs: 'true', UseFfxInputs: 'true' },
  DLSS: { Enabled: 'true', RenderPresetOverride: 'false' },
  Hooks: { HookD3D12: 'true', HookSL: 'true' },
  Menu: { OverlayMenu: 'false', DisableSplash: 'true' },
  Log: { LogLevel: '0', LogToFile: 'false' },
};

function optiScalerIni() {
  const out = ['; Written by Refract for the DLSS 5 bridge route.',
    '; The game\'s FSR 2/3 or XeSS calls are routed to DLSS so neural rendering has something to',
    '; hang off. Delete this file and the DLLs beside it, or use Restore original, to undo.', ''];
  for (const [section, keys] of Object.entries(OPTI_SECTIONS)) {
    out.push(`[${section}]`);
    for (const [k, v] of Object.entries(keys)) out.push(`${k}=${v}`);
    out.push('');
  }
  return out.join('\r\n');
}

module.exports = { gameReShade, dlss5ReShade, feederReShade, feederPreset, feed, optiScalerIni, MV_PROVIDER, FEED_TECHNIQUES, NR_TUNED, NR_SECTION, OPTI_SECTIONS };
