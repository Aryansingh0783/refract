'use strict';
// Who may be offered Multi Frame Generation, and why not when the answer is no.
//
// The rule is narrow on purpose. dlssg_sm86 is a Windows x64 D3D12 engine carrying SM75/SM86
// kernels, so anything outside that is refused with a readable reason rather than installed and
// left to fail in-game. RTX 50 is refused too: those cards have NVIDIA's own MFG and Refract has
// no business putting a community engine in front of it.
const cfg = require('./mfgconfig');

const REASONS = {
  'no-gpu': 'No NVIDIA GPU was detected.',
  'not-rtx': 'Multi Frame Generation needs an RTX card.',
  'rtx50': 'This card has NVIDIA\'s own Multi Frame Generation — turn it on in the game instead. Refract does not replace it.',
  'turing': 'RTX 20 (Turing) is experimental: the engine carries SM75 kernels, but upstream has not verified them. Turn on experimental support to try it.',
  'api': 'Multi Frame Generation is DirectX 12 only. This game uses %s.',
  'bitness': 'Multi Frame Generation is 64-bit only.',
  'platform': 'Windows only.',
};

// gpu: from nvidia.js. game: { api, apiLabel, dx, bitness }.
function eligible(gpu, game = {}, { experimentalTuring = false, platform = process.platform } = {}) {
  const no = (code, sub) => ({ ok: false, code, reason: sub ? REASONS[code].replace('%s', sub) : REASONS[code] });
  if (platform !== 'win32') return no('platform');
  if (!gpu || !gpu.name) return no('no-gpu');
  if (!gpu.series) return no('not-rtx');
  if (gpu.series >= 50) return no('rtx50');
  if (gpu.series === 20 && !experimentalTuring) return no('turing');
  if (gpu.series < 20) return no('not-rtx');
  if (Number(game.bitness || 64) !== 64) return no('bitness');
  if (Number(game.dx) !== 12) return no('api', game.apiLabel || 'something other than DirectX 12');
  return {
    ok: true,
    router: cfg.routerFor(gpu),
    experimental: gpu.series === 20,
    multipliers: cfg.MULTIPLIER_CHOICES,
  };
}

// The default per-game setting for a card that is eligible: 2X, native path, Reflex on, and a
// cap derived from the display. Conservative on purpose — 3X and 4X are a choice the user makes
// once they have seen 2X behave.
function defaults() {
  return { enabled: false, multiplier: 2, reflex: 'on', cap: 'auto', exact: true, fallback: false };
}

module.exports = { eligible, defaults, REASONS };
