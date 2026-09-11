/* Refract overlay window. */
(function () {
  'use strict';
  const api = window.refract;
  const $ = s => document.querySelector(s);
  let ctx = null, settings = null;

  async function call(fn, ...a) {
    const r = await fn(...a);
    if (!r || !r.ok) throw new Error(r ? r.error : 'No response');
    return r.data;
  }

  function renderLook(id) {
    document.querySelectorAll('#look button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === id)));
    $('#lookHint').textContent = id && settings ? settings.lookHotkeys[id].replace(/\+/g, ' + ') : 'Tap to apply';
  }

  function renderContext() {
    const g = ctx && ctx.game;
    $('#gameName').textContent = g ? g.name : 'Refract';
    $('#procName').textContent = ctx && ctx.foreground ? ctx.foreground + '.exe in focus' : 'No game in focus';
    const key = g && g.cfg && g.cfg.neuralKey;
    $('#neural').disabled = !key;
    $('#neuralLabel').textContent = key ? 'Toggle neural rendering (' + key + ')' : 'No neural hotkey saved';
    Prism.set($('#tier'), (ctx && ctx.tier) || 'native');
    $('#modeRead').textContent = ctx && ctx.display ? ctx.display.width + ' x ' + ctx.display.height : '';
    renderLook(ctx && ctx.look);
  }

  const RINGS = [['power', 'Power', 'W'], ['load', 'Load', '%'], ['temp', 'Temp', '°C']];
  $('#rings').innerHTML = RINGS.map(([id, label]) => `<div class="rg" data-r="${id}"><div class="ring">
      <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="bg" cx="32" cy="32" r="26"/><circle class="fg" cx="32" cy="32" r="26"/></svg>
      <span class="val" data-v>-</span></div><small>${label}</small></div>`).join('');

  function renderTelemetry(t) {
    if (!t) return;
    const set = (id, text, frac, hot) => {
      const el = document.querySelector(`[data-r="${id}"]`);
      el.querySelector('[data-v]').textContent = text;
      Prism.ring(el.querySelector('.fg'), frac);
      el.classList.toggle('hot', !!hot);
    };
    set('power', t.powerDraw == null ? '-' : Math.round(t.powerDraw), t.powerLimit ? (t.powerDraw || 0) / t.powerLimit : 0, t.powerLimited);
    set('load', t.util == null ? '-' : Math.round(t.util), (t.util || 0) / 100);
    set('temp', t.temp == null ? '-' : Math.round(t.temp), (t.temp || 0) / 90, t.temp >= 83);
    $('#limitFlag').hidden = !t.powerLimited;
    $('#hud').classList.toggle('beam', !!t.powerLimited);
    $('#hud').classList.toggle('warn', !!t.powerLimited);
  }

  $('#look').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const prev = ctx && ctx.look;
    renderLook(b.dataset.v);
    try { await call(api.selectLook, b.dataset.v); if (ctx) ctx.look = b.dataset.v; }
    catch { renderLook(prev); }
  });

  Prism.seg($('#tier'), async v => {
    try {
      const m = await call(api.applyTier, v);
      if (ctx && ctx.game) await call(api.patchGame, ctx.game.id, { tier: v });
      $('#modeRead').textContent = m.width + ' x ' + m.height;
      if (ctx) ctx.tier = v;
    } catch { Prism.set($('#tier'), (ctx && ctx.tier) || 'native'); }
  });

  $('#neural').addEventListener('click', () => { if (ctx && ctx.game) call(api.toggleNeural, ctx.game.id).catch(() => {}); });
  $('#hide').addEventListener('click', () => call(api.hideOverlay).catch(() => {}));

  function renderKeys() {
    $('#keysHint').innerHTML = (settings.overlay.hotkey || '').split('+').map(k => `<kbd>${k.replace(/[<>&]/g, '')}</kbd>`).join(' ') + ' hides';
  }

  async function refresh() {
    try { ctx = await call(api.overlayContext); renderContext(); } catch {}
  }

  api.on('telemetry', renderTelemetry);
  api.on('look', d => { renderLook(d.look); refresh(); Prism.pop($('#hud')); });
  api.on('settings', s => { settings = s; renderKeys(); });

  (async function boot() {
    try {
      const s = await call(api.state);
      settings = s.settings;
      renderKeys(); renderTelemetry(s.telemetry); renderLook(s.currentLook);
      await refresh();
      api.ready({ ok: true });
    } catch (err) { api.ready({ ok: false, error: String(err && err.message || err) }); }
  })();
})();
