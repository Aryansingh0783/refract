/* Refract main window. */
(function () {
  'use strict';
  const api = window.refract;
  const { LOOKS, defaults, gradeImage } = window.RefractLooks;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TIER_LABEL = { native: 'Native', balanced: 'Balanced', performance: 'Performance' };
  const STORE_ICON = { steam: 'ph-steam-logo', epic: 'ph-storefront', gog: 'ph-storefront', ubisoft: 'ph-storefront', ea: 'ph-storefront', xbox: 'ph-game-controller', battlenet: 'ph-storefront', folder: 'ph-folder' };
  const STORE_NAME = { steam: 'Steam', epic: 'Epic', gog: 'GOG', ubisoft: 'Ubisoft', ea: 'EA', xbox: 'Xbox', battlenet: 'Battle.net', folder: 'Folder' };

  const state = {
    settings: null, gpu: null, games: [], selected: null, filter: 'dlss', q: '', scanning: false,
    telemetry: null, powerHist: [], ladder: null, tab: 'setup', view: 'library',
    look: 'cinematic', values: defaults(), transition: 0.6, session: null, hotkeys: null,
    neural: null, // NeuralScreen engine status (main: neuralInfo)
  };

  async function call(fn, ...args) {
    const r = await fn(...args);
    if (!r || !r.ok) { const msg = r ? r.error : 'No response'; Prism.toast('That did not work', msg, 'err'); throw new Error(msg); }
    return r.data;
  }
  const game = () => state.games.find(g => g.id === state.selected) || null;
  const mainDll = g => g && (g.dlls.find(d => /^nvngx_dlss\.dll$/i.test(d.file)) || g.dlls[0]);
  const shortVer = v => (v || '').split('.').slice(0, 3).join('.');
  const hueOf = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 38%)`; };

  // ================================================================ views
  const dock = Prism.dock($('.dock'), v => show(v));
  function show(view) {
    if (view === state.view) return;
    state.view = view;
    Prism.swap(() => {
      document.querySelectorAll('main .view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
      document.querySelectorAll('#view-' + view + ' .seg').forEach(Prism.segMove);
    });
    if (view === 'performance') loadLadder();
    if (view === 'looks') ensureImage();
    if (view === 'cards') renderCards();
  }
  $('#gpuOrb').addEventListener('click', () => {
    document.querySelectorAll('.dock-items [data-view]').forEach(x => x.toggleAttribute('aria-current', x.dataset.view === 'performance'));
    document.querySelector('.dock-items [data-view="performance"]').setAttribute('aria-current', 'page');
    dock.move(); show('performance');
  });

  // Ambient motion pauses when the window is not in front or a game is running (saves GPU for the game).
  window.addEventListener('blur', () => document.documentElement.classList.add('calm'));
  window.addEventListener('focus', () => document.documentElement.classList.remove('calm'));

  // ================================================================ backdrop
  let artFlip = false, artUrl = null;
  function setBackdrop(g) {
    const url = g && g.art ? (g.art.hero || g.art.header || g.art.capsule) : null;
    if (url === artUrl) return;
    artUrl = url;
    const a = $('#artA'), b = $('#artB');
    const next = artFlip ? a : b, prev = artFlip ? b : a;
    artFlip = !artFlip;
    if (!url) { a.classList.remove('on'); b.classList.remove('on'); return; }
    next.onload = () => { if (artUrl === url) { next.classList.add('on'); prev.classList.remove('on'); } };
    next.onerror = () => { next.classList.remove('on'); };
    next.src = url;
  }

  // ================================================================ library
  function visibleGames() {
    const q = state.q.trim().toLowerCase();
    return state.games.filter(g => (state.filter === 'all' || g.hasDlss) && (!q || g.name.toLowerCase().includes(q)));
  }

  function renderShelf() {
    const shelf = $('#shelf');
    const list = visibleGames();
    $('#shelfCount').textContent = state.games.length ? `${list.length} of ${state.games.length}` : '';
    if (state.scanning && !state.games.length) {
      shelf.innerHTML = Array.from({ length: 9 }, (_, i) => `<div class="skel rise" data-i="${i}"></div>`).join('');
      shelf.querySelectorAll('.rise').forEach(el => el.style.setProperty('--i', el.dataset.i));
      return;
    }
    if (!list.length) {
      shelf.innerHTML = `<div class="empty"><span class="ic"><i class="ph ph-game-controller"></i></span>
        <b>${state.games.length ? 'Nothing matches' : 'No games found yet'}</b>
        <p>${state.games.length ? 'Clear the search or switch to All games.' : 'Refract reads Steam, Epic, GOG, Ubisoft, Xbox and EA installs. Add a folder for anything installed elsewhere.'}</p></div>`;
      return;
    }
    shelf.innerHTML = list.map((g, i) => {
      const d = mainDll(g);
      const poster = g.art && g.art.capsule
        ? `<img src="${esc(g.art.capsule)}" alt="" loading="lazy" draggable="false">`
        : `<div class="noart" data-hue="${esc(hueOf(g.name))}"><b>${esc(g.name)}</b></div>`;
      const attention = g.dlss5 && g.dlss5.needsAttention
        ? `<span class="cap-flag" title="DLSS 5 is installed here but ${esc((g.dlss5.missing || []).join(', '))} is missing"><i class="ph ph-warning"></i>Needs repair</span>` : '';
      return `<button class="capsule tilt rise" role="option" data-id="${esc(g.id)}" aria-selected="${g.id === state.selected}" aria-label="${esc(g.name)}${g.dlss5 && g.dlss5.needsAttention ? ', needs repair' : ''}" data-i="${Math.min(i, 14)}">
        <span class="poster spot">${poster}<span class="glare"></span>${attention}</span>
        <span class="cap"><b>${esc(g.name)}</b><small>${d ? 'DLSS ' + esc(shortVer(d.version)) : esc(g.store)}</small></span></button>`;
    }).join('');
    shelf.querySelectorAll('.capsule').forEach(c => c.style.setProperty('--i', c.dataset.i));
    shelf.querySelectorAll('.noart').forEach(n => n.style.setProperty('--hue', n.dataset.hue));
    shelf.querySelectorAll('.poster img').forEach(img => img.addEventListener('error', () => {
      const c = img.closest('.capsule'); const g = state.games.find(x => x.id === c.dataset.id);
      img.replaceWith(Object.assign(document.createElement('div'), { className: 'noart', innerHTML: `<b>${esc(g.name)}</b>` }));
      c.querySelector('.noart').style.setProperty('--hue', hueOf(g.name));
    }));
  }

  function select(id) {
    if (id === state.selected) return;
    state.selected = id;
    $('#shelf').querySelectorAll('.capsule').forEach(c => c.setAttribute('aria-selected', String(c.dataset.id === id)));
    const c = $(`#shelf .capsule[data-id="${CSS.escape(id)}"]`);
    if (c) c.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    Prism.swap(renderHero);
    setBackdrop(game());
    if (state.view === 'looks') { srcKind = null; ensureImage(); }
  }

  $('#shelf').addEventListener('click', e => { const c = e.target.closest('.capsule'); if (c) select(c.dataset.id); });
  $('#shelf').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = visibleGames(); const i = list.findIndex(g => g.id === state.selected);
    const n = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    if (n) { select(n.id); $(`#shelf .capsule[data-id="${CSS.escape(n.id)}"]`).focus(); }
    e.preventDefault();
  });
  $('#shelf').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('#shelf').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  Prism.pointer($('#shelf'), '.capsule', { tilt: 14 });
  $('#q').addEventListener('input', e => { state.q = e.target.value; renderShelf(); });
  Prism.seg($('#libFilter'), v => { state.filter = v; renderShelf(); });
  $('#rescan').addEventListener('click', scan);
  $('#addFolder').addEventListener('click', async () => {
    const g = await call(api.addFolder).catch(() => null);
    if (!g) return;
    state.games = [g, ...state.games.filter(x => x.id !== g.id)];
    state.filter = 'all'; Prism.set($('#libFilter'), 'all');
    renderShelf(); state.selected = null; select(g.id);
  });

  async function scan() {
    state.scanning = true;
    $('#rescan').classList.add('spin');
    renderShelf();
    if (!state.games.length) $('#hero').innerHTML = heroSkeleton();
    try {
      state.games = await call(api.scan);
      const keep = state.games.some(g => g.id === state.selected);
      if (!keep) state.selected = null;
      if (!visibleGames().length && state.games.length) { state.filter = 'all'; Prism.set($('#libFilter'), 'all'); }
    } catch {}
    state.scanning = false;
    $('#rescan').classList.remove('spin');
    renderShelf();
    const first = state.selected || (visibleGames()[0] || {}).id;
    state.selected = null;
    if (first) select(first); else renderHero();
  }

  function heroSkeleton() {
    return '<div class="hero-left"><div class="skel sk-a"></div><div class="skel sk-b"></div></div><div class="skel"></div>';
  }

  function replaceGame(g) {
    const i = state.games.findIndex(x => x.id === g.id);
    if (i >= 0) state.games[i] = g; else state.games.unshift(g);
    renderShelf(); renderHero();
  }

  // ---------------------------------------------------------------- hero
  function renderHero() {
    const el = $('#hero');
    const g = game();
    if (!g) {
      el.innerHTML = state.scanning ? heroSkeleton() : `<div class="hero-left"><h1>Pick a game</h1>
        <p class="lede">Choose a game from the shelf to manage its DLSS files, looks and output resolution.</p></div>`;
      return;
    }
    const d = mainDll(g), lk = g.looks || {}, cfg = g.cfg || {};
    const tier = cfg.tier || 'native';
    const running = state.session && state.session.state !== 'ended' && state.session.game === g.name;
    const meta = [
      `<span class="pill"><i class="ph ${STORE_ICON[g.store] || 'ph-folder'}"></i>${esc(STORE_NAME[g.store] || g.store)}</span>`,
      g.modified && g.modified.length ? `<span class="pill acc"><i class="ph ph-wrench"></i>Refract: ${esc(g.modified.join(', '))}</span>` : '',
      d ? `<span class="pill mono acc">DLSS ${esc(shortVer(d.version))}</span>` : '<span class="pill">No DLSS runtime found</span>',
      lk.installed ? '<span class="pill ok"><i class="ph ph-aperture"></i>Looks ready</span>' : lk.reshade ? '<span class="pill"><i class="ph ph-aperture"></i>ReShade found</span>' : '',
      tier !== 'native' ? `<span class="pill"><i class="ph ph-monitor"></i>${TIER_LABEL[tier]} output</span>` : '',
    ].join('');
    const title = g.art && g.art.logo
      ? `<img class="logo" id="heroLogo" src="${esc(g.art.logo)}" alt="${esc(g.name)}" draggable="false">`
      : `<h1>${esc(g.name)}</h1>`;
    el.innerHTML = `
      <div class="hero-left">
        ${title}
        <div class="meta">${meta}</div>
        <div class="actions">
          <span class="${running ? 'beam' : ''}"><button class="liquid-btn" data-act="launch" ${running ? 'disabled' : ''}>
            <i class="ph-fill ${running ? 'ph-broadcast' : 'ph-play'}"></i><span>${running ? 'Running' : 'Play'}</span></button></span>
          ${running ? '<button class="btn ghost" data-act="end-session" title="Use this if the game is closed but Refract still says Running"><i class="ph ph-stop"></i>Mark as closed</button>' : ''}
          <button class="btn glassy" data-act="overlay" title="${esc(state.hotkeys && state.hotkeys.overlay ? 'In game: ' + state.hotkeys.overlay : 'Show the overlay')}"><i class="ph ph-picture-in-picture"></i>Overlay</button>
          ${g.modified && g.modified.length ? `<button class="btn ghost" data-act="restore-all" title="Undo everything Refract changed: ${esc(g.modified.join(', '))}"><i class="ph ph-arrow-counter-clockwise"></i><span>Restore original</span></button>` : ''}
          <button class="icon-btn" data-act="folder" aria-label="Open game folder" title="Open game folder"><i class="ph ph-folder-open"></i></button>
        </div>
      </div>
      <div class="hero-panel glass refract">
        <div class="seg block tabs" id="tabs" role="tablist" aria-label="Game settings"><span class="th"></span>
          <button data-v="setup" aria-pressed="${state.tab === 'setup'}">Setup</button>
          <button data-v="files" aria-pressed="${state.tab === 'files'}">DLSS files</button>
          <button data-v="resolution" aria-pressed="${state.tab === 'resolution'}">Resolution</button></div>
        <div class="tab-body" id="tabBody"></div>
      </div>`;
    const logo = $('#heroLogo');
    if (logo) logo.addEventListener('error', () => { logo.replaceWith(Object.assign(document.createElement('h1'), { textContent: g.name })); });
    Prism.seg($('#tabs'), v => { state.tab = v; renderTab(); });
    renderTab();
    Prism.pop($('.hero-left', el)); Prism.pop($('.hero-panel', el), 80);
  }

  function renderTab() {
    const g = game(); const body = $('#tabBody');
    if (!g || !body) return;
    const cfg = g.cfg || {}, lk = g.looks || {};
    let html = '';
    if (state.tab === 'setup') {
      let looks;
      if (!lk.installed) {
        looks = `<p class="note">${lk.reshade ? 'ReShade is already here.' : 'Refract installs ReShade for you'} and adds one light effect, backing up any existing config first.</p>
          <div class="actions"><button class="btn glassy sm" data-act="install"><i class="ph ph-download-simple"></i>${lk.reshade ? 'Install looks' : 'Install ReShade + looks'}</button></div>`;
      } else {
        const start = cfg.startLook || lk.startLook || 'default';
        looks = `<div class="seg block" id="startSeg" role="group" aria-label="Look at game start"><span class="th"></span>
            ${LOOKS.map(l => `<button data-v="${l.id}" aria-pressed="${start === l.id}">${esc(l.id === 'natural' ? 'Natural' : l.name)}</button>`).join('')}</div>
          <p class="note">Starts with this look. Switch live with the overlay or ${esc(state.settings.lookHotkeys.cinematic)} and friends.</p>
          <div class="actions"><button class="btn ghost sm" data-act="uninstall">Remove looks</button></div>`;
      }
      html = `
        <div class="rise"><div class="row-h"><i class="ph ph-sparkle"></i>DLSS 5</div></div>
        <div class="dlss5 rise" id="dlss5Block" data-i="1"><div class="skel d5-skel"></div></div>
        <div class="rise" data-i="1"><div class="row-h"><i class="ph ph-monitor"></i>Neural Screen</div></div>
        <div class="dlss5 rise" id="nsBlock" data-i="1"></div>
        <div class="rise" data-i="2"><div class="row-h"><i class="ph ph-aperture"></i>Looks</div></div>
        <div class="rise" data-i="3">${looks}</div>
        <div class="field rise" data-i="4"><label for="nkey">Neural rendering hotkey</label>
          <div class="glass-in"><i class="ph ph-keyboard"></i><input id="nkey" class="mono" value="${esc(cfg.neuralKey || '')}" placeholder="None" spellcheck="false"></div>
          <span class="help">The game's own DLSS 5 toggle key, if it has one (NBA 2K27 uses F9). The overlay sends it for you.</span></div>
        <div class="field rise" data-i="5"><label>Executable to watch</label>
          <div class="exe tile"><span>${esc(cfg.exe || g.exe || 'Not found')}</span><button class="btn ghost sm" data-act="exe">Change</button></div>
          <span class="help">Refract restores your resolution when this process exits.</span></div>`;
    } else if (state.tab === 'files') {
      html = g.dlls.length ? g.dlls.map((d, i) => `
        <div class="dll tile rise" data-i="${i}"><span class="f">${esc(d.file)}</span>
          <span class="d">${esc(d.version || 'unknown')}${d.description ? ' / ' + esc(d.description) : ''}</span>
          <span class="acts"><button class="btn glassy sm" data-act="swap" data-path="${esc(d.path)}">Replace</button>
          ${d.backup ? `<button class="btn ghost sm" data-act="restore" data-path="${esc(d.path)}">Restore</button>` : ''}</span></div>`).join('') +
          '<p class="note rise" data-i="6">Replace takes a DLL you supply from NVIDIA. The original is backed up once and Restore puts it back.</p>'
        : '<div class="empty"><span class="ic"><i class="ph ph-cpu"></i></span><b>No DLSS runtime here</b><p>Refract searched this folder ten levels deep.</p></div>';
    } else {
      const tier = cfg.tier || 'native';
      html = `
        <div class="rise"><div class="row-h"><i class="ph ph-monitor"></i>Output resolution while playing</div></div>
        <div class="seg block rise" data-i="1" id="tierSeg" role="group" aria-label="Output resolution"><span class="th"></span>
          ${['native', 'balanced', 'performance'].map(t => `<button data-v="${t}" aria-pressed="${tier === t}">${TIER_LABEL[t]}</button>`).join('')}</div>
        <span class="tier-read rise" data-i="2" id="tierRead"></span>
        <p class="note rise" data-i="3">DLSS 5 cost follows output resolution, not the DLSS quality mode. Play applies this tier and restores native when the game closes.</p>
        <div class="actions rise" data-i="4"><button class="btn glassy sm" data-act="try-tier"><i class="ph ph-lightning"></i>Apply now</button>
          <button class="btn ghost sm" data-act="restore-native">Restore native</button></div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('.rise[data-i]').forEach(el => el.style.setProperty('--i', el.dataset.i));

    const ss = $('#startSeg', body);
    if (ss) Prism.seg(ss, async v => { const ng = await call(api.patchGame, g.id, { startLook: v }).catch(() => null); if (ng) Object.assign(g, ng); });
    const ts = $('#tierSeg', body);
    if (ts) { Prism.seg(ts, async v => { const ng = await call(api.patchGame, g.id, { tier: v }).catch(() => null); if (ng) { Object.assign(g, ng); tierRead(v); } }); tierRead(g.cfg.tier || 'native'); }
    const nk = $('#nkey', body);
    if (nk) nk.addEventListener('change', async () => {
      const ng = await call(api.patchGame, g.id, { neuralKey: nk.value.trim() || null }).catch(() => null);
      if (ng) { Object.assign(g, ng); Prism.toast('Hotkey saved', ng.cfg.neuralKey ? 'The overlay toggle sends ' + ng.cfg.neuralKey + '.' : 'Cleared.'); }
      else nk.value = g.cfg.neuralKey || '';
    });
    if (state.tab === 'setup') { renderDlss5(g); renderNeural(g); }
  }

  // DLSS 5 block: upgrade native runtime, or add DLSS 5 (RenoDX) to a game without DLSS.
  // What to do in the game once DLSS 5 is installed. Most "it looks the same" reports come
  // from a step here being skipped, so it is spelled out every time.
  function nextSteps() {
    const ok = state.hotkeys && state.hotkeys.overlay;
    return `<ol class="d5-steps">
      <li>Start the game and set <b>Display mode: Borderless</b> (or windowed).</li>
      <li>Graphics settings: turn <b>DLSS Super Resolution or DLAA on</b>. DLSS 5 runs on top of it; with FSR/XeSS or DLSS off it stays idle.</li>
      <li>Press <kbd>Home</kbd> for ReShade &rarr; <b>Add-ons</b> &rarr; the RenoDX tab to tune it. <b>F6</b> toggles it, <b>F5</b> shows an A/B split.</li>
      <li>${ok ? `<kbd>${esc(state.hotkeys.overlay).replace(/\+/g, '</kbd>+<kbd>')}</kbd> opens the Refract overlay.` : 'The Refract overlay needs a free hotkey (Settings).'}</li>
      <li>Neural rendering needs extra video and system memory. If the game crashes with <b>out of memory</b>, close browsers and other heavy apps, and lower Path Tracing / Frame Generation first.</li></ol>`;
  }

  async function renderDlss5(g) {
    const el = $('#dlss5Block');
    if (!el) return;
    let fs;
    try { fs = await api.feederStatus(g.id); if (!fs.ok) throw 0; fs = fs.data; } catch { fs = null; }
    if (!el.isConnected || game() !== g) return;
    let html = '';
    const progress = `<div class="d5-prog" id="d5Prog" hidden><div class="d5-bar"><i id="d5Bar"></i></div><span id="d5ProgTxt"></span></div>`;
    if (fs && fs.installed && fs.eligible) {
      // Installed by an earlier version, but something it needs is missing (typically the
      // neural-rendering runtime) — offer a one-click repair instead of a dead "active" badge.
      html = `<div class="d5-row warn"><div><b>DLSS 5 needs a repair</b><span>${esc(fs.reason || 'Some DLSS 5 files are missing or out of date for this GPU.')}</span></div>
        <button class="btn glassy sm" data-act="feeder-install"><i class="ph ph-wrench"></i>Repair</button></div>${progress}`;
    } else if (fs && fs.installed && fs.verify && !fs.verify.ok) {
      // Installed, but the folder does not contain what DLSS 5 needs — the RTX 3060 case.
      html = `<div class="d5-row warn"><div><b>DLSS 5 will not run yet</b><span>${esc(fs.verify.summary)}</span></div>
        <button class="btn glassy sm" data-act="feeder-install"><i class="ph ph-wrench"></i>Fix this</button></div>${progress}${checklist(fs.verify)}`;
    } else if (fs && fs.installed) {
      html = `<div class="d5-row ok"><div><b>DLSS 5 installed</b><span>${esc(fs.routeLabel || 'RenoDX DLSS 5 + ReShade')}. Everything Refract added can be removed with Restore original.</span></div></div>` + checklist(fs.verify) + nextSteps();
    } else if (fs && fs.already && fs.blocked) {
      html = `<div class="d5-row warn"><div><b>DLSS 5 will not run yet</b><span>${esc(fs.reason)}</span></div>
        ${fs.blocked === 'off' ? '<button class="btn glassy sm" data-act="unlock-on"><i class="ph ph-power"></i>Turn it on</button>' : '<button class="btn glassy sm" data-act="feeder-install"><i class="ph ph-wrench"></i>Fix this</button>'}</div>${progress}`;
    } else if (fs && fs.already) {
      html = `<div class="d5-row ok"><div><b>DLSS 5 already set up</b><span>${esc(fs.reason)}</span></div></div>` + nextSteps();
    } else if (fs && fs.eligible) {
      html = `<div class="d5-row"><div><b>${fs.route === 'feeder' ? 'Add DLSS 5' : 'Upgrade to DLSS 5'}</b><span>${esc(fs.routeLabel || '')}. Everything ships inside Refract; your game's own files are backed up, never overwritten.</span></div>
        <button class="btn glassy sm" data-act="feeder-install"><i class="ph ph-sparkle"></i>Enable DLSS 5</button></div>${progress}`;
    } else {
      html = `<div class="d5-row"><div><b>DLSS 5 can't go into this game</b><span>${esc((fs && fs.reason) || 'Not available for this game.')}${state.neural && state.neural.available ? ' Neural Screen below can still process it from the screen.' : ''}</span></div></div>`;
    }
    // Competing DLSS add-ons in one folder is the classic "it's listed but does nothing" trap.
    if (fs && fs.warnings && fs.warnings.length && !fs.already) {
      html += `<div class="d5-row warn"><div><b>Heads up</b><span>${esc(fs.warnings[0])}</span></div></div>`;
    }
    // GPU line: what Refract does for this card, and the override.
    if (fs && (fs.gpuSupport === 'patch' || fs.gpuSupport === 'native')) {
      const u = fs.unlock || {};
      const own = u.source === 'own' && u.runtime;
      const card = esc(fs.gpuName || 'your GPU');
      const text = fs.gpuSupport === 'native'
        ? `${card}: DLSS 5 neural rendering is supported natively.`
        : u.enabled === false
          ? `${card}: the universal neural-rendering runtime is switched off, so DLSS 5 stays off on this card.`
          : `${card}: Refract installs the universal RTX 30/40/50 neural-rendering runtime${own ? ' (your own file)' : ''} so DLSS 5 runs here. Expect a bigger frame-rate cost than on RTX 50.`;
      html += `<div class="d5-row sub"><div><span>${text}</span></div>${fs.gpuSupport === 'patch'
        ? `<button class="btn ghost sm" data-act="${u.enabled === false ? 'unlock-on' : 'pick-patched'}">${u.enabled === false ? 'Turn on' : own ? 'Change file' : 'Use my own file'}</button>` : ''}</div>`;
    }
    // The game's own DLSS runtime: the add-on's neural pass depends on it.
    if (fs && fs.dlssSr && (fs.dlssSr.theirs || fs.dlssSr.upgrade)) {
      const sr = fs.dlssSr;
      html += `<div class="d5-row sub"><div><span>Game's DLSS runtime: <b>${esc(sr.theirs || 'unknown')}</b>${
        sr.upgrade ? ` — Refract can upgrade it to <b>${esc(sr.ours)}</b>, which is what the neural pass expects.` : `. ${esc(sr.why || '')}`}</span></div>${
        sr.upgrade ? '<button class="btn ghost sm" data-act="feeder-install">Upgrade</button>' : ''}</div>`;
    }
    html += lastRunRow(fs && fs.log);
    el.innerHTML = html;
  }

  // What the game's own ReShade log said the last time it ran. This is the only honest source
  // for "is neural rendering actually on", so it gets its own row with the log line and a fix.
  function lastRunRow(log) {
    if (!log || log.verdict === 'reshade-missing') return '';
    const cls = log.level === 'ok' ? 'ok' : log.level === 'bad' ? 'warn' : 'sub';
    const act = {
      repair: '<button class="btn glassy sm" data-act="feeder-install"><i class="ph ph-wrench"></i>Repair</button>',
      'upgrade-dlss': '',
      diagnostics: '<button class="btn ghost sm" data-act="diagnostics"><i class="ph ph-export"></i>Export diagnostics</button>',
      'neural-screen': '',
    }[log.action] || '<button class="btn ghost sm" data-act="diagnostics"><i class="ph ph-export"></i>Export diagnostics</button>';
    return `<div class="d5-row ${cls}"><div><b>Last run: ${esc(verdictTitle(log.verdict))}</b><span>${esc(log.text || '')}${
      log.evaluations ? ` (${log.evaluations} evaluations)` : ''}</span>${log.line ? `<code class="d5-log">${esc(log.line.slice(0, 220))}</code>` : ''}</div>${act}</div>`;
  }
  const VERDICT_TITLE = { evaluating: 'neural rendering ran', idle: 'nothing evaluated', 'runtime-missing': 'the runtime was missing',
    'arch-refused': 'this GPU was refused', 'host-state': 'the pass was skipped', 'addon-error': 'the add-on failed',
    'limited-reshade': 'ReShade has no add-on support', 'addon-missing': 'the add-on did not load', 'no-dlss': 'DLSS was off in the game', unknown: 'unclear' };
  const verdictTitle = v => VERDICT_TITLE[v] || v;

  // The per-item result of Refract's own check of the game folder.
  function checklist(v) {
    if (!v || !v.checks) return '';
    const rows = v.checks.map(c => `<li class="${c.ok ? 'ok' : 'bad'}"><i class="ph ${c.ok ? 'ph-check' : 'ph-x'}"></i><b>${esc(c.label)}</b>${c.detail ? `<span>${esc(c.detail)}</span>` : ''}</li>`).join('');
    return `<details class="d5-verify"${v.ok ? '' : ' open'}><summary>${v.ok ? 'Everything checks out' : 'What is missing'}</summary><ul>${rows}</ul></details>`;
  }

  // ================================================================ cards view
  // One tab per GeForce generation: what Refract does for it, what has actually been proven on
  // hardware, and the one action that matters for the card in this machine.
  const SERIES = {
    50: {
      name: 'RTX 50 · Blackwell', tier: 'native',
      status: 'Supported by NVIDIA', level: 'ok',
      verified: 'Verified here: Cyberpunk 2077 on an RTX 5070, driver 616.92 — the game log shows the neural pass evaluating every frame.',
      how: [
        'DLSS 5 neural rendering is enabled for this generation, so nothing has to be unlocked.',
        'Refract installs the ReShade add-on build, the RenoDX DLSS 5 add-on and a tuned config next to the game.',
        'A neural-rendering runtime the game already has is kept; a missing one is added.',
        'Hook mode 2: the add-on hooks NGX only and leaves the game\'s Streamline modules alone.',
      ],
      watch: ['Neural rendering is heavy. If a game crashes with out of memory, close browsers and lower Path Tracing or Frame Generation first.'],
    },
    40: {
      name: 'RTX 40 · Ada Lovelace', tier: 'patch',
      status: 'Community path', level: 'warn',
      verified: 'Not verified on hardware yet. A first RTX 4050 laptop test failed with "host state incomplete" — the fixes below target exactly that.',
      how: [
        'The bundled universal runtime carries Ada (sm_89) kernels and its architecture gate accepts Ada, so the neural pass can run.',
        'The game\'s own DLSS runtime is upgraded to 310.8 when it ships something older — an old DLSS is what leaves the add-on with an incomplete host state.',
        'Hook mode 1: the add-on also patches the game\'s Streamline modules, which is what the 1-Click reference ships for pre-Blackwell cards.',
        'The game is pointed at the discrete GPU, so a laptop cannot quietly run it on the iGPU.',
      ],
      watch: [
        'Laptop cards have less VRAM: 6 GB on a 4050. Neural rendering may not fit alongside path tracing.',
        'Frame rates drop much further than on RTX 50.',
      ],
    },
    30: {
      name: 'RTX 30 · Ampere', tier: 'patch',
      status: 'Community path', level: 'warn',
      verified: 'Not verified on hardware yet. On an RTX 3060 the game log said the runtime was never in the folder — Refract now checks that after every install and offers a repair.',
      how: [
        'The bundled universal runtime carries Ampere (sm_86) kernels and accepts Ampere. Refract 0.2 shipped an Ada-only build that refused this generation; games set up then show a Repair.',
        'The game\'s own DLSS runtime is upgraded to 310.8 when it is older.',
        'Hook mode 1, as on RTX 40.',
        'The game is pointed at the discrete GPU.',
      ],
      watch: [
        'Antivirus: a modified NVIDIA runtime is the kind of file real-time protection quarantines seconds after it is written. If DLSS 5 vanishes, add the game folder as an exclusion and repair.',
        'This is the heaviest generation to run neural rendering on. Neural Screen\'s reduced-resolution mode is often the better trade.',
      ],
    },
    20: {
      name: 'RTX 20 · Turing', tier: 'unsupported',
      status: 'Cannot run DLSS 5', level: 'bad',
      verified: 'Settled by the runtime itself: every build refuses the Turing architecture (0x160), so there is nothing to install.',
      how: ['Refract reports this card as unsupported instead of installing something that stays off.'],
      watch: ['Neural Screen cannot help either — the same runtime refuses Turing.'],
    },
  };

  function myseries() { return (state.gpu && state.gpu.series) || null; }

  // Jump to a game's Setup tab from anywhere, moving the dock with us.
  function gotoLibrary(id) {
    const b = document.querySelector('.dock-items [data-view="library"]');
    if (b) b.click(); else show('library');
    state.tab = 'setup';
    if (id && id !== state.selected) select(id); else renderHero();
  }

  function renderCards() {
    const el = $('#cardBody');
    if (!el) return;
    const pick = state.cardTab || myseries() || 50;
    const s = SERIES[pick] || SERIES[50];
    const mine = myseries() === pick;
    const games = state.games.filter(g => g.dlss5);
    const installed = games.filter(g => g.dlss5.installed);
    const attention = installed.filter(g => g.dlss5.needsAttention);
    const lead = $('#cardsLead');
    if (lead) lead.textContent = state.gpu && state.gpu.name
      ? `${state.gpu.name}${state.gpu.driver ? ' · driver ' + state.gpu.driver : ''} — pick a generation to see exactly what Refract does for it.`
      : 'What Refract does for each GeForce generation, and what it can prove.';
    el.innerHTML = `
      <div class="card-head ${s.level}">
        <div><b>${esc(s.name)}</b><span>${esc(s.status)}${mine ? ' · this is your card' : ''}</span></div>
        ${mine && s.tier !== 'unsupported' ? `<button class="btn glassy sm" data-card="apply"><i class="ph ph-lightning"></i>Set up a game</button>` : ''}
      </div>
      <p class="card-verified">${esc(s.verified)}</p>
      <div class="card-h"><h3>What Refract does</h3></div>
      <ul class="card-list">${s.how.map(h => `<li><i class="ph ph-check"></i><span>${h}</span></li>`).join('')}</ul>
      <div class="card-h"><h3>Worth knowing</h3></div>
      <ul class="card-list warn">${s.watch.map(h => `<li><i class="ph ph-warning"></i><span>${h}</span></li>`).join('')}</ul>
      ${mine ? `
      <div class="card-h"><h3>On this machine</h3></div>
      <dl class="kv">
        <dt>Card</dt><dd>${esc(state.gpu.name || 'unknown')}</dd>
        <dt>Driver</dt><dd>${esc(state.gpu.driver || 'unknown')}${state.gpu.driverStatus === 'older' ? ' (older than the build this was tested on)' : ''}</dd>
        <dt>DLSS 5</dt><dd>${s.tier === 'native' ? 'supported as shipped' : s.tier === 'patch' ? 'through the universal runtime' : 'not possible'}</dd>
        <dt>Games set up</dt><dd>${installed.length}${attention.length ? ` · ${attention.length} need a repair` : ''}</dd>
      </dl>
      ${attention.length ? `<div class="card-fix"><span>${attention.map(g => esc(g.name)).join(', ')} ${attention.length > 1 ? 'are' : 'is'} missing something DLSS 5 needs.</span>
        <button class="btn glassy sm" data-card="fix"><i class="ph ph-wrench"></i>Open the first one</button></div>` : ''}
      ${s.tier === 'patch' ? `<label class="ns-check"><input type="checkbox" id="cardSr" ${state.settings && state.settings.dlss5UpgradeSr !== false ? 'checked' : ''}> Upgrade a game's own DLSS runtime when Refract's is newer (recommended on this card)</label>` : ''}
      ` : ''}`;
    const apply = el.querySelector('[data-card="apply"]');
    if (apply) apply.addEventListener('click', () => {
      const target = attention[0] || games.find(g => !g.dlss5.installed) || state.games[0];
      if (target) { gotoLibrary(target.id); }
    });
    const fix = el.querySelector('[data-card="fix"]');
    if (fix) fix.addEventListener('click', () => gotoLibrary(attention[0].id));
    const sr = $('#cardSr', el);
    if (sr) sr.addEventListener('change', async () => {
      const r = await call(api.patchSettings, { dlss5UpgradeSr: sr.checked }).catch(() => null);
      if (r) state.settings = r.settings; else sr.checked = !sr.checked;
    });
  }

  // Neural Screen: the bundled NeuralScreen engine. It processes the screen, not the game, so
  // it covers games the in-game route can't take and changes nothing in the game folder.
  async function loadNeural() {
    try { const r = await api.neuralStatus(); if (r && r.ok) state.neural = r.data; } catch {}
    return state.neural;
  }
  function neuralLine(n) {
    const st = n.state || {};
    if (!st.running) return '';
    const parts = [st.game ? 'Running for ' + esc(st.game) : 'Running'];
    if (st.nr === 'failed') parts.push('<b>neural rendering could not start on this GPU</b>');
    else if (st.fps) parts.push(st.fps.toFixed(0) + ' FPS', st.nr === 'off' ? 'NR paused (Num1)' : 'NR on');
    else parts.push('warming up');
    return `<div class="d5-row sub ns-live"><div><span><i class="ph ph-circle ns-dot${st.nr === 'failed' ? ' bad' : ''}"></i>${parts.join(' · ')}</span></div></div>`;
  }
  async function renderNeural(g) {
    const el = $('#nsBlock');
    if (!el) return;
    const n = state.neural || await loadNeural();
    if (!el.isConnected || game() !== g) return;
    if (!n) { el.innerHTML = ''; return; }
    if (!n.available) { el.innerHTML = `<div class="d5-row sub"><div><span>${esc(n.reason || 'Not available.')}</span></div></div>`; return; }
    const st = n.state || {};
    const auto = (g.cfg && g.cfg.engine) === 'screen';
    const both = g.modified && g.modified.includes('DLSS 5');
    const ns = n.settings || {};
    el.innerHTML = `
      <div class="d5-row"><div><b>Screen-space DLSS 5</b><span>NeuralScreen ${esc(n.version || '')} runs NVIDIA's neural renderer on what is on screen instead of inside the game, so it also works on Vulkan, 32-bit and no-DLSS games. Nothing in the game folder changes.</span></div>
        <button class="btn glassy sm" data-ns="${st.running ? 'stop' : 'start'}"><i class="ph ${st.running ? 'ph-stop' : 'ph-play'}"></i>${st.running ? 'Stop' : 'Start now'}</button></div>
      ${neuralLine(n)}
      <label class="ns-check"><input type="checkbox" id="nsAuto" ${auto ? 'checked' : ''}> Start it automatically when I play this game, stop it when I quit</label>
      <div class="seg block" id="nsProfile" role="group" aria-label="Neural Screen strength"><span class="th"></span>
        ${n.profiles.map(p => `<button data-v="${esc(p)}" aria-pressed="${ns.profile === p}">${esc(p.split(' / ')[0])}</button>`).join('')}</div>
      <label class="ns-check"><input type="checkbox" id="nsFaster" ${ns.faster ? 'checked' : ''}> Faster: run the network at reduced resolution (about 50% more FPS, edges stay sharp)</label>
      ${both ? '<div class="d5-row warn"><div><b>Pick one</b><span>DLSS 5 is also installed in this game. Running both applies neural rendering twice; use Restore original or leave Neural Screen off here.</span></div></div>' : ''}
      <ol class="d5-steps">
        <li>Set the game to <b>Borderless</b> or windowed. Nothing can draw over exclusive fullscreen.</li>
        <li><b>Num Lock on</b>: <kbd>Num2</kbd> menu, <kbd>Num1</kbd> neural rendering on/off, <kbd>Num5</kbd> only the window under the cursor, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Q</kbd> quits.</li>
        <li>HDR displays aren't supported: switch to SDR (<kbd>Win</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>). Adds about 40–60 ms of latency.</li>
        <li>Not for online games with anti-cheat: a screen overlay plus an <code>nvngx.dll</code> process is what they look for.</li></ol>`;
    const ap = $('#nsAuto', el);
    ap.addEventListener('change', async () => {
      const ng = await call(api.patchGame, g.id, { engine: ap.checked ? 'screen' : 'ingame' }).catch(() => null);
      if (ng) { Object.assign(g, ng); Prism.toast(ap.checked ? 'Neural Screen on for ' + g.name : 'Neural Screen off for ' + g.name, ap.checked ? 'It starts when the game window appears and stops when you quit.' : ''); }
      else ap.checked = !ap.checked;
    });
    Prism.seg($('#nsProfile', el), async v => { const r = await call(api.patchSettings, { neuralScreen: { profile: v } }).catch(() => null); if (r) { state.settings = r.settings; state.neural.settings = r.settings.neuralScreen; } });
    const fa = $('#nsFaster', el);
    fa.addEventListener('change', async () => { const r = await call(api.patchSettings, { neuralScreen: { faster: fa.checked } }).catch(() => null); if (r) { state.settings = r.settings; state.neural.settings = r.settings.neuralScreen; } });
    el.querySelector('[data-ns]').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try {
        if (b.dataset.ns === 'start') {
          Prism.toast('Starting Neural Screen', 'The first start copies the engine (a few seconds). Settings apply on the next start.');
          state.neural = await call(api.neuralStart, g.id);
        } else state.neural = await call(api.neuralStop);
      } catch {} finally { renderNeural(g); }
    });
  }
  api.on('neuralscreen', async ev => {
    if (ev && ev.state === 'preparing') return;
    await loadNeural();
    if (ev && ev.state === 'stopped' && ev.reason === 'already-running') Prism.toast('NeuralScreen is already running', 'Close the other copy (Ctrl+Alt+Q) and start it again.', 'err');
    else if (ev && ev.state === 'error') Prism.toast('Neural Screen did not start', ev.error, 'err');
    const g = game(); if (g && state.tab === 'setup') renderNeural(g);
  });
  // FPS/status refresh while it runs and the Setup tab is showing.
  setInterval(async () => {
    if (!state.neural || !state.neural.state || !state.neural.state.running || state.tab !== 'setup' || document.hidden) return;
    await loadNeural();
    const el = $('#nsBlock .ns-live'), n = state.neural;
    if (el && n) { const html = neuralLine(n); if (html) el.outerHTML = html; else { const g = game(); if (g) renderNeural(g); } }
  }, 3000);

  // Live download/install progress for the DLSS 5 route.
  api.on('dlss5:progress', p => {
    const wrap = $('#d5Prog'); if (!wrap) return;
    wrap.hidden = false;
    const bar = $('#d5Bar'), txt = $('#d5ProgTxt');
    const pct = p.frac != null ? Math.round(p.frac * 100) : null;
    if (bar) bar.style.width = (pct != null ? pct : Math.round((p.phase - 1) / p.of * 100)) + '%';
    if (txt) txt.textContent = `${p.label} (${p.phase}/${p.of})${pct != null ? ' ' + pct + '%' : ''}`;
  });

  async function tierRead(tier) {
    if (!state.ladder) await loadLadder(true);
    const el = $('#tierRead'); if (!el) return;
    const r = state.ladder && state.ladder.ladder.find(x => x.id === tier);
    el.textContent = !r ? '' : r.mode
      ? `${r.mode.width} x ${r.mode.height} at ${r.mode.hz} Hz${r.mode.pixelSaving ? ', ' + Math.round(r.mode.pixelSaving * 100) + '% fewer pixels' : ''}`
      : 'Your display has no lower mode with this aspect ratio.';
  }

  $('#hero').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const g = game(); if (!g) return;
    const act = b.dataset.act;
    try {
      if (act === 'launch') { b.disabled = true; await call(api.launch, g.id); Prism.toast('Starting ' + g.name, 'Press ' + state.settings.overlay.hotkey + ' in game for the overlay.'); }
      else if (act === 'overlay') await call(api.toggleOverlay);
      else if (act === 'folder') await call(api.openFolder, g.id);
      else if (act === 'reshade-site') await call(api.openExternal, 'https://reshade.me/');
      else if (act === 'go-files') { state.tab = 'files'; Prism.set($('#tabs'), 'files'); renderTab(); }
      else if (act === 'feeder-install') {
        b.disabled = true;
        const prog = $('#d5Prog'); if (prog) prog.hidden = false;
        Prism.toast('Enabling DLSS 5', 'Installing into ' + g.name + '. Your game\'s own files are backed up, never overwritten.');
        const ng = await call(api.feederInstall, g.id);
        replaceGame(ng);
        const v = ng.install && ng.install.verify;
        const av = ng.install && ng.install.antivirus;
        if (av) Prism.toast('Something removed the runtime', av, 'err');
        else if (v && !v.ok) Prism.toast('DLSS 5 is not complete', v.summary + ' Open the game card for the full list.', 'err');
        else Prism.toast('DLSS 5 ready', 'In the game: Borderless, DLSS on, then Home → Add-ons to tune it.');
      }
      else if (act === 'feeder-remove') { replaceGame(await call(api.feederRestore, g.id)); Prism.toast('DLSS 5 removed', 'The game folder is back to how it was.'); }
      else if (act === 'restore-all') {
        // Two clicks: the first arms it, so a stray click can't wipe a setup.
        if (!b.dataset.armed) {
          b.dataset.armed = '1'; b.classList.add('armed');
          b.querySelector('span').textContent = 'Click again to restore';
          setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.classList.remove('armed'); b.querySelector('span').textContent = 'Restore original'; } }, 4000);
          return;
        }
        b.disabled = true;
        const ng = await call(api.restoreAll, g.id);
        replaceGame(ng);
        Prism.toast('Back to original', ng.restored && ng.restored.length ? 'Removed: ' + ng.restored.join(', ') + '.' : 'Nothing left to undo.');
      }
      else if (act === 'end-session') { await call(api.endSession); }
      else if (act === 'diagnostics') {
        b.disabled = true;
        const r = await call(api.exportDiagnostics, g.id).catch(() => null);
        if (r) Prism.toast('Diagnostics saved', 'Send this zip on: it has the game\'s ReShade log, what Refract installed and your GPU details. Your user name and paths are removed.');
        b.disabled = false;
      }
      else if (act === 'pick-patched') {
        const r = await call(api.pickPatchedRuntime);
        if (r && r.runtime) { Prism.toast('Patched runtime set', 'Refract will use your file instead of downloading one.'); renderDlss5(g); }
      }
      else if (act === 'unlock-on') {
        await call(api.patchSettings, { dlss5Unlock: true, dlss5UnlockSource: 'auto' });
        Prism.toast('Universal runtime on', 'Click Enable DLSS 5 (or Repair) to put it in this game.');
        renderDlss5(g);
      }
      else if (act === 'unlock-off') { await call(api.patchSettings, { dlss5Unlock: false }); renderDlss5(g); }
      else if (act === 'install') {
        b.disabled = true; Prism.toast('Installing looks', 'Setting up ReShade for ' + g.name + '.');
        const ng = await call(api.installLooks, g.id); replaceGame(ng);
        Prism.toast('Looks installed', 'In game: ' + state.settings.lookHotkeys.cinematic + ' for Cinematic.');
      }
      else if (act === 'uninstall') { replaceGame(await call(api.removeLooks, g.id)); Prism.toast('Looks removed', 'Your ReShade preset is back to its own effects.'); }
      else if (act === 'exe') replaceGame(await call(api.pickExe, g.id));
      else if (act === 'swap') replaceGame(await call(api.swapDll, g.id, b.dataset.path));
      else if (act === 'restore') { replaceGame(await call(api.restoreDll, g.id, b.dataset.path)); Prism.toast('Original restored'); }
      else if (act === 'try-tier') { const m = await call(api.applyTier, g.cfg.tier || 'native'); Prism.toast('Output resolution set', `${m.width} x ${m.height}. Restore native when you are done.`); loadLadder(true); }
      else if (act === 'restore-native') { await call(api.restoreDisplay); Prism.toast('Native resolution restored'); loadLadder(true); }
    } catch { if (act === 'launch') b.disabled = false; }
  });

  // ================================================================ performance
  const GAUGES = [
    { id: 'power', label: 'Board power', unit: 'W' },
    { id: 'load', label: 'GPU load', unit: '%' },
    { id: 'temp', label: 'Temperature', unit: '°C' },
    { id: 'vram', label: 'VRAM', unit: 'GB' },
  ];
  $('#gauges').innerHTML = GAUGES.map((g, i) => `
    <div class="gauge tile rise" data-g="${g.id}">
      <div class="ring"><svg viewBox="0 0 96 96" aria-hidden="true"><circle class="bg" cx="48" cy="48" r="38"/><circle class="fg" cx="48" cy="48" r="38"/></svg>
        <span class="val" data-pct>-</span></div>
      <div><small>${g.label}</small><b><span class="odo" data-odo>-</span><em>${g.unit}</em></b><span class="sub" data-sub>&nbsp;</span></div></div>`).join('');
  $('#gauges').querySelectorAll('.gauge').forEach((el, i) => el.style.setProperty('--i', i));

  function renderTelemetry() {
    const t = state.telemetry, g = state.gpu || {};
    const setG = (id, value, frac, sub, hot) => {
      const el = $(`#gauges [data-g="${id}"]`); if (!el) return;
      const prev = parseFloat(el.dataset.last);
      const cur = parseFloat(value);
      const roll = !Number.isFinite(prev) || !Number.isFinite(cur) || Math.abs(cur - prev) >= Math.max(1, Math.abs(prev) * 0.08);
      Prism.odo($('[data-odo]', el), value, { roll });
      if (roll) el.dataset.last = String(cur);
      Prism.ring($('.fg', el), frac);
      $('[data-pct]', el).textContent = frac == null ? '-' : Math.round(frac * 100) + '%';
      $('[data-sub]', el).textContent = sub || ' ';
      el.classList.toggle('hot', !!hot);
    };
    if (!t) return;
    const pl = t.powerLimit || g.powerLimit;
    setG('power', t.powerDraw == null ? '-' : Math.round(t.powerDraw), pl && t.powerDraw != null ? t.powerDraw / pl : 0, pl ? `limit ${Math.round(pl)} W` : '', t.powerLimited);
    setG('load', t.util == null ? '-' : Math.round(t.util), (t.util || 0) / 100, t.pstate ? 'state ' + t.pstate : '');
    setG('temp', t.temp == null ? '-' : Math.round(t.temp), (t.temp || 0) / 90, t.clock ? Math.round(t.clock) + ' MHz core' : '', t.temp >= 83);
    setG('vram', t.memUsed == null ? '-' : (t.memUsed / 1024).toFixed(1), t.memTotal ? t.memUsed / t.memTotal : 0, t.memTotal ? `of ${Math.round(t.memTotal / 1024)} GB` : '');

    // dock orb: power headroom at a glance
    const orb = $('#orbRing');
    Prism.ring(orb, pl && t.powerDraw != null ? t.powerDraw / pl : 0);
    orb.style.stroke = t.powerLimited ? 'var(--warn)' : 'var(--accent)';
    $('#orbVal').textContent = t.util == null ? '-' : Math.round(t.util) + '%';
    $('#gpuOrb').setAttribute('aria-label', `GPU load ${Math.round(t.util || 0)} percent, ${Math.round(t.powerDraw || 0)} watts`);

    // GL-30 sparkline, last 60 samples
    if (t.powerDraw != null) { state.powerHist.push(t.powerDraw); if (state.powerHist.length > 60) state.powerHist.shift(); }
    const top = Math.max((g.powerMax || pl || 300), ...state.powerHist) * 1.05;
    const H = 120, W = 600, n = state.powerHist.length;
    if (n > 1) {
      const pts = state.powerHist.map((v, i) => `${((i + (60 - n)) / 59 * W).toFixed(1)} ${(H - (v / top) * H).toFixed(1)}`);
      $('#sparkLine').setAttribute('d', 'M' + pts.join(' L'));
      $('#sparkArea').setAttribute('d', 'M' + pts.join(' L') + ` L${W} ${H} L${((60 - n) / 59 * W).toFixed(1)} ${H} Z`);
    }
    if (pl) { const y = (H - (pl / top) * H).toFixed(1); $('#sparkLimit').setAttribute('y1', y); $('#sparkLimit').setAttribute('y2', y); }
    $('#powerRead').textContent = t.powerDraw == null ? '' : `${t.powerDraw.toFixed(0)} / ${Math.round(pl || 0)} W`;
    const note = $('#limitNote');
    note.classList.toggle('hot', !!t.powerLimited);
    note.textContent = t.powerLimited
      ? 'At the power limit under full load. This is the usual DLSS 5 bottleneck; a lower output tier helps most.'
      : 'Dashed line is your power limit. Sitting on it under DLSS 5 means the card is power-bound.';
    $('.power').classList.toggle('beam', !!t.powerLimited);
    $('.power').classList.toggle('warn', !!t.powerLimited);
  }

  async function loadLadder(quiet) {
    try { const r = await api.ladder(); if (!r.ok) throw new Error(r.error); state.ladder = r.data; }
    catch (err) { if (!quiet) $('#ladder').innerHTML = `<p class="note">Display modes are unavailable: ${esc(err.message)}</p>`; return; }
    const { current, ladder } = state.ladder;
    $('#ladder').innerHTML = ladder.map((r, i) => {
      const m = r.mode;
      const active = m && current.width === m.width && current.height === m.height;
      return `<div class="rung tile rise ${active ? 'active beam' : ''}" data-i="${i}"><b>${r.label}</b>
        <div><div class="m">${m ? `${m.width} x ${m.height} at ${m.hz} Hz` : 'Not available'}</div>
        <div class="x">${m ? (m.pixelSaving ? Math.round(m.pixelSaving * 100) + '% fewer pixels to render' : 'Native output') : 'No lower mode with the same aspect ratio'}</div></div>
        ${m && !active ? `<button class="btn glassy sm" data-tier="${r.id}">Apply</button>` : active ? '<span class="pill ok">Active</span>' : '<span></span>'}</div>`;
    }).join('');
    $('#ladder').querySelectorAll('.rung').forEach(el => el.style.setProperty('--i', el.dataset.i));
  }
  $('#ladder').addEventListener('click', async e => {
    const b = e.target.closest('[data-tier]'); if (!b) return;
    b.disabled = true;
    try { const m = await call(api.applyTier, b.dataset.tier); Prism.toast('Output resolution set', `${m.width} x ${m.height}. Native comes back when you quit Refract.`); } catch {}
    loadLadder();
  });
  $('#restoreNative').addEventListener('click', async () => { try { await call(api.restoreDisplay); Prism.toast('Native resolution restored'); } catch {} loadLadder(); });
  $('#overlayBtn').addEventListener('click', () => call(api.toggleOverlay).catch(() => {}));

  // ================================================================ looks
  let srcImg = null, srcKind = null;
  const cvB = $('#cvBefore'), cvA = $('#cvAfter');

  function loadImage(url, name, kind) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = Math.min(1, 1600 / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        srcImg = ctx.getImageData(0, 0, c.width, c.height);
        srcKind = kind;
        $('#shotName').textContent = name;
        cvB.width = cvA.width = c.width; cvB.height = cvA.height = c.height;
        $('#compare').style.setProperty('--ar', (c.width / c.height).toFixed(4));
        cvB.getContext('2d').putImageData(srcImg, 0, 0);
        paint(); renderThumbs();
        resolve();
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = url;
    });
  }
  async function useArt() {
    const g = game();
    const url = g && g.art && (g.art.hero || g.art.header || g.art.capsule);
    if (!url) return false;
    await loadImage(url, g.name + ' key art', 'art').catch(() => {});
    return true;
  }
  async function useShot(forGame) {
    const r = await api.latestScreenshot(forGame ? (game() || {}).id || '' : undefined);
    if (r && r.ok && r.data) { await loadImage(r.data.dataUrl, r.data.name, 'shot'); return true; }
    return false;
  }
  async function ensureImage() {
    if (srcKind) return;
    // This game's own screenshot first (true 16:9 frame), then its key art, then any screenshot.
    if (!(await useShot(true)) && !(await useArt()) && !(await useShot())) {
      $('#shotName').textContent = 'No image yet. Choose a screenshot to preview the looks.';
    }
  }
  $('#useArt').addEventListener('click', async () => { if (!(await useArt())) Prism.toast('No key art for this game', 'Pick a Steam game, or choose an image.', 'err'); });
  $('#useShot').addEventListener('click', async () => { if (!(await useShot(true)) && !(await useShot())) Prism.toast('No Steam screenshots found', 'Take one in game with F12, or choose an image.', 'err'); });
  $('#pickShot').addEventListener('click', async () => { const s = await call(api.pickScreenshot).catch(() => null); if (s) loadImage(s.dataUrl, s.name, 'file'); });

  let raf = 0;
  function paint() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!srcImg) return;
      const out = new ImageData(new Uint8ClampedArray(srcImg.data), srcImg.width, srcImg.height);
      gradeImage(out, state.look, state.values);
      cvA.getContext('2d').putImageData(out, 0, 0);
    });
  }
  function renderThumbs() {
    if (!srcImg) return;
    const tw = 208, th = 116;
    const tmp = document.createElement('canvas'); tmp.width = srcImg.width; tmp.height = srcImg.height;
    tmp.getContext('2d').putImageData(srcImg, 0, 0);
    document.querySelectorAll('.look-card canvas').forEach(cv => {
      cv.width = tw; cv.height = th;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const s = Math.max(tw / srcImg.width, th / srcImg.height);
      const w = srcImg.width * s, h = srcImg.height * s;
      ctx.drawImage(tmp, (tw - w) / 2, (th - h) / 2, w, h);
      const d = ctx.getImageData(0, 0, tw, th);
      gradeImage(d, cv.dataset.look, state.values);
      ctx.putImageData(d, 0, 0);
    });
  }

  // MO-31 compare handle: pointer + keyboard
  const cmp = $('#compare'); let dragging = false;
  const setX = clientX => { const r = cmp.getBoundingClientRect(); cmp.style.setProperty('--x', Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)) + '%'); };
  cmp.addEventListener('pointerdown', e => { dragging = true; cmp.setPointerCapture(e.pointerId); setX(e.clientX); });
  cmp.addEventListener('pointermove', e => { if (dragging) setX(e.clientX); });
  cmp.addEventListener('pointerup', () => { dragging = false; });
  cmp.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cur = parseFloat(getComputedStyle(cmp).getPropertyValue('--x')) || 50;
    cmp.style.setProperty('--x', Math.min(100, Math.max(0, cur + (e.key === 'ArrowRight' ? 4 : -4))) + '%'); e.preventDefault();
  });

  $('#lookCards').innerHTML = LOOKS.map(l => `<button class="look-card" role="radio" data-look="${l.id}" aria-checked="${l.id === state.look}">
      <canvas data-look="${l.id}" width="208" height="116" aria-hidden="true"></canvas><span><b>${esc(l.name)}</b><small>${esc(l.summary)}</small></span></button>`).join('');
  $('#lookCards').addEventListener('click', e => {
    const c = e.target.closest('.look-card'); if (!c) return;
    state.look = c.dataset.look;
    document.querySelectorAll('.look-card').forEach(x => x.setAttribute('aria-checked', String(x === c)));
    renderParams(); paint();
  });

  function renderParams() {
    const l = LOOKS.find(x => x.id === state.look);
    const sliders = l.params.map((p, i) => `<div class="slider rise" data-i="${i}"><div class="hd"><label for="p-${p.id}">${esc(p.label)}</label><output id="o-${p.id}">${(+state.values[p.id]).toFixed(p.step < 0.01 ? 3 : 2)}</output></div>
        <input type="range" id="p-${p.id}" data-id="${p.id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${state.values[p.id]}"></div>`).join('');
    $('#params').innerHTML = (sliders || '<div class="empty-note rise">Default shows the game exactly as DLSS 5 renders it. Pick Cinematic or Natural Lighting above to grade the image; those have sliders here.</div>') +
      `<div class="slider rise" data-i="${l.params.length}"><div class="hd"><label for="p-trans">Transition between looks</label><output id="o-trans">${state.transition.toFixed(2)} s</output></div>
        <input type="range" id="p-trans" min="0" max="2" step="0.05" value="${state.transition}"></div>
      ${l.params.length ? `<button class="btn ghost sm" id="resetLook"><i class="ph ph-arrow-counter-clockwise"></i>Reset ${esc(l.name)}</button>` : ''}`;
    $('#params').querySelectorAll('.rise').forEach(el => el.style.setProperty('--i', el.dataset.i || 0));
    $('#params').querySelectorAll('input[type=range]').forEach(inp => {
      Prism.sliderFill(inp);
      inp.addEventListener('input', () => {
        Prism.sliderFill(inp);
        if (inp.id === 'p-trans') { state.transition = +inp.value; $('#o-trans').textContent = state.transition.toFixed(2) + ' s'; return; }
        const p = l.params.find(x => x.id === inp.dataset.id);
        state.values[p.id] = +inp.value;
        $('#o-' + p.id).textContent = (+inp.value).toFixed(p.step < 0.01 ? 3 : 2);
        paint();
      });
      inp.addEventListener('change', renderThumbs);
    });
    const rs = $('#resetLook');
    if (rs) rs.addEventListener('click', () => { const d = defaults(); l.params.forEach(p => { state.values[p.id] = d[p.id]; }); renderParams(); paint(); renderThumbs(); });
    const hk = state.settings ? state.settings.lookHotkeys : {};
    $('#keys').innerHTML = LOOKS.map(x => `<span>${esc(x.id === 'natural' ? 'Natural' : x.name)} ${(hk[x.id] || '').split('+').map(k => `<kbd>${esc(k)}</kbd>`).join('')}</span>`).join('');
  }
  $('#saveLooks').addEventListener('click', async () => {
    try {
      const r = await call(api.saveLooks, { values: state.values, startLook: state.settings.startLook, transition: state.transition });
      Prism.toast('Looks saved', r.updated ? `Updated ${r.updated} game preset${r.updated > 1 ? 's' : ''}. ReShade loads them next launch.` : 'Install looks on a game to use them.');
    } catch {}
  });

  // ================================================================ settings
  function renderSettings() {
    const s = state.settings;
    $('#hkOverlay').value = s.overlay.hotkey;
    $('#hkDefault').value = s.lookHotkeys.default;
    $('#hkCinematic').value = s.lookHotkeys.cinematic;
    $('#hkNatural').value = s.lookHotkeys.natural;
    $('#tgMotion').setAttribute('aria-checked', String(s.ambientMotion !== false));
    $('#tgRT').setAttribute('aria-checked', String(!!s.reducedTransparency));
    applyAppearance();
  }
  function applyAppearance() {
    const s = state.settings;
    document.documentElement.classList.toggle('still', s.ambientMotion === false || !!(state.session && state.session.state === 'running'));
    if (s.reducedTransparency) document.documentElement.setAttribute('data-transparency', 'reduce');
    else document.documentElement.removeAttribute('data-transparency');
  }
  Prism.toggle($('#tgMotion'), async v => { const r = await call(api.patchSettings, { ambientMotion: v }).catch(() => null); if (r) { state.settings = r.settings; applyAppearance(); } });
  Prism.toggle($('#tgRT'), async v => { const r = await call(api.patchSettings, { reducedTransparency: v }).catch(() => null); if (r) { state.settings = r.settings; applyAppearance(); } });
  $('#saveHotkeys').addEventListener('click', async () => {
    const err = $('#hkErr');
    const vals = ['#hkOverlay', '#hkDefault', '#hkCinematic', '#hkNatural'].map(id => $(id).value.trim());
    if (vals.some(v => !v) || new Set(vals.map(v => v.toLowerCase())).size !== vals.length) {
      err.hidden = false; err.textContent = 'Each hotkey needs a value, and no two can match.'; return;
    }
    const r = await call(api.patchSettings, { overlay: { ...state.settings.overlay, hotkey: vals[0] },
      lookHotkeys: { default: vals[1], cinematic: vals[2], natural: vals[3] } }).catch(() => null);
    if (!r) return;
    state.settings = r.settings;
    if (r.failedShortcuts.length) { err.hidden = false; err.textContent = 'Could not register ' + r.failedShortcuts.join(', ') + '. Another app may be using it.'; }
    else { err.hidden = true; Prism.toast('Hotkeys saved'); }
    renderParams();
  });

  function renderDriver() {
    const g = state.gpu || {};
    $('#driverKv').innerHTML = g.available ? `
      <dt>GPU</dt><dd>${esc(g.name)}</dd>
      <dt>Driver</dt><dd>${esc(g.driver)} <span class="pill ${g.driverStatus === 'tested' ? 'ok' : g.driverStatus === 'newer' ? '' : 'warn'}">${g.driverStatus === 'tested' ? 'tested' : g.driverStatus === 'newer' ? 'newer than tested' : 'older than ' + esc(g.testedDriver)}</span></dd>
      <dt>Tested with</dt><dd>${esc(g.testedDriver)}</dd>
      <dt>DLSS 5</dt><dd>${g.rtx50 ? 'Supported (RTX 50)' : 'Needs an RTX 50 GPU'}</dd>
      <dt>Power limit</dt><dd>${g.powerLimit ?? '-'} W of ${g.powerMax ?? '-'} W</dd>`
      : `<dt>GPU</dt><dd>nvidia-smi not found. Install or update the NVIDIA driver.</dd>`;
  }

  // ================================================================ live events
  api.on('telemetry', t => { state.telemetry = t; renderTelemetry(); });
  api.on('session', s => {
    state.session = s;
    const el = $('#session');
    el.hidden = s.state === 'ended';
    $('#sessionText').textContent = s.state === 'launching' ? 'Starting ' + s.game : 'Playing ' + s.game;
    if (s.state === 'ended') { Prism.toast('Session ended', s.game + ' closed.'); loadLadder(true); }
    applyAppearance(); renderHero();
  });
  $('#sessionEnd').addEventListener('click', () => call(api.endSession).catch(() => {}));
  api.on('hotkeys', h => { state.hotkeys = h; renderGuideKey(); });
  api.on('gamelog', ({ gameId, log }) => {
    const g = state.games.find(x => x.id === gameId);
    if (g) g.lastRun = log;
    if (g && game() === g && state.tab === 'setup') renderDlss5(g);
    if (log && log.level === 'bad') Prism.toast('Neural rendering did not run', log.text, 'err');
  });

  // ================================================================ first-run guide
  function renderGuideKey() {
    const k = state.hotkeys && state.hotkeys.overlay;
    const el = $('#guideOverlayKey');
    if (el) el.innerHTML = k ? k.split('+').map(x => `<kbd>${esc(x)}</kbd>`).join(' + ') : 'The overlay hotkey';
  }
  function openGuide() { renderGuideKey(); const w = $('#welcome'); w.hidden = false; Prism.pop($('.sheet-card', w)); $('#welcomeDone').focus(); }
  function closeGuide() { $('#welcome').hidden = true; if (!state.settings.onboarded) { state.settings.onboarded = true; call(api.markOnboarded).catch(() => {}); } }
  $('#exportDiag').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    const g = game();
    const r = await call(api.exportDiagnostics, g ? g.id : null).catch(() => null);
    if (r) Prism.toast('Diagnostics saved', (g ? g.name + ': ' : '') + 'the zip is in your Downloads folder.');
    b.disabled = false;
  });
  Prism.seg($('#cardSeg'), v => { state.cardTab = Number(v); renderCards(); });
  $('#help').addEventListener('click', openGuide);
  $('#openGuide').addEventListener('click', openGuide);
  $('#restoreEverything').addEventListener('click', async e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.classList.add('armed'); b.querySelector('span').textContent = 'Click again';
      setTimeout(() => { delete b.dataset.armed; b.classList.remove('armed'); b.querySelector('span').textContent = 'Restore all'; }, 4000);
      return;
    }
    b.disabled = true;
    try {
      const report = await call(api.restoreEverything);
      const ok = report.filter(r => !r.error), bad = report.filter(r => r.error);
      Prism.toast(ok.length ? `Restored ${ok.length} game${ok.length === 1 ? '' : 's'}` : 'Nothing to restore',
        bad.length ? `Couldn't restore: ${bad.map(r => r.game).join(', ')}` : ok.map(r => r.game).join(', ') || 'No game has Refract changes.', bad.length ? 'err' : undefined);
      scan();
    } finally { b.disabled = false; delete b.dataset.armed; b.classList.remove('armed'); b.querySelector('span').textContent = 'Restore all'; }
  });
  $('#welcomeDone').addEventListener('click', closeGuide);
  $('#welcome').addEventListener('click', e => { if (e.target.id === 'welcome') closeGuide(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#welcome').hidden) closeGuide(); });
  api.on('display', () => loadLadder(true));
  api.on('settings', s => { state.settings = s; });

  // ================================================================ boot
  (async function boot() {
    try {
      const r = await api.state();
      const s = r.data;
      state.settings = s.settings; state.gpu = s.gpu; state.telemetry = s.telemetry; state.hotkeys = s.hotkeys || null;
      state.neural = s.neuralScreen || null;
      if (s.session) { state.session = s.session; $('#session').hidden = false; $('#sessionText').textContent = (s.session.state === 'launching' ? 'Starting ' : 'Playing ') + s.session.game; }
      if (!s.settings.onboarded && !s.selftest) setTimeout(openGuide, 600);
      state.values = { ...defaults(), ...s.settings.looks };
      state.transition = s.settings.transition ?? 0.6;
      renderSettings(); renderDriver(); renderParams(); renderTelemetry();
      state.cardTab = (s.gpu && s.gpu.series) || 50;
      const cs = $('#cardSeg');
      if (cs) { cs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === state.cardTab))); Prism.segMove(cs); }
      if (s.games.length) { state.games = s.games; renderShelf(); select((visibleGames()[0] || s.games[0]).id); }
      else await scan();
      api.ready({ ok: true, games: state.games.length });
    } catch (err) {
      api.ready({ ok: false, error: String(err && err.message || err) });
    }
  })();
})();
