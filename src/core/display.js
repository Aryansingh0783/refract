'use strict';
// Output-resolution governor.
// Reviews of DLSS 5 neural rendering report its cost follows the OUTPUT resolution, and that
// dropping the internal (upscaler) resolution barely helps. So the lever that works is a lower
// output resolution, with the GPU scaler filling the panel. For borderless-windowed games the
// output resolution is the desktop resolution, which we can change and restore.

const TIERS = [
  { id: 'native', label: 'Native', scale: 1 },
  { id: 'balanced', label: 'Balanced', scale: 0.84 },
  { id: 'performance', label: 'Performance', scale: 0.67 },
];

function pickMode(modes, native, tierId) {
  const tier = TIERS.find(t => t.id === tierId) || TIERS[0];
  if (tier.scale === 1) return { ...native, tier: tier.id, pixelSaving: 0 };
  const aspect = native.width / native.height;
  const limit = native.height * tier.scale + 0.5;
  const same = modes.filter(m => Math.abs(m.width / m.height - aspect) < 0.02 && m.height <= limit && m.height < native.height);
  if (!same.length) return null;
  const bestH = Math.max(...same.map(m => m.height));
  const cands = same.filter(m => m.height === bestH);
  const hz = cands.find(m => m.hz === native.hz) || cands.reduce((a, b) => (b.hz > a.hz ? b : a));
  const pixelSaving = 1 - (hz.width * hz.height) / (native.width * native.height);
  return { width: hz.width, height: hz.height, hz: hz.hz, tier: tier.id, pixelSaving };
}

function ladder(modes, native) {
  return TIERS.map(t => ({ ...t, mode: pickMode(modes, native, t.id) }));
}

module.exports = { TIERS, pickMode, ladder };
