/* Prism Kit behaviours used by Refract (GL-08, GL-25, FX-44, FX-107, FX-61, MO-13, MO-22, MO-26,
   MO-27, MO-33, MO-55, MO-56, EL-11), adapted into one small module. */
(function () {
  'use strict';
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- GL-08 segmented control
  function segMove(seg) {
    const th = seg.querySelector('.th');
    const on = seg.querySelector('button[aria-pressed="true"]');
    if (!th) return;
    if (!on) { th.style.width = '0px'; return; }
    th.style.width = on.offsetWidth + 'px';
    th.style.transform = 'translateX(' + (on.offsetLeft - 4) + 'px)';
  }
  function seg(el, onChange) {
    el.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !el.contains(b) || b.disabled || b.getAttribute('aria-pressed') === 'true') return;
      set(el, b.dataset.v);
      if (onChange) onChange(b.dataset.v);
    });
    requestAnimationFrame(() => segMove(el));
    new ResizeObserver(() => segMove(el)).observe(el);
    return el;
  }
  function set(el, value) {
    el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === value)));
    segMove(el);
  }

  // ---- MO-27 sliding indicator for the dock
  function dock(el, onChange) {
    const ind = el.querySelector('.dock-ind');
    const move = () => {
      const on = el.querySelector('.dock-items [aria-current="page"]');
      if (on && ind) ind.style.transform = 'translateY(' + on.offsetTop + 'px)';
    };
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      el.querySelectorAll('.dock-items [data-view]').forEach(x => {
        if (x.dataset.view === b.dataset.view) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
      });
      move();
      onChange(b.dataset.view);
    });
    requestAnimationFrame(move);
    return { move };
  }

  // ---- GL-25 / FX-107 pointer spotlight + FX-44 tilt (delegated, one listener per container)
  function pointer(container, selector, { tilt = 0 } = {}) {
    container.addEventListener('pointermove', e => {
      const c = e.target.closest(selector);
      if (!c || !container.contains(c)) return;
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      c.style.setProperty('--mx', x + 'px');
      c.style.setProperty('--my', y + 'px');
      c.style.setProperty('--gx', (x / r.width) * 100 + '%');
      c.style.setProperty('--gy', (y / r.height) * 100 + '%');
      if (tilt && !reduce()) {
        c.style.setProperty('--ry', (((x / r.width) - 0.5) * tilt).toFixed(2) + 'deg');
        c.style.setProperty('--rx', ((0.5 - (y / r.height)) * tilt).toFixed(2) + 'deg');
      }
    });
    container.addEventListener('pointerout', e => {
      const c = e.target.closest(selector);
      if (c && !c.contains(e.relatedTarget)) { c.style.setProperty('--rx', '0deg'); c.style.setProperty('--ry', '0deg'); }
    });
  }

  // ---- FX-61 toggle
  function toggle(btn, onChange) {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(v));
      if (onChange) onChange(v);
    });
  }

  // ---- EL-11 slider fill
  function sliderFill(input) {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', p + '%');
  }

  // ---- MO-13 ring: set 0..1
  function ring(circle, frac) {
    const len = parseFloat(circle.getAttribute('data-len')) || 2 * Math.PI * parseFloat(circle.getAttribute('r'));
    circle.setAttribute('data-len', len);
    circle.style.strokeDasharray = String(len);
    circle.style.strokeDashoffset = String(len * (1 - Math.max(0, Math.min(1, frac))));
  }

  // ---- MO-55 odometer
  // Rolls only on meaningful changes; small jitter (live telemetry) snaps without motion.
  function odo(el, text, { roll = true } = {}) {
    const s = String(text);
    if (el.dataset.v === s) return;
    el.classList.toggle('instant', !roll);
    const prev = el.querySelectorAll('.dg, .sep');
    if (prev.length !== s.length) {
      el.innerHTML = s.split('').map(ch => /\d/.test(ch)
        ? '<span class="dg"><i>0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9</i></span>'
        : `<span class="sep">${ch === '-' ? '-' : ch}</span>`).join('');
    }
    const kids = el.children;
    s.split('').forEach((ch, i) => {
      if (/\d/.test(ch) && kids[i] && kids[i].firstChild) kids[i].firstChild.style.transform = `translateY(-${ch}em)`;
    });
    el.dataset.v = s;
    el.setAttribute('aria-label', s);
  }

  // ---- MO-33 check mark markup
  const CHECK = '<svg class="check" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20"/><path d="M13 22.5 19.5 29 32 16"/></svg>';

  // ---- GL-06 + MO-26 toast stack
  function toast(title, detail, kind) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast glass strong ' + (kind || 'ok');
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    const icon = kind === 'err' ? '<i class="ph ph-warning-circle"></i>' : CHECK;
    el.innerHTML = `<span class="ic">${icon}</span><div><b></b><small></small></div>`;
    el.querySelector('b').textContent = title;
    el.querySelector('small').textContent = detail || '';
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 420); }, kind === 'err' ? 7000 : 3800);
  }

  // ---- MO-56 elastic entrance (WAAPI)
  function pop(el, delay = 0) {
    if (!el || reduce() || !el.animate) return;
    el.animate([{ transform: 'scale(.9) translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 760, delay, easing: 'linear(0,.42 6%,1.02 16%,.94 24%,1.05 34%,.98 46%,1.01 60%,1)', fill: 'backwards' });
  }

  // ---- MO-22 view transitions
  function swap(fn) {
    if (document.startViewTransition && !reduce()) {
      // A newer swap (or a hidden window) aborts the running transition; that's expected,
      // so its promises must not surface as unhandled rejections.
      const t = document.startViewTransition(fn);
      const quiet = () => {};
      t.ready.catch(quiet); t.finished.catch(quiet); t.updateCallbackDone.catch(quiet);
      return t;
    }
    fn();
    return null;
  }

  window.Prism = { seg, set, segMove, dock, pointer, toggle, sliderFill, ring, odo, toast, pop, swap, CHECK };
})();
