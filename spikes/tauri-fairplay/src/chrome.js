// Our window bar and settings panel over soundcloud.com itself (the default
// "hybrid" mode), as the Electron app does it: SoundCloud's page stays as it
// is, pushed down under our 32px bar, with a few tweaks. The bar is
// custom.html's (from the Electron app's src/header); the settings come from
// Rust (window.__settings / __lastfm, refreshed by "chrome:ready").
// Main frame only.
(() => {
  if (window.top !== window || window.__pocChrome) return;
  window.__pocChrome = true;
  const isMac = /Mac/.test(navigator.platform), isWin = /Win/.test(navigator.platform);
  const post = m => window.ipc?.postMessage(m);
  // The init script has the settings of the app's launch; after a change and
  // a full reload Rust answers "chrome:ready" with the saved ones.
  let state = [window.__settings || {}, window.__lastfm || { connected: false }];
  window.__chromeState = (...s) => { state = s; };
  post('chrome:ready');

  const css = `
    /* ---- SoundCloud under our bar: in-flow content via the body's padding,
       its fixed parts one by one. ---- */
    body { padding-top: 32px !important; box-sizing: border-box; }
    header.header.fixed { top: 32px !important; }
    .modal { top: 32px !important; height: calc(100% - 32px) !important; }
    .modal .modal__header.hovering { top: 32px !important; }
    .dropbar { top: 78px !important; }
    #gritter-notice-wrapper { top: 92px !important; }
    .fullScreenOverlay, .webiIframe.webiIframeV2Layout.fullScreen { top: 32px !important; height: auto !important; bottom: 0 !important; }
    .headerMenu.moreMenu, .headerMenu.profileMenu { max-height: calc(100vh - 78px) !important; }
    /* Our bar has the search; Artist Studio is "Artist" (see below); no chevron by the avatar. */
    header.header .header__search, .header__userNavUsernameButtonIcon { display: none !important; }
    /* SoundCloud's header is at least 960 px wide; in a narrower window the
       empty middle gives way so Artist/Upload/avatar/menus stay on screen. */
    @media (max-width: 1080px) { header.header .header__inner { width: auto !important; min-width: 0; padding-right: 16px; box-sizing: border-box; } .header__middle { min-width: 0; } }
    /* Below 1080 px their containers are 960 px: the player bar's right end
       went off screen, and the track page's frame (which has a narrow layout
       of its own) was stretched to 960 px by the shell's grid. */
    @media (max-width: 1079px) {
      .playControls__wrapper.l-container, body.crossfade-iframe-active #app .l-container { width: auto !important; }
      body.crossfade-iframe-active { grid-template-columns: minmax(0, 1fr); overflow-x: hidden; }
    }

    /* ---- Title bar: the Electron app's header (src/header/header.css), under
       a transparent macOS title bar; the traffic lights sit in the 80px on the left. ---- */
    .pocTitlebar { --poc-bg: #121212; --poc-text: #fff; --poc-hover: rgba(255, 255, 255, .1);
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000; display: grid; grid-template-columns: minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr); align-items: center; height: 32px; background: var(--poc-bg); color: var(--poc-text); user-select: none; -webkit-user-select: none; font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    html.theme-light .pocTitlebar { --poc-bg: #fff; --poc-text: #333; --poc-hover: rgba(0, 0, 0, .08); border-bottom: 1px solid rgba(0, 0, 0, .08); }
    .pocTitlebar * { box-sizing: border-box; }
    .pocTitlebar .header-side, .pocTitlebar .header-center { display: flex; align-items: center; min-width: 0; height: 100%; }
    .pocTitlebar .header-side:first-child { padding-left: 80px; }
    .pocTitlebar .header-side:last-child { padding-right: 12px; }
    .pocTitlebar .navigation-controls { display: flex; align-items: center; }
    .pocTitlebar .navigation-controls.hidden { display: none; }
    .pocTitlebar .nav-button { display: flex; align-items: center; justify-content: center; width: 32px; height: 24px; margin-right: 4px; border-radius: 4px; opacity: .7; transition: all .2s ease; color: var(--poc-text); }
    .pocTitlebar .nav-button:hover { opacity: 1; background: var(--poc-hover); }
    .pocTitlebar .nav-button.disabled { opacity: .3; background: transparent; }
    .pocTitlebar .title-bar { align-self: stretch; flex: 1 1 16px; min-width: 16px; }
    .pocTitlebar .tab-group { min-width: 0; max-width: 100%; display: flex; align-items: center; height: 22px; padding: 2px; border-radius: 8px; background: var(--poc-hover); }
    .pocTitlebar .tab { display: flex; align-items: center; gap: 6px; width: 320px; max-width: 100%; min-width: 0; height: 22px; padding: 0 6px; border-radius: 6px; background: var(--poc-hover); overflow: hidden; cursor: text; }
    .pocTitlebar .tab-icon { flex: none; width: 16px; height: 16px; border-radius: 3px; }
    .pocTitlebar .tab-icon:not([src]) { visibility: hidden; }
    .pocTitlebar .tab-title, .pocTitlebar .tab-path { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
    .pocTitlebar .tab-title { flex: 0 1 auto; }
    .pocTitlebar .tab-path { flex: 1 1 0; opacity: .5; }
    /* The tab doubles as the URL bar (Electron header.js editUrl). */
    .pocTitlebar .tab-url { display: none; flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
    .pocTitlebar .tab.editing .tab-title, .pocTitlebar .tab.editing .tab-path { display: none; }
    .pocTitlebar .tab.editing .tab-url { display: block; }
    .pocTitlebar .pocSearch { display: flex; align-items: center; gap: 6px; width: 198px; min-width: 80px; flex: 0 1 198px; height: 22px; margin: 0 8px 0 0; padding: 0 8px; border-radius: 6px; background: var(--poc-hover); }
    .pocTitlebar .pocSearch input { flex: 1; min-width: 0; height: auto; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; box-shadow: none; }
    .pocTitlebar .pocSearch svg { flex: none; opacity: .6; }
    /* Windows (Electron header's platform-win32 layout): no traffic lights;
       window buttons at the far right of a frameless window, resized from its edges. */
    .pocTitlebar .window-controls, .pocEdge { display: none; }
    html.platform-win .pocTitlebar { grid-template-columns: auto minmax(0, auto) minmax(min-content, 1fr); }
    html.platform-win .pocTitlebar .header-side:first-child { padding-left: 8px; }
    html.platform-win .pocTitlebar .header-side:first-child .title-bar { flex: 0 0 8px; min-width: 8px; }
    html.platform-win .pocTitlebar .header-side:last-child { padding-right: 0; }
    html.platform-win .pocTitlebar .window-controls { display: flex; align-self: stretch; margin-left: 4px; }
    .pocTitlebar .window-controls button { width: 46px; height: 100%; padding: 0; border: 0; background: transparent; color: var(--poc-text); font: 10px/1 'Segoe Fluent Icons', 'Segoe MDL2 Assets'; cursor: default; }
    .pocTitlebar .window-controls button:hover { background: var(--poc-hover); }
    .pocTitlebar .window-controls .close:hover { background: #e81123; color: #fff; }
    html.platform-win:not(.maximized) .pocEdge { display: block; position: fixed; z-index: 2147483002; }
    .pocEdge[data-edge=n], .pocEdge[data-edge=s] { left: 6px; right: 6px; height: 4px; cursor: ns-resize; }
    .pocEdge[data-edge=e], .pocEdge[data-edge=w] { top: 6px; bottom: 6px; width: 4px; cursor: ew-resize; }
    .pocEdge[data-edge=n] { top: 0; } .pocEdge[data-edge=s] { bottom: 0; } .pocEdge[data-edge=e] { right: 0; } .pocEdge[data-edge=w] { left: 0; }
    .pocEdge[data-edge$=e][data-edge^=n], .pocEdge[data-edge$=w][data-edge^=n], .pocEdge[data-edge$=e][data-edge^=s], .pocEdge[data-edge$=w][data-edge^=s] { width: 6px; height: 6px; }
    .pocEdge[data-edge=nw] { top: 0; left: 0; cursor: nwse-resize; } .pocEdge[data-edge=se] { bottom: 0; right: 0; cursor: nwse-resize; }
    .pocEdge[data-edge=ne] { top: 0; right: 0; cursor: nesw-resize; } .pocEdge[data-edge=sw] { bottom: 0; left: 0; cursor: nesw-resize; }

    /* ---- Settings: the Electron app's panel (src/settings/settingsPanel.css),
       scoped so its generic selectors don't touch SoundCloud's page. ---- */
    .pocSettings { --bg-primary: #1a1a1a; --bg-secondary: #262626; --bg-hover: rgba(255, 255, 255, .08); --text-primary: #fff; --text-secondary: rgba(255, 255, 255, .6); --accent: #ff5500; --border: rgba(255, 255, 255, .1); --track: rgba(255, 255, 255, .2);
      position: fixed; top: 32px; right: 0; bottom: 0; z-index: 2147483001; width: min(420px, 100vw); display: flex; flex-direction: column; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--text-primary); background: var(--bg-primary); border-left: 1px solid var(--border); user-select: none; -webkit-user-select: none; -webkit-font-smoothing: antialiased;
      opacity: 0; transform: translateX(16px); pointer-events: none; transition: opacity .15s, transform .15s; }
    html.theme-light .pocSettings { --bg-primary: #fff; --bg-secondary: #f3f3f3; --bg-hover: rgba(0, 0, 0, .06); --text-primary: #222; --text-secondary: rgba(0, 0, 0, .6); --border: rgba(0, 0, 0, .12); --track: rgba(0, 0, 0, .2); }
    .pocSettings.visible { opacity: 1; transform: none; pointer-events: auto; }
    .pocSettings * { box-sizing: border-box; margin: 0; padding: 0; }
    .pocSettings .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 6px 20px; }
    .pocSettings h1 { font-size: 18px; font-weight: 600; }
    .pocSettings .close-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
    .pocSettings .close-btn:hover { background: var(--bg-hover); }
    .pocSettings nav { display: flex; gap: 18px; padding: 8px 20px 0; border-bottom: 1px solid var(--border); }
    .pocSettings nav button { padding: 6px 0 8px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-secondary); font: inherit; font-size: 14px; cursor: pointer; }
    .pocSettings nav button.active { color: var(--text-primary); border-bottom-color: var(--accent); }
    .pocSettings main { flex: 1; min-height: 0; overflow-y: auto; padding: 0 20px 20px; }
    .pocSettings h2 { padding: 14px 0 6px; color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
    .pocSettings .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; min-height: 36px; padding: 6px 0; }
    .pocSettings .row > span:first-child { flex: 1 1 10em; }
    .pocSettings label.row { cursor: pointer; }
    .pocSettings .hint { padding: 2px 0 6px; color: var(--text-secondary); font-size: 12px; }
    .pocSettings .toggle { position: relative; flex: none; width: 36px; height: 20px; }
    .pocSettings .toggle input { position: absolute; inset: 0; opacity: 0; }
    .pocSettings .slider { position: absolute; inset: 0; border-radius: 10px; background: var(--track); cursor: pointer; transition: background .15s; }
    .pocSettings .slider::before { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .3); transition: transform .15s; }
    .pocSettings input:checked + .slider { background: var(--accent); }
    .pocSettings input:checked + .slider::before { transform: translateX(16px); }
    .pocSettings .field { display: block; padding: 6px 0; }
    .pocSettings .field > span { display: block; margin-bottom: 6px; }
    .pocSettings .textInput { width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: inherit; font: inherit; user-select: text; -webkit-user-select: text; }
    .pocSettings .textInput:focus { outline: none; border-color: var(--accent); }
    .pocSettings .buttons { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0 6px; }
    .pocSettings .btn { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .pocSettings .btn:hover { background: var(--bg-hover); }
    .pocSettings .btn.primary { width: 100%; border-color: transparent; background: var(--accent); color: #fff; font-weight: 600; }
    .pocSettings .btn.danger { color: #ff5500; }
    .pocSettings .link { color: #5bb7ff; text-decoration: none; cursor: pointer; }
    .pocSettings [hidden] { display: none !important; }
    .pocSettings select { min-width: 140px; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: inherit; font: inherit; }
    .pocToast { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); z-index: 2147483000; padding: 8px 14px; border-radius: 6px; background: #333; color: #fff; font: 13px/1.4 -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, .4); }
  `;

  const icon = d => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="${d}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const markup = `
    <div class="pocTitlebar">
      <div class="header-side">
        <div class="navigation-controls">
          <div class="nav-button disabled" data-cmd="back" title="Go Back">${icon('M10.5 3L5.5 8l5 5')}</div>
          <div class="nav-button disabled" data-cmd="forward" title="Go Forward">${icon('M5.5 3L10.5 8l-5 5')}</div>
          <div class="nav-button" data-cmd="reload" title="Refresh Page"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 0 1-11 0 5.5 5.5 0 0 1 9.5-3.7" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M10.5 2.5 12 4l-1.5 1.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        </div>
        <div class="title-bar"></div>
      </div>
      <div class="header-center">
        <div class="tab-group"><div class="tab"><img class="tab-icon" alt=""><span class="tab-title"></span><span class="tab-path"></span><input class="tab-url" spellcheck="false" aria-label="Address"></div></div>
      </div>
      <div class="header-side">
        <div class="title-bar"></div>
        <form class="pocSearch"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><input name="q" type="search" placeholder="Search" autocomplete="off" aria-label="Search"></form>
        <div class="nav-button" data-cmd="settings" title="Settings">${icon('M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5')}</div>
        <div class="window-controls"><button type="button" class="minimize" title="Minimize" aria-label="Minimize">&#xE921;</button><button type="button" class="maximize" title="Maximize" aria-label="Maximize">&#xE922;</button><button type="button" class="close" title="Close" aria-label="Close">&#xE8BB;</button></div>
      </div>
    </div>
    ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(e => `<div class="pocEdge" data-edge="${e}"></div>`).join('')}
    <aside class="pocSettings" aria-label="Settings">
      <header class="panel-header"><h1>Settings</h1><button class="close-btn" title="Close">${icon('M12 4L4 12m8 0L4 4')}</button></header>
      <nav>
        <button data-tab="general" class="active">General</button>
        <button data-tab="appearance">Appearance</button>
        <button data-tab="integrations">Integrations</button>
        <button data-tab="advanced">Advanced</button>
      </nav>
      <main>
        <section data-tab="general"><h2>Window</h2>
          <label class="row"><span>Back and forward buttons</span><span class="toggle"><input type="checkbox" data-setting="navButtons"><span class="slider"></span></span></label></section>
        <section data-tab="appearance" hidden><h2>Theme</h2>
          <div class="row"><span>Theme</span><select data-setting="theme"><option value="dark">Dark</option><option value="light">Light</option><option value="system">Match system</option></select></div></section>
        <section data-tab="integrations" hidden><h2>Discord</h2>
          <label class="row"><span>Discord Rich Presence</span><span class="toggle"><input type="checkbox" data-setting="discord"><span class="slider"></span></span></label>
          <p class="hint">Shows the track you're playing on your Discord profile.</p>
          <h2>Last.fm</h2>
          <label class="row"><span>Scrobble to Last.fm</span><span class="toggle"><input type="checkbox" data-setting="lastfm"><span class="slider"></span></span></label>
          <div data-lfm="setup">
            <p class="hint">Uses your own Last.fm API account: <a class="link" data-external="https://www.last.fm/api/account/create">create one</a>, then paste its key and shared secret. The secret is kept in your ${isWin ? 'Windows Credential Manager' : 'macOS Keychain'}.</p>
            <label class="field"><span>API key</span><input class="textInput" data-lfm="key" autocomplete="off" spellcheck="false"></label>
            <label class="field"><span>Shared secret</span><input class="textInput" data-lfm="secret" type="password" autocomplete="off"></label>
            <div class="buttons"><button class="btn primary" data-lfm="connect">Connect Last.fm</button></div>
          </div>
          <div data-lfm="connected" hidden><div class="row"><span>Connected as <b data-lfm="name"></b></span><button class="btn danger" data-lfm="disconnect">Disconnect</button></div></div>
          <p class="hint" data-lfm="status"></p></section>
        <section data-tab="advanced" hidden><h2>Privacy</h2>
          <label class="row"><span>Block ads and trackers</span><span class="toggle"><input type="checkbox" data-setting="adblock"><span class="slider"></span></span></label>
          <p class="hint">Takes effect the next time the app starts.</p></section>
      </main>
    </aside>`;

  // SoundCloud's router follows pushState + popstate (the Electron app's
  // navigateActiveTab); a real load would stop whatever is playing.
  const go = url => {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !document.getElementById('app')) return location.assign(u.href);
    try {
      history.pushState(null, '', u.pathname + u.search + u.hash);
      dispatchEvent(new PopStateEvent('popstate'));
    } catch { location.assign(u.href); }
  };
  // URL bar input to a SoundCloud address, or null (Electron's resolveUrlInput).
  const resolveUrlInput = input => {
    const text = input.trim();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      try {
        const u = new URL(text);
        return u.protocol === 'https:' && (u.hostname === 'soundcloud.com' || u.hostname.endsWith('.soundcloud.com')) ? u.href : null;
      } catch { return null; }
    }
    const path = text.replace(/^(www\.)?soundcloud\.com(\/|$)/i, '').replace(/^\/+/, '');
    return location.origin + '/' + (/\s/.test(path) ? 'search?q=' + encodeURIComponent(path) : path);
  };
  // "Stream x | Listen online for free on SoundCloud" -> "Stream x"; titles
  // that are nothing but SoundCloud's slogan give the page's name.
  const pageTitle = () => {
    const t = document.title.replace(/\s+[|–-]\s+[^|–]*SoundCloud[^|]*$/i, '').replace(/^Stream\s+/, '').trim();
    if (t && !/SoundCloud/i.test(t)) return t;
    const first = location.pathname.split('/').filter(Boolean)[0] || '';
    return !first || first === 'discover' ? 'Home' : first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, ' ');
  };

  function init() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.innerHTML = markup;
    document.body.append(...root.children);
    const bar = document.querySelector('.pocTitlebar'), panel = document.querySelector('.pocSettings');
    const $ = (sel, el = bar) => el.querySelector(sel);
    const tab = $('.tab'), urlInput = $('.tab-url'), search = $('.pocSearch');

    // --- Back/forward over the real history; the Navigation API knows when
    // there is nowhere to go (all buttons stay enabled where it is missing).
    const paint = () => {
      const nav = window.navigation;
      $('[data-cmd=back]').classList.toggle('disabled', !!nav && !nav.canGoBack);
      $('[data-cmd=forward]').classList.toggle('disabled', !!nav && !nav.canGoForward);
      const title = pageTitle();
      let path = location.pathname.slice(1) + location.search;
      try { path = decodeURIComponent(path); } catch {}
      if ($('.tab-title').textContent !== title) $('.tab-title').textContent = title;
      if ($('.tab-path').textContent !== path) $('.tab-path').textContent = path;
      tab.title = title;
      const fav = document.querySelector('link[rel~="icon"]')?.href;
      if (fav && $('.tab-icon').getAttribute('src') !== fav) $('.tab-icon').src = fav;
    };
    window.navigation?.addEventListener('currententrychange', paint);
    addEventListener('popstate', paint);
    // SoundCloud sets the title once a page's data is in
    new MutationObserver(paint).observe(document.head, { childList: true, subtree: true, characterData: true });
    paint();

    const commands = {
      back: () => history.back(),
      forward: () => history.forward(),
      reload: () => location.reload(),
      settings: () => toggleSettings(),
    };
    bar.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (b) commands[b.dataset.cmd](); });
    // Mouse back/forward buttons.
    addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.button === 3 ? history.back() : history.forward(); } });

    // Drag the window from empty bar space, double-click to zoom.
    bar.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.nav-button, .tab-group, .pocSearch, .window-controls')) return;
      post(e.detail === 2 ? 'zoom' : 'drag');
    });

    // Windows: our own window buttons and resize edges; Rust drops the native
    // frame only once told they exist. macOS keeps its traffic lights.
    if (isWin) {
      document.documentElement.classList.add('platform-win');
      $('.minimize').onclick = () => post('minimize');
      $('.maximize').onclick = () => post('zoom');
      $('.close').onclick = () => post('close');
      for (const edge of document.querySelectorAll('.pocEdge')) edge.addEventListener('mousedown', e => {
        if (e.button === 0) { e.preventDefault(); post('resize:' + edge.dataset.edge); }
      });
      window.__windowState = ({ maximized }) => {
        document.documentElement.classList.toggle('maximized', maximized);
        $('.maximize').textContent = maximized ? '' : '';
        $('.maximize').title = maximized ? 'Restore' : 'Maximize';
      };
      post('frameless');
    }

    // --- The tab doubles as the URL bar: click to edit the full address,
    // Enter goes there (or searches, with spaces), Escape cancels.
    function editUrl() {
      if (tab.classList.contains('editing')) return;
      tab.classList.add('editing');
      urlInput.value = location.href;
      urlInput.focus();
      urlInput.select();
    }
    tab.addEventListener('click', editUrl);
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const url = resolveUrlInput(urlInput.value); if (url) go(url); }
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); urlInput.blur(); }
    });
    urlInput.addEventListener('blur', () => tab.classList.remove('editing'));

    // --- Search: SoundCloud's results page, without a reload.
    search.addEventListener('submit', e => {
      e.preventDefault();
      const q = search.q.value.trim();
      if (q) go('/search?q=' + encodeURIComponent(q));
    });
    search.q.addEventListener('keydown', e => { if (e.key === 'Escape') search.q.blur(); });
    // Typing in our fields must not reach SoundCloud's single-key shortcuts (L likes, R reposts…).
    for (const el of [bar, panel]) for (const t of ['keydown', 'keypress', 'keyup']) el.addEventListener(t, e => e.stopPropagation());

    // --- Settings: saved by the Rust side (settings.json).
    const settings = { navButtons: true, theme: 'dark', discord: true, adblock: true };
    const darkQuery = matchMedia('(prefers-color-scheme: dark)');
    function applySettings() {
      $('.navigation-controls').classList.toggle('hidden', !settings.navButtons);
      const dark = settings.theme === 'system' ? darkQuery.matches : settings.theme !== 'light';
      // SoundCloud's own theme classes, as the Electron app's applyThemeToContent sets them
      for (const el of [document.documentElement, document.body]) {
        el.classList.toggle('theme-dark', dark);
        el.classList.toggle('theme-light', !dark);
      }
      // the track page's frame takes it over SoundCloud's postMessage protocol
      document.querySelector('.webiIframe')?.contentWindow?.postMessage({ kind: 'set-theme', theme: dark ? 'dark' : 'light' }, location.origin);
    }
    darkQuery.addEventListener('change', applySettings);
    const inputs = panel.querySelectorAll('[data-setting]');
    const showSettings = () => inputs.forEach(el => { if (el.type === 'checkbox') el.checked = !!settings[el.dataset.setting]; else el.value = settings[el.dataset.setting]; });
    for (const el of inputs) el.addEventListener('change', () => {
      settings[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.value;
      applySettings();
      post('settings:' + JSON.stringify(settings));
    });
    for (const b of panel.querySelectorAll('nav button')) b.onclick = () => {
      panel.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
      panel.querySelectorAll('section').forEach(sec => { sec.hidden = sec.dataset.tab !== b.dataset.tab; });
    };
    const toggleSettings = force => panel.classList.toggle('visible', force);
    $('.close-btn', panel).onclick = () => toggleSettings(false);

    // Last.fm: the Rust side signs in (browser approval) and scrobbles.
    const lfm = k => $(`[data-lfm=${k}]`, panel);
    let lastfm = { connected: false };
    window.__lastfmStatus = st => {
      if ('connected' in st) lastfm = st;
      lfm('setup').hidden = !!lastfm.connected;
      lfm('connected').hidden = !lastfm.connected;
      lfm('name').textContent = lastfm.name || '';
      lfm('connect').disabled = st.state === 'waiting';
      lfm('status').textContent = { waiting: 'Approve the app in the browser window that just opened…', error: 'Could not connect: ' + st.message }[st.state] ?? '';
      if (st.state === 'connected') { lfm('secret').value = ''; if (!settings.lastfm) panel.querySelector('[data-setting="lastfm"]').click(); }
    };
    lfm('connect').onclick = () => post('lastfm:connect:' + JSON.stringify({ key: lfm('key').value, secret: lfm('secret').value }));
    lfm('disconnect').onclick = () => post('lastfm:disconnect');
    panel.querySelectorAll('[data-external]').forEach(a => a.onclick = e => { e.preventDefault(); post('open:' + a.dataset.external); });
    window.__chromeState = (saved, fm) => {
      Object.assign(settings, saved);
      showSettings();
      applySettings();
      window.__lastfmStatus(fm);
    };
    window.__chromeState(...state);

    // --- Shortcuts, also while the track page's frame has the focus.
    const onKey = e => {
      if (e.key === 'Escape' && panel.classList.contains('visible')) return toggleSettings(false);
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
      const cmd = { '[': commands.back, ']': commands.forward, r: commands.reload, ',': () => toggleSettings(), f: () => search.q.focus(), l: editUrl }[e.key];
      if (cmd) { e.preventDefault(); cmd(); }
    };
    const hook = w => { try { if (!w.__pocKeys) { w.__pocKeys = true; w.addEventListener('keydown', onKey, true); } } catch {} };
    hook(window);
    // (a frame's load event stops at the document, never reaching window)
    document.addEventListener('load', e => { if (e.target.tagName === 'IFRAME') hook(e.target.contentWindow); }, true);
    document.querySelectorAll('iframe').forEach(f => hook(f.contentWindow));

    // --- "Artist Studio" is just "Artist"; SoundCloud re-renders its header.
    const renameArtist = () => {
      const a = document.querySelector('.header__forArtistsButton');
      if (a && a.textContent === 'Artist Studio') a.textContent = 'Artist';
    };
    // --- Below 768 px SoundCloud's track page switches to a phone layout
    // without the waveform: draw its frame 768 px wide, scaled to fit.
    const fitTrackFrame = () => {
      const f = document.querySelector('.webiIframe.webiIframeV2Layout');
      if (!f) return;
      Object.assign(f.style, { width: '', height: '', transform: '', transformOrigin: '' });
      const w = f.offsetWidth, h = f.offsetHeight;
      if (!w || w >= 768) return;
      const k = w / 768;
      Object.assign(f.style, { width: '768px', height: h / k + 'px', transform: `scale(${k})`, transformOrigin: '0 0' });
    };
    let fitQueued = false;
    const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitTrackFrame(); }); } };
    addEventListener('resize', queueFit);
    new MutationObserver(() => { renameArtist(); queueFit(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    renameArtist();
    queueFit();

    // Download progress from the Rust side, shown over the player bar.
    window.__downloadStatus = msg => {
      const t = document.querySelector('.pocToast') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'pocToast', role: 'status' }));
      t.textContent = msg;
      clearTimeout(t.hideTimer);
      t.hideTimer = setTimeout(() => t.remove(), /…$/.test(msg) ? 60000 : 5000);
    };
  }
  // WebView2 runs this before <html> exists, WebKit before <body>.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
