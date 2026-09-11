/* Refract looks: one definition shared by the ReShade preset writer (main process)
   and the screenshot preview (renderer). The math in grade() mirrors shaders/Refract.fx. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RefractLooks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOOKS = [
    { id: 'default', index: 0, name: 'Default', key: 'F13',
      summary: 'The frame exactly as the game and DLSS 5 render it. The grade pass is skipped, so it costs nothing.',
      params: [] },
    { id: 'cinematic', index: 1, name: 'Cinematic', key: 'F14',
      summary: 'Filmic contrast, split toning and a soft vignette.',
      params: [
        { id: 'Cine_Contrast', label: 'Contrast curve', min: 0, max: 0.6, step: 0.01, value: 0.22 },
        { id: 'Cine_Saturation', label: 'Saturation', min: 0.7, max: 1.3, step: 0.01, value: 1.06 },
        { id: 'Cine_SplitTone', label: 'Split toning', min: 0, max: 1, step: 0.01, value: 0.35 },
        { id: 'Cine_Vignette', label: 'Vignette', min: 0, max: 0.6, step: 0.01, value: 0.28 },
        { id: 'Cine_Grain', label: 'Film grain', min: 0, max: 0.1, step: 0.005, value: 0.03 },
      ] },
    { id: 'natural', index: 2, name: 'Natural Lighting', key: 'F15',
      summary: 'Calms over-processed highlights and saturation for a more photographic balance.',
      params: [
        { id: 'Nat_Rolloff', label: 'Highlight rolloff', min: 0, max: 1, step: 0.01, value: 0.4 },
        { id: 'Nat_ShadowLift', label: 'Shadow lift', min: 0, max: 0.12, step: 0.005, value: 0.035 },
        { id: 'Nat_Saturation', label: 'Saturation', min: 0.6, max: 1.1, step: 0.01, value: 0.9 },
        { id: 'Nat_Contrast', label: 'Contrast', min: -0.3, max: 0.2, step: 0.01, value: -0.08 },
        { id: 'Nat_Warmth', label: 'Warmth', min: -1, max: 1, step: 0.05, value: 0 },
      ] },
  ];

  // Virtual-key codes the shader listens on. F13-F15 are absent from most keyboards,
  // so they never collide with game bindings; Refract sends them for you.
  const KEYCODES = { default: 0x7C, cinematic: 0x7D, natural: 0x7E };

  function defaults() {
    const v = {};
    for (const l of LOOKS) for (const p of l.params) v[p.id] = p.value;
    return v;
  }

  const clamp = x => (x < 0 ? 0 : x > 1 ? 1 : x);
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const scurve = x => x * x * (3 - 2 * x);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

  function cinematic(r, g, b, u, v, aspect, P) {
    let l = luma(r, g, b);
    r = l + (r - l) * P.Cine_Saturation; g = l + (g - l) * P.Cine_Saturation; b = l + (b - l) * P.Cine_Saturation;
    r = clamp(r); g = clamp(g); b = clamp(b);
    const k = P.Cine_Contrast;
    r += k * (scurve(r) - r); g += k * (scurve(g) - g); b += k * (scurve(b) - b);
    l = luma(r, g, b);
    const sh = (1 - l) * (1 - l), hi = l * l, s = P.Cine_SplitTone;
    r += s * (-0.04 * sh + 0.05 * hi); g += s * (0.02 * sh + 0.015 * hi); b += s * (0.05 * sh - 0.04 * hi);
    const dx = (u - 0.5) * aspect, dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(0.25 * aspect * aspect + 0.25);
    const vig = 1 - P.Cine_Vignette * smooth(0.45, 1.0, d);
    return [clamp(r * vig), clamp(g * vig), clamp(b * vig)];
  }

  function natural(r, g, b, P) {
    const lift = P.Nat_ShadowLift;
    r += lift * Math.pow(1 - r, 3); g += lift * Math.pow(1 - g, 3); b += lift * Math.pow(1 - b, 3);
    const l = luma(r, g, b);
    const l2 = l - P.Nat_Rolloff * 0.15 * l * l * l * l;
    const f = l > 1e-4 ? l2 / l : 1;
    r *= f; g *= f; b *= f;
    const l3 = luma(r, g, b);
    r = l3 + (r - l3) * P.Nat_Saturation; g = l3 + (g - l3) * P.Nat_Saturation; b = l3 + (b - l3) * P.Nat_Saturation;
    r = clamp(r); g = clamp(g); b = clamp(b);
    const k = P.Nat_Contrast;
    r += k * (scurve(r) - r); g += k * (scurve(g) - g); b += k * (scurve(b) - b);
    const w = P.Nat_Warmth * 0.06;
    return [clamp(r * (1 + w)), clamp(g), clamp(b * (1 - w))];
  }

  // Grade an ImageData in place (no grain in the still preview).
  function gradeImage(img, lookId, P) {
    if (lookId === 'default') return img;
    const d = img.data, W = img.width, H = img.height, aspect = W / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const o = lookId === 'cinematic' ? cinematic(r, g, b, (x + 0.5) / W, (y + 0.5) / H, aspect, P) : natural(r, g, b, P);
        d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255;
      }
    }
    return img;
  }

  return { LOOKS, KEYCODES, defaults, cinematic, natural, gradeImage };
});
