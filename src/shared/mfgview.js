/* The Multi Frame Generation panel, as one pure function of the status object, so the markup
   the user actually sees can be tested rather than eyeballed. Shared by the renderer (script
   tag) and the unit tests (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RefractMfgView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // m: the `mfg` block from feeder:status. gpuName: for the wording only.
  // Returns '' when there is nothing to say (no data at all).
  function render(m, gpuName) {
    if (!m) return '';
    const head = '<div class="row-h sub"><i class="ph ph-film-strip"></i>Multi Frame Generation</div>';

    // Not eligible is the normal answer on an RTX 50 (it has NVIDIA's own) and on DX11 games.
    // It reads as information with a reason, never a dead greyed-out control.
    if (!m.eligible) {
      return head + '<div class="d5-row sub"><div><span>' +
        esc(m.reason || 'Not available for this game.') + '</span></div></div>';
    }

    const on = !!(m.setting && m.setting.enabled);
    const mult = (m.setting && m.setting.multiplier) || 2;
    const p = m.preview || {};
    const choices = m.multipliers && m.multipliers.length ? m.multipliers : [2, 3, 4];
    const seg = '<div class="seg block mfg-seg" id="mfgSeg" role="group" aria-label="Frame generation multiplier">' +
      choices.map(x => `<button data-v="${x}" aria-pressed="${x === mult}">${x}X</button>`).join('') +
      '</div>';
    const cap = p.cap
      ? `Capped at ${p.cap} fps${p.realFps ? ` — the game itself renders about ${p.realFps} fps` : ''}.`
      : 'No frame cap yet: DIHLSS5 works one out from your display’s refresh rate.';

    if (!on) {
      return head +
        '<div class="d5-row"><div><b>Enable Multi Frame Generation</b><span>Up to ' + mult +
        'X frames on ' + esc(gpuName || 'this card') + ' using ' + esc(m.engine || 'the bundled engine') +
        '. It ships inside DIHLSS5 — nothing to download.' +
        (m.experimental ? ' <b>Experimental on RTX 20.</b>' : '') +
        '</span></div><button class="btn glassy sm" data-act="mfg-on"><i class="ph ph-film-strip"></i>Enable MFG</button></div>' +
        '<div class="d5-row sub"><div>' + seg + '<span class="mfg-note">' + esc(cap) + '</span></div></div>';
    }

    const live = !!m.installed;
    return head +
      '<div class="d5-row ' + (live ? 'ok' : 'warn') + '"><div><b>Multi Frame Generation ' +
      (live ? 'installed' : 'is on for this game') + ' — up to ' + mult + 'X</b><span>' +
      (live ? '' : 'Press Enable DLSS 5 or Repair above to write it into the game folder. ') +
      esc(p.ghosting || '') + '</span></div>' +
      '<button class="btn ghost sm" data-act="mfg-off">Turn off</button></div>' +
      '<div class="d5-row sub"><div>' + seg + '<span class="mfg-note">' + esc(cap) + '</span></div></div>' +
      '<div class="d5-row sub"><div><span>' + esc(p.latency || '') + '</span></div>' +
      '<button class="btn ghost sm" data-act="mfg-reflex">Reflex: ' +
      esc((m.setting && m.setting.reflex) || 'on') + '</button></div>' +
      '<div class="d5-row sub"><div><span>In the game’s own settings, turn <b>DLSS Frame Generation</b> on — ' +
      'DIHLSS5 makes it available, the game still has to ask for it.</span></div></div>';
  }

  return { render, esc };
});
