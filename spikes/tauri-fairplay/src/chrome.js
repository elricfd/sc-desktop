// Our window bar and settings panel over soundcloud.com itself (the default
// "hybrid" mode), as the Electron app does it: SoundCloud's page stays as it
// is, pushed down under our 32px bar, with a few tweaks. The bar is
// custom.html's (from the Electron app's src/header); the settings come from
// Rust (window.__settings / __lastfm, refreshed by "chrome:ready").
// Main frame only.
(() => {
  if (window.top !== window || window.__pocChrome) return;
  window.__pocChrome = true;
  const isMac = /Mac/.test(navigator.platform), isWin = /Win/.test(navigator.platform), isLinux = /Linux/.test(navigator.platform);
  const post = m => window.ipc?.postMessage(m);
  // The init script has the settings of the app's launch; after a change and
  // a full reload Rust answers "chrome:ready" with the saved ones.
  let state = [window.__settings || {}, window.__lastfm || { connected: false }];
  window.__chromeState = (...s) => { state = s; };
  post('chrome:ready');
  // A new tab stays off the window until SoundCloud's content has rendered;
  // this says when (Rust shows it after 5 s regardless).
  const drawn = (n = 0) => { const c = document.getElementById('content'); if (c && c.offsetHeight > 400) post('tab:drawn'); else if (n < 50) setTimeout(drawn, 100, n + 1); };
  drawn();

  const css = `
    /* ---- SoundCloud under our bar: in-flow content via the body's padding,
       its fixed parts one by one. ---- */
    body { padding-top: 32px !important; box-sizing: border-box; }
    header.header.fixed { top: 32px !important; }
    .modal { top: 32px !important; height: calc(100% - 32px) !important; }
    .modal .modal__header.hovering { top: 32px !important; }
    .dropbar { top: 78px !important; }
    #gritter-notice-wrapper { top: 92px !important; }
    .fullScreenOverlay { top: 32px !important; height: auto !important; bottom: 0 !important; }
    /* (an iframe doesn't stretch between top and bottom: height auto is 150px) */
    .webiIframe.webiIframeV2Layout.fullScreen { top: 32px !important; height: calc(100vh - 32px) !important; }
    .headerMenu.moreMenu, .headerMenu.profileMenu { max-height: calc(100vh - 78px) !important; }
    /* The avatar menu is the account menu: no Artist Pro/Benefits/Distribute,
       and Support/Subscription/Settings/Sign out move into it from the more menu (see below). */
    .profileMenu li:has(a[href*="checkout.soundcloud.com"], a[href*="artists.soundcloud.com"]),
    .moreMenu li:has(a[href^="https://help.soundcloud.com"]), .moreMenu ul:has(a[href="/logout"]) { display: none !important; }
    /* No three-dots menu (its account items are under the avatar, which goes
       far right); the avatar items still open it, invisibly, to click its links. */
    .header__right > .header__navMenu:has(.header__moreButton) { display: none !important; }
    .dropdownMenu:has(.moreMenu) { opacity: 0 !important; pointer-events: none !important; }
    .header__userNavUsernameButton { order: 1; margin-left: 8px; }
    .pocAccountRow { display: flex !important; align-items: center; gap: 8px; }
    .pocAccountAvatar { flex: none; width: 20px; height: 20px; border-radius: 50%; object-fit: cover; background: rgba(128, 128, 128, .3); }
    .pocAccountPlus { display: flex; align-items: center; justify-content: center; background: none !important; font-size: 18px; line-height: 1; }
    .pocAccountName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pocAccountCheck { flex: none; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; opacity: .7; }
    .pocAccountRemove { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit; font-size: 15px; line-height: 1; opacity: .5; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .pocAccountRemove:hover { opacity: 1; background: rgba(128, 128, 128, .2); }
    .pocAccountRemove.confirm { width: auto; padding: 0 6px; font-size: 12px; opacity: 1; color: #f50; }
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
    /* Under 960 px the page scrolled sideways: the right sidebar goes, the feed fills the window. */
    @media (max-width: 959px) {
      #app .l-container { width: auto !important; }
      .l-fluid-fixed .l-sidebar-right { display: none; }
      .l-fluid-fixed .l-main { margin-right: 0; padding-left: 16px; padding-right: 16px; }
    }
    /* A track's plays/comments sat over its buttons (more of them with ours): they wrap below instead. */
    .sound__footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; column-gap: 8px; }
    .sound__footer .sound__soundActions { float: none; }
    .sound__footer .sound__footerRight { position: static; margin-left: auto; }

    /* ---- Title bar: the Electron app's header (src/header/header.css), under
       a transparent macOS title bar; the traffic lights sit in the 80px on the left. ---- */
    .pocTitlebar { --poc-bg: #121212; --poc-text: #fff; --poc-hover: rgba(255, 255, 255, .1);
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000; display: grid; grid-template-columns: minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr); align-items: center; height: 32px; background: var(--poc-bg); color: var(--poc-text); user-select: none; -webkit-user-select: none; font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    html.poc-oled .pocTitlebar { --poc-bg: #000; }
    /* The page's scrollbar would run behind our bar and the player: ours runs between them. */
    html { scrollbar-width: none; }
    .pocScroll { display: none; position: fixed; right: 2px; z-index: 2147482999; width: 8px; border-radius: 4px; background: rgba(255, 255, 255, .3); opacity: 0; transition: opacity .3s; }
    html.theme-light .pocScroll { background: rgba(0, 0, 0, .3); }
    .pocScroll.on, .pocScroll:hover, .pocScroll.drag { opacity: 1; transition: none; }
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
    .pocTitlebar .tab-group { min-width: 0; max-width: 100%; display: flex; align-items: center; gap: 2px; height: 22px; padding: 2px; border-radius: 8px; background: var(--poc-hover); }
    .pocTitlebar .tab { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; width: 150px; min-width: 28px; height: 22px; padding: 0 6px; border-radius: 6px; overflow: hidden; opacity: .7; cursor: default; transition: background-color .15s, opacity .15s; }
    .pocTitlebar .tab:hover { opacity: 1; background: var(--poc-hover); }
    .pocTitlebar .tab.active { flex: 0 1 auto; width: 320px; max-width: 100%; min-width: 150px; opacity: 1; background: var(--poc-hover); cursor: text; }
    .pocTitlebar .tab-close { display: none; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: default; }
    .pocTitlebar .tab-close:hover { background: var(--poc-hover); }
    .pocTitlebar .tab:hover .tab-close, .pocTitlebar .tab.active .tab-close { display: flex; }
    .pocTitlebar .tab-group.single .tab-close { display: none; } /* the last tab is the window */
    .pocTitlebar .tab.editing .tab-close { display: none; }
    .pocTitlebar .pocNewTab { flex: none; margin: 0 0 0 4px; width: 24px; }
    .pocTitlebar .tab-icon { flex: none; width: 16px; height: 16px; border-radius: 3px; }
    .pocTitlebar .tab-icon:not([src]) { visibility: hidden; }
    .pocTitlebar .tab-title, .pocTitlebar .tab-path { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
    .pocTitlebar .tab-title { flex: 1 1 auto; }
    .pocTitlebar .tab.active .tab-title { flex: 0 1 auto; }
    .pocTitlebar .tab-path { flex: 1 1 0; opacity: .5; }
    /* The tab doubles as the URL bar (Electron header.js editUrl). */
    .pocTitlebar .tab-url { display: none; flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
    .pocTitlebar .tab.editing .tab-title, .pocTitlebar .tab.editing .tab-path { display: none; }
    .pocTitlebar .tab.editing .tab-url { display: block; }
    .pocTitlebar .pocSearch { display: flex; align-items: center; gap: 6px; width: 198px; min-width: 80px; flex: 0 1 198px; height: 22px; margin: 0 8px 0 0; padding: 0 8px; border-radius: 6px; background: var(--poc-hover); }
    .pocTitlebar .pocSearch input { flex: 1; min-width: 0; height: auto; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; box-shadow: none; }
    .pocTitlebar .pocSearch svg { flex: none; opacity: .6; }
    .pocTitlebar .pocSearch { position: relative; }
    /* WebKitGTK draws a type=search field as its own box, clear button and focus ring: ours is the only box */
    .pocTitlebar .pocSearch input { -webkit-appearance: none; appearance: none; box-shadow: none; }
    .pocTitlebar .pocSearch input:focus { outline: none; box-shadow: none; }
    .pocTitlebar .pocSearch input::-webkit-search-cancel-button, .pocTitlebar .pocSearch input::-webkit-search-decoration { -webkit-appearance: none; display: none; }
    html.poc-nodl .pocDownload { display: none !important; }
    .pocSuggest { display: none; position: absolute; top: 28px; right: 0; width: min(380px, calc(100vw - 16px)); max-height: calc(100vh - 48px); overflow-y: auto; padding: 4px 0; border: 1px solid rgba(255, 255, 255, .1); border-radius: 8px; background: #1a1a1a; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); font: 13px Söhne, system-ui, -apple-system, 'Segoe UI', sans-serif; /* SoundCloud's own font */ cursor: default; }
    html.poc-oled .pocSuggest { background: #000; }
    html.theme-light .pocSuggest { border-color: rgba(0, 0, 0, .12); background: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, .15); }
    .pocSuggest.open { display: block; }
    .pocSuggestHead { padding: 10px 12px 4px; font-weight: 600; line-height: 1.2; opacity: .65; }
    .pocSuggestRow { display: flex; align-items: center; gap: 10px; padding: 5px 12px; color: inherit !important; text-decoration: none !important; }
    .pocSuggestRow:hover, .pocSuggestRow.active { background: var(--poc-hover); }
    .pocSuggestRow img { flex: none; width: 32px; height: 32px; border-radius: 3px; object-fit: cover; background: var(--poc-hover); }
    .pocSuggestRow img.round { border-radius: 50%; }
    .pocSuggestIcon { flex: none; width: 32px; height: 16px; background: currentColor; opacity: .5; -webkit-mask: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" stroke="black" stroke-width="1.5" fill="none"/><path d="M10.5 10.5 14 14" stroke="black" stroke-width="1.5" stroke-linecap="round"/></svg>') center / 16px no-repeat; }
    .pocTitlebar .pocDlBtn { position: relative; }
    .pocTitlebar .pocDlBtn[hidden] { display: none; }
    .pocDlBadge { position: absolute; top: 0; right: 2px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: #f50; color: #fff; font: 600 9px/13px -apple-system, sans-serif; text-align: center; }
    .pocDownloads { --dl-bg: #1a1a1a; --dl-line: rgba(255, 255, 255, .1); --dl-hover: rgba(255, 255, 255, .08); position: fixed; top: 36px; right: 8px; z-index: 2147483001; width: min(400px, calc(100vw - 16px)); max-height: min(480px, calc(100vh - 48px)); display: flex; flex-direction: column; border: 1px solid var(--dl-line); border-radius: 10px; background: var(--dl-bg); color: #fff; box-shadow: 0 10px 30px rgba(0, 0, 0, .45); font: 13px/1.35 Söhne, system-ui, -apple-system, 'Segoe UI', sans-serif; }
    html.poc-oled .pocDownloads { --dl-bg: #000; }
    html.theme-light .pocDownloads { --dl-bg: #fff; --dl-line: rgba(0, 0, 0, .12); --dl-hover: rgba(0, 0, 0, .05); color: #222; box-shadow: 0 10px 30px rgba(0, 0, 0, .15); }
    .pocDownloads[hidden] { display: none; }
    .pocDownloads header { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 8px 14px; border-bottom: 1px solid var(--dl-line); font-size: 14px; }
    .pocDownloads button { margin-left: 4px; padding: 3px 8px; border: 1px solid var(--dl-line); border-radius: 6px; background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
    .pocDownloads button:hover { background: var(--dl-hover); }
    .pocDlList { overflow-y: auto; }
    .pocDlEmpty { padding: 14px; opacity: .6; font-size: 12px; }
    .pocDlList:not(:empty) + .pocDlEmpty { display: none; }
    .pocDlRow { padding: 10px 12px 10px 14px; border-bottom: 1px solid var(--dl-line); }
    .pocDlHead { display: flex; align-items: center; gap: 6px; }
    .pocDlHead .pocDlArrow { flex: none; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin: 0 0 0 -6px; padding: 0; border: 0; }
    .pocDlArrow svg { transition: transform .15s; }
    .pocDlArrow.open svg { transform: rotate(90deg); }
    .pocDlTitle { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
    .pocDlDetail { margin-top: 3px; font-size: 12px; opacity: .65; }
    .pocDlRow progress, .pocDlTrack progress { width: 100%; height: 4px; margin-top: 6px; -webkit-appearance: none; appearance: none; border: 0; border-radius: 2px; background: var(--dl-line); overflow: hidden; }
    .pocDlRow progress::-webkit-progress-bar { background: var(--dl-line); }
    .pocDlRow progress::-webkit-progress-value { background: #f50; }
    .pocDlRow.error .pocDlDetail { color: #ff6b6b; opacity: 1; }
    .pocDlLow { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 4px; background: rgba(255, 85, 0, .18); color: #ff7a33; font-size: 11px; font-weight: 600; }
    .pocDlTracks { margin: 8px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--dl-line); }
    .pocDlTrack { display: grid; grid-template-columns: 22px 1fr auto auto; align-items: center; column-gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--dl-line); font-size: 12px; }
    .pocDlTrack:last-child { border-bottom: 0; }
    .pocDlTrack .n { opacity: .5; text-align: right; }
    .pocDlTrack .t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .pocDlTrack .s { opacity: .65; white-space: nowrap; }
    .pocDlTrack.skipped .s, .pocDlTrack.failed .s { color: #ff6b6b; opacity: .9; }
    .pocDlTrack.waiting { opacity: .55; }
    .pocDlTrack progress { grid-column: 2 / 5; margin-top: 3px; }
    .pocDlTrack .show { margin: 0 0 0 2px; padding: 1px 6px; font-size: 11px; }
    .pocSuggestText { display: flex; flex-direction: column; min-width: 0; }
    .pocSuggestTitle, .pocSuggestSub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .pocSuggestSub { font-size: 12px; opacity: .6; }
    /* Windows (Electron header's platform-win32 layout): no traffic lights;
       window buttons at the far right of a frameless window, resized from its edges. */
    .pocTitlebar .window-controls, .pocEdge { display: none; }
    /* Linux in a browser's app window: its frame and buttons, and one tab */
    html.host-frame .pocTitlebar .window-controls, html.host-frame .pocEdge, html.host-frame .pocNewTab { display: none !important; }
    html.platform-win .pocTitlebar .header-side:first-child { padding-left: 8px; }
    /* a row, not the centred grid: when narrow, the search box gives way first, then the tab */
    html.platform-win .pocTitlebar { display: flex; }
    html.platform-win .pocTitlebar .header-side:first-child { flex: none; }
    html.platform-win .pocTitlebar .header-center { flex: 0 1 auto; }
    html.platform-win .pocTitlebar .header-side:last-child { flex: 1 6 auto; min-width: min-content; }
    html.platform-win .pocTitlebar .nav-button { flex: none; }
    html.platform-win .pocTitlebar .pocSearch { width: auto; }
    html.platform-win .pocTitlebar .pocSearch input { width: 100%; min-width: 0; }
    html.platform-win .pocTitlebar .tab-group { overflow: hidden; }
    html.platform-win .pocTitlebar .tab.active { min-width: 90px; }
    html.platform-win .pocTitlebar .header-side:first-child .title-bar { flex: 0 0 8px; min-width: 8px; }
    html.platform-win .pocTitlebar .header-side:last-child { padding-right: 0; }
    html.platform-win .pocTitlebar .window-controls { display: flex; align-self: stretch; margin-left: 4px; }
    .pocTitlebar .window-controls button { width: 46px; height: 100%; padding: 0; border: 0; background: transparent; color: var(--poc-text); font: 10px/1 'Segoe Fluent Icons', 'Segoe MDL2 Assets'; cursor: default; }
    /* Linux has no Segoe icon font: drawn icons instead */
    .pocTitlebar .window-controls button svg { display: block; margin: auto; }
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
      position: fixed; top: 32px; right: 0; bottom: 0; z-index: 2147483001; width: min(380px, 100vw); display: flex; flex-direction: column; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--text-primary); background: var(--bg-primary); border-left: 1px solid var(--border); user-select: none; -webkit-user-select: none; -webkit-font-smoothing: antialiased;
      opacity: 0; transform: translateX(16px); pointer-events: none; transition: opacity .15s, transform .15s; }
    html.poc-oled .pocSettings { --bg-primary: #000; --bg-secondary: #1a1a1a; }
    html.theme-light .pocSettings { --bg-primary: #fff; --bg-secondary: #f3f3f3; --bg-hover: rgba(0, 0, 0, .06); --text-primary: #222; --text-secondary: rgba(0, 0, 0, .6); --border: rgba(0, 0, 0, .12); --track: rgba(0, 0, 0, .2); }
    .pocSettings.visible { opacity: 1; transform: none; pointer-events: auto; }
    .pocSettings * { box-sizing: border-box; margin: 0; padding: 0; }
    .pocSettings .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 6px 20px; }
    .pocSettings h1 { font-size: 18px; font-weight: 600; }
    .pocSettings .close-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
    .pocSettings .close-btn:hover { background: var(--bg-hover); }
    .pocSettings nav { display: flex; gap: 16px; padding: 8px 20px 0; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
    .pocSettings nav button { flex: none; white-space: nowrap; }
    .pocSettings nav button { padding: 6px 0 8px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-secondary); font: inherit; font-size: 14px; cursor: pointer; }
    .pocSettings nav button.active { color: var(--text-primary); border-bottom-color: var(--accent); }
    .pocSettings main { flex: 1; min-height: 0; overflow-y: auto; padding: 0 20px 20px; }
    .pocSettings h2 { padding: 14px 0 6px; color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
    .pocSettings .pocAccountsList { margin: 0; padding: 0; list-style: none; }
    .pocSettings .pocAccountsItem { min-height: 36px; padding: 6px 8px; margin: 0 -8px; border-radius: 6px; color: inherit; text-decoration: none; cursor: pointer; }
    .pocSettings .pocAccountsItem:hover { background: var(--bg-hover); }
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
        <div class="tab-group single"><div class="tab active"><img class="tab-icon" alt=""><span class="tab-title"></span><span class="tab-path"></span><input class="tab-url" spellcheck="false" aria-label="Address"><button type="button" class="tab-close" title="Close Tab" aria-label="Close Tab">${icon('M11 5L5 11m6 0L5 5')}</button></div></div>
          <div class="nav-button pocNewTab" data-cmd="newtab" title="New Tab">${icon('M8 3.5v9M3.5 8h9')}</div>
      </div>
      <div class="header-side">
        <div class="title-bar"></div>
        <form class="pocSearch"><svg width="12" height="12" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><input name="q" type="search" placeholder="Search" autocomplete="off" aria-label="Search"></form>
        <div class="nav-button pocDlBtn" data-cmd="downloads" title="Downloads">${icon('M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10')}<span class="pocDlBadge" hidden></span></div>
        <div class="nav-button" data-cmd="settings" title="Settings">${icon('M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5')}</div>
        <div class="window-controls"><button type="button" class="minimize" title="Minimize" aria-label="Minimize">&#xE921;</button><button type="button" class="maximize" title="Maximize" aria-label="Maximize">&#xE922;</button><button type="button" class="close" title="Close" aria-label="Close">&#xE8BB;</button></div>
      </div>
    </div>
    ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(e => `<div class="pocEdge" data-edge="${e}"></div>`).join('')}
    <aside class="pocSettings" aria-label="Settings">
      <header class="panel-header"><h1>Settings</h1><button class="close-btn" title="Close">${icon('M12 4L4 12m8 0L4 4')}</button></header>
      <nav>
        <button data-tab="general" class="active">General</button>
        <button data-tab="downloads">Downloads</button>
        <button data-tab="integrations">Integrations</button>
        <button data-tab="advanced">Advanced</button>
      </nav>
      <main>
        <section data-tab="general"><h2>Accounts</h2>
          <ul class="pocAccountsList"></ul>
          <p class="hint">Each account signs in separately; switching restarts the app.</p>
          <h2>Window</h2>
          <label class="row"><span>Back and forward buttons</span><span class="toggle"><input type="checkbox" data-setting="navButtons"><span class="slider"></span></span></label>
          <label class="row"><span>Minimize to tray</span><span class="toggle"><input type="checkbox" data-setting="minimizeToTray"><span class="slider"></span></span></label>
          <p class="hint">Closing the window keeps SoundCloud playing in the tray.</p>
          <h2>Theme</h2>
          <div class="row"><span>Theme</span><select data-setting="theme"><option value="dark">Dark</option><option value="oled">OLED (true black)</option><option value="light">Light</option><option value="system">Match system</option></select></div></section>
        <section data-tab="downloads" hidden><h2>Downloads</h2>
          <label class="field"><span>Folder</span><input class="textInput" data-setting="downloadFolder" placeholder="Your Downloads folder" spellcheck="false"></label>
          <div class="buttons"><button class="btn" data-dl-open>Open folder</button></div>
          <label class="row"><span>Download buttons</span><span class="toggle"><input type="checkbox" data-setting="downloadButton"><span class="slider"></span></span></label>
          <p class="hint">Off hides them under tracks, albums and playlists and in the window bar.</p>
          <label class="row"><span>Download with my account</span><span class="toggle"><input type="checkbox" data-setting="downloadUseAccount"><span class="slider"></span></span></label>
          <p class="hint">Signed in, Go+ tracks download in full; off, they come as 30-second previews.</p>
          <label class="field"><span>File name</span><input class="textInput" data-setting="downloadTemplate" placeholder="%(uploader)s - %(title)s.%(ext)s" spellcheck="false"></label>
          <label class="field"><span>Album and playlist folder</span><input class="textInput" data-setting="downloadPlaylistFolder" placeholder="%(playlist_uploader)s - %(playlist_title)s" spellcheck="false"></label>
          <p class="hint">yt-dlp output templates; empty uses the default shown.</p></section>
        <section data-tab="integrations" hidden><h2>Discord</h2>
          <label class="row"><span>Discord Rich Presence</span><span class="toggle"><input type="checkbox" data-setting="discord"><span class="slider"></span></span></label>
          <p class="hint">Shows the track you're playing on your Discord profile.</p>
          <h2>Last.fm</h2>
          <label class="row"><span>Scrobble to Last.fm</span><span class="toggle"><input type="checkbox" data-setting="lastfm"><span class="slider"></span></span></label>
          <div data-lfm="setup">
            <p class="hint">Uses your own Last.fm API account: <a class="link" data-external="https://www.last.fm/api/account/create">create one</a>, then paste its key and shared secret. The secret is kept in your ${isWin ? 'Windows Credential Manager' : isLinux ? 'system keyring' : 'macOS Keychain'}.</p>
            <label class="field"><span>API key</span><input class="textInput" data-lfm="key" autocomplete="off" spellcheck="false"></label>
            <label class="field"><span>Shared secret</span><input class="textInput" data-lfm="secret" type="password" autocomplete="off"></label>
            <div class="buttons"><button class="btn primary" data-lfm="connect">Connect Last.fm</button></div>
          </div>
          <div data-lfm="connected" hidden><div class="row"><span>Connected as <b data-lfm="name"></b></span><button class="btn danger" data-lfm="disconnect">Disconnect</button></div></div>
          <p class="hint" data-lfm="status"></p></section>
        <section data-tab="advanced" hidden><h2>Privacy</h2>
          <label class="row"><span>Block ads and trackers</span><span class="toggle"><input type="checkbox" data-setting="adblock"><span class="slider"></span></span></label>
          <p class="hint">Takes effect the next time the app starts.</p>
          <h2>Updates</h2>
          <label class="row"><span>Automatic updates</span><span class="toggle"><input type="checkbox" data-setting="autoUpdate"><span class="slider"></span></span></label>
          <p class="hint">Downloads new versions in the background and installs them when you quit. <span class="pocVersion"></span></p></section>
      </main>
    </aside>
    <aside class="pocDownloads" hidden>
      <header><b>Downloads</b><span><button type="button" data-dl="open-folder">Open folder</button><button type="button" data-dl="clear">Clear</button><button type="button" data-dl="close" title="Close" aria-label="Close">×</button></span></header>
      <div class="pocDlList"></div>
      <p class="pocDlEmpty">Use the download button under a track, album or playlist. Downloads need yt-dlp (${isWin ? 'winget install yt-dlp' : isLinux ? 'from your package manager, or pip install yt-dlp' : 'brew install yt-dlp'}); with ffmpeg too, files get their cover and tags.</p>
    </aside>`;

  // SoundCloud's router follows pushState + popstate (the Electron app's
  // navigateActiveTab); a real load would stop whatever is playing.
  // Upload's X asks for /artists whatever page you came from: go back there
  // instead. (Registered before SoundCloud's own listener, so it wins.)
  addEventListener('message', e => {
    if (e.origin !== location.origin || e.data?.kind !== 'navigate' || e.data.href !== '/artists' || location.pathname !== '/upload') return;
    if (window.navigation && !navigation.canGoBack) return;
    e.stopImmediatePropagation();
    history.back();
  }, true);

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

    // --- Page scrollbar from under our bar to above the player; shows while
    // scrolling or hovered, as an overlay scrollbar would, and drags.
    const thumb = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'pocScroll' }));
    let fade;
    const scrollGeometry = () => {
      const player = document.querySelector('.playControls__inner');
      const bottom = player ? Math.max(0, innerHeight - player.getBoundingClientRect().top) : 0;
      const track = innerHeight - 32 - bottom, total = document.documentElement.scrollHeight;
      const size = Math.max(32, track * innerHeight / total);
      return { track, size, max: total - innerHeight };
    };
    const drawScroll = flash => {
      const { track, size, max } = scrollGeometry();
      thumb.style.display = max > 1 && track > size ? 'block' : 'none';
      thumb.style.top = 32 + (track - size) * Math.min(1, scrollY / max) + 'px';
      thumb.style.height = size + 'px';
      if (flash === true) { thumb.classList.add('on'); clearTimeout(fade); fade = setTimeout(() => thumb.classList.remove('on'), 1000); }
    };
    addEventListener('scroll', () => drawScroll(true), { passive: true });
    addEventListener('resize', drawScroll);
    new ResizeObserver(() => drawScroll()).observe(document.body);
    thumb.addEventListener('pointerdown', e => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add('drag');
      const { track, size, max } = scrollGeometry(), y0 = e.clientY, s0 = scrollY;
      const move = m => scrollTo(scrollX, s0 + (m.clientY - y0) * max / (track - size));
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', () => { thumb.removeEventListener('pointermove', move); thumb.classList.remove('drag'); }, { once: true });
    });
    const bar = document.querySelector('.pocTitlebar'), panel = document.querySelector('.pocSettings');
    const $ = (sel, el = bar) => el.querySelector(sel);
    const tab = $('.tab'), urlInput = $('.tab-url'), search = $('.pocSearch');
    let lastInfo = '';

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
      const info = JSON.stringify({ title, path, icon: fav || '' });
      if (info !== lastInfo) { lastInfo = info; post('tab:info:' + info); }
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
      newtab: () => window.__hostFrame || post('tab:new'),
    };

    // --- Tabs: main.rs keeps one page per tab and shows one. This page's tab
    // is the shown one; the others come from __tabs, as their bars reported them.
    const myId = window.__tabId ?? 0, group = $('.tab-group');
    window.__tabs = ({ tabs }) => {
      group.classList.toggle('single', tabs.length < 2);
      group.replaceChildren(...tabs.map(t => {
        if (t.id === myId) return tab;
        const el = Object.assign(document.createElement('div'), { className: 'tab', title: t.info.title || '' });
        el.dataset.id = t.id;
        el.innerHTML = `<img class="tab-icon" alt=""><span class="tab-title"></span><button type="button" class="tab-close" title="Close Tab" aria-label="Close Tab">${icon('M11 5L5 11m6 0L5 5')}</button>`;
        if (t.info.icon) el.querySelector('.tab-icon').src = t.info.icon;
        el.querySelector('.tab-title').textContent = t.info.title || 'SoundCloud';
        return el;
      }));
    };
    const tabId = t => t.dataset.id ?? myId;
    // (capture: a close on this page's tab must not start editing its address)
    group.addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (!t) return;
      if (e.target.closest('.tab-close')) { e.stopPropagation(); post('tab:close:' + tabId(t)); }
      else if (t !== tab) post('tab:switch:' + t.dataset.id);
    }, true);
    // middle-click closes a tab
    group.addEventListener('auxclick', e => {
      const t = e.target.closest('.tab');
      if (e.button === 1 && t && !group.classList.contains('single')) { e.preventDefault(); post('tab:close:' + tabId(t)); }
    });
    // Middle- or Ctrl/Cmd-click on a SoundCloud link opens it in a background
    // tab; other sites go to the browser (main.rs's new-window handler).
    const openInTab = e => {
      const a = e.target.closest?.('a[href]');
      if (!a || !(e.type === 'auxclick' ? e.button === 1 : e.button === 0 && (isMac ? e.metaKey : e.ctrlKey))) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      post('tab:open:' + url.href);
    };
    bar.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (b) commands[b.dataset.cmd](); });
    // Mouse back/forward buttons.
    addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.button === 3 ? history.back() : history.forward(); } });

    // Drag the window from empty bar space, double-click to zoom.
    bar.addEventListener('mousedown', e => {
      if (e.button !== 0 || window.__hostFrame || e.target.closest('.nav-button, .tab-group, .pocSearch, .window-controls')) return;
      post(e.detail === 2 ? 'zoom' : 'drag');
    });

    // Windows and Linux: our own window buttons and resize edges; Rust drops
    // the native frame only once told they exist. macOS keeps its traffic lights.
    if (isWin || isLinux) {
      document.documentElement.classList.add('platform-win');
      document.documentElement.classList.toggle('host-frame', !!window.__hostFrame);
      const glyphs = { minimize: 'M3.5 8h9', maximize: 'M4 4h8v8H4z', restore: 'M4 6h6v6H4zM6 6V4h6v6h-2', close: 'M12 4L4 12m8 0L4 4' };
      // (no tooltips on Linux: its own window buttons have none)
      if (isLinux) for (const k of ['minimize', 'maximize', 'close']) { $('.' + k).innerHTML = icon(glyphs[k]); $('.' + k).removeAttribute('title'); }
      $('.minimize').onclick = () => post('minimize');
      $('.maximize').onclick = () => post('zoom');
      $('.close').onclick = () => post('close');
      for (const edge of document.querySelectorAll('.pocEdge')) edge.addEventListener('mousedown', e => {
        if (e.button === 0) { e.preventDefault(); post('resize:' + edge.dataset.edge); }
      });
      window.__windowState = ({ maximized }) => {
        document.documentElement.classList.toggle('maximized', maximized);
        if (isLinux) $('.maximize').innerHTML = icon(maximized ? glyphs.restore : glyphs.maximize);
        else $('.maximize').textContent = maximized ? '' : '';
        if (!isLinux) $('.maximize').title = maximized ? 'Restore' : 'Maximize';
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

    // --- Suggestions while typing: matches in your own library first (likes,
    // your tracks, liked and created playlists, followings, reposts), then
    // SoundCloud's results and query suggestions, as its own search box does.
    const apiGet = async path => {
      const cid = window.__sc_hydration?.find(x => x.hydratable === 'apiClient')?.data?.id;
      const tok = document.cookie.split('; ').find(c => c.startsWith('oauth_token='))?.slice(12);
      const u = new URL(path, 'https://api-v2.soundcloud.com/');
      if (cid) u.searchParams.set('client_id', cid);
      const r = await fetch(u, { headers: tok ? { Authorization: 'OAuth ' + tok } : {} });
      if (!r.ok) throw new Error(u.pathname + ' ' + r.status);
      return r.json();
    };
    const toItem = (o, src) => {
      if (!o?.permalink_url) return null;
      const user = o.kind === 'user';
      return { title: user ? o.username : o.title, sub: [src, user ? '' : o.user?.username].filter(Boolean).join(' · '), user,
        art: (o.artwork_url || o.avatar_url || o.user?.avatar_url || '').replace('-large.', '-t50x50.'), path: new URL(o.permalink_url).pathname };
    };
    const library = new Map(); // path -> item, filled in the background on first focus
    let libraryAt = 0;
    const loadLibrary = () => {
      const me = window.__sc_hydration?.find(x => x.hydratable === 'meUser')?.data;
      if (!me || Date.now() - libraryAt < 10 * 60e3) return;
      libraryAt = Date.now();
      const sources = [
        [`users/${me.id}/tracks`, x => [x, 'Your track']],
        [`users/${me.id}/playlists`, x => [x, x.is_album ? 'Your album' : 'Your playlist']],
        ['me/library/all', x => [x.playlist || x.system_playlist, /like/.test(x.type) ? 'Liked' : 'Yours']],
        [`users/${me.id}/track_likes`, x => [x.track, 'Liked']],
        [`users/${me.id}/followings`, x => [x, 'Following']],
        [`stream/users/${me.id}/reposts`, x => [x.track || x.playlist, 'Reposted']],
      ];
      for (const [path, pick] of sources) (async () => {
        // Note: whole library in memory, capped at 50 pages (10k items) a source.
        let next = path + '?limit=200&linked_partitioning=1';
        for (let n = 0; next && n < 50; n++) {
          const page = await apiGet(next).catch(() => null);
          if (!page) return;
          for (const x of page.collection || []) { const it = toItem(...pick(x)); if (it && !library.has(it.path)) library.set(it.path, it); }
          next = page.next_href;
          if (suggest.classList.contains('open')) renderSuggest();
        }
      })();
    };
    const matchLibrary = q => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean), out = [];
      for (const it of library.values()) {
        const t = it.title.toLowerCase(), hay = t + ' ' + it.sub.toLowerCase();
        if (words.every(w => hay.includes(w))) out.push([t.startsWith(words[0]) ? 0 : t.includes(' ' + words[0]) ? 1 : 2, it]);
      }
      return out.sort((a, b) => a[0] - b[0]).slice(0, 6).map(x => x[1]);
    };
    const suggest = search.appendChild(Object.assign(document.createElement('div'), { className: 'pocSuggest', role: 'listbox' }));
    let remote = { q: '', items: [], queries: [] }, remoteTimer, remoteSeq = 0;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
    const row = (path, title, sub, art, round) => {
      const a = el('a', 'pocSuggestRow');
      a.dataset.path = path;
      a.append(art === null ? el('span', 'pocSuggestIcon') : Object.assign(el('img', round ? 'round' : ''), art ? { src: art } : {}));
      const text = a.appendChild(el('span', 'pocSuggestText'));
      text.append(el('span', 'pocSuggestTitle', title));
      if (sub) text.append(el('span', 'pocSuggestSub', sub));
      return a;
    };
    function renderSuggest() {
      const q = search.q.value.trim();
      suggest.replaceChildren();
      if (!q) return suggest.classList.remove('open');
      suggest.append(row('/search?q=' + encodeURIComponent(q), `Search for “${q}”`, '', null));
      const mine = matchLibrary(q), seen = new Set(mine.map(it => it.path));
      const section = (label, items) => { if (items.length) { suggest.append(el('div', 'pocSuggestHead', label)); items.forEach(it => suggest.append(it)); } };
      section('In your library', mine.map(it => row(it.path, it.title, it.sub, it.art, it.user)));
      if (remote.q === q) {
        section('On SoundCloud', remote.items.filter(it => !seen.has(it.path)).map(it => row(it.path, it.title, it.sub, it.art, it.user)));
        section('Suggestions', remote.queries.filter(s => s.toLowerCase() !== q.toLowerCase()).slice(0, 4).map(s => row('/search?q=' + encodeURIComponent(s), s, '', null)));
      }
      suggest.classList.add('open');
    }
    const fetchRemote = q => {
      const seq = ++remoteSeq, e = encodeURIComponent(q);
      Promise.all([apiGet(`search?q=${e}&limit=6`).catch(() => ({})), apiGet(`search/queries?q=${e}&limit=6`).catch(() => ({}))]).then(([r, s]) => {
        if (seq !== remoteSeq) return;
        remote = { q, items: (r.collection || []).map(o => toItem(o, o.kind === 'user' ? 'Profile' : o.kind === 'playlist' ? (o.is_album ? 'Album' : 'Playlist') : '')).filter(Boolean), queries: (s.collection || []).map(x => x.output) };
        renderSuggest();
      });
    };
    search.q.addEventListener('focus', () => { loadLibrary(); renderSuggest(); });
    search.q.addEventListener('input', () => {
      renderSuggest();
      clearTimeout(remoteTimer);
      const q = search.q.value.trim();
      if (q) remoteTimer = setTimeout(() => fetchRemote(q), 150);
    });
    search.q.addEventListener('blur', () => suggest.classList.remove('open'));
    search.q.addEventListener('keydown', e => {
      const rows = [...suggest.querySelectorAll('.pocSuggestRow')], i = rows.findIndex(r => r.classList.contains('active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        rows[i]?.classList.remove('active');
        const n = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - (i < 0 ? 0 : 1))) % rows.length];
        n?.classList.add('active'); n?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); pickRow(rows[i]); }
    });
    const pickRow = r => { go(r.dataset.path); search.q.blur(); };
    suggest.addEventListener('mousedown', e => e.preventDefault()); // keep the input's focus
    suggest.addEventListener('click', e => { const r = e.target.closest('.pocSuggestRow'); if (r) pickRow(r); });
    // Typing in our fields must not reach SoundCloud's single-key shortcuts (L likes, R reposts…).
    for (const el of [bar, panel]) for (const t of ['keydown', 'keypress', 'keyup']) el.addEventListener(t, e => e.stopPropagation());

    // --- Settings: saved by the Rust side (settings.json).
    const settings = { navButtons: true, downloadButton: true, downloadUseAccount: true, downloadFolder: '', downloadTemplate: '', downloadPlaylistFolder: '', minimizeToTray: true, autoUpdate: true, theme: 'dark', discord: true, adblock: true };
    if (window.__appVersion) panel.querySelector('.pocVersion').textContent = `This is version ${window.__appVersion}.`;
    const darkQuery = matchMedia('(prefers-color-scheme: dark)');
    function applySettings() {
      $('.navigation-controls').classList.toggle('hidden', !settings.navButtons);
      $('.pocDlBtn').hidden = !settings.downloadButton;
      document.documentElement.classList.toggle('poc-nodl', !settings.downloadButton);
      const dark = settings.theme === 'system' ? darkQuery.matches : settings.theme !== 'light';
      const oled = settings.theme === 'oled';
      document.documentElement.classList.toggle('poc-oled', oled);
      oledStyle(document, oled);
      oledStyle(document.querySelector('.webiIframe')?.contentDocument, oled);
      // SoundCloud's own theme classes, as the Electron app's applyThemeToContent sets them
      for (const el of [document.documentElement, document.body]) {
        el.classList.toggle('theme-dark', dark);
        el.classList.toggle('theme-light', !dark);
      }
      // the track page's frame takes it over SoundCloud's postMessage protocol
      document.querySelector('.webiIframe')?.contentWindow?.postMessage({ kind: 'set-theme', theme: dark ? 'dark' : 'light' }, location.origin);
    }
    // OLED: the Electron app's themes/OLED.css (window.__oledCss), in the page and the track page's frame.
    function oledStyle(doc, on) {
      if (!doc?.head) return;
      const el = doc.getElementById('pocOled');
      if (on && !el) doc.head.appendChild(Object.assign(doc.createElement('style'), { id: 'pocOled', textContent: window.__oledCss || '' }));
      else if (!on) el?.remove();
    }
    darkQuery.addEventListener('change', applySettings);
    panel.querySelector('[data-dl-open]').onclick = () => post('downloads:open-folder');
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
    window.__openSettings = () => toggleSettings(true); // the tray's Settings

    // --- Downloads (downloads.rs, yt-dlp): a button under every track,
    // album and playlist, and our panel listing each download and, for an
    // album or playlist, each of its tracks with its size and quality.
    const dlPanel = document.querySelector('.pocDownloads'), dlList = dlPanel.querySelector('.pocDlList'), dlBadge = bar.querySelector('.pocDlBadge');
    const toggleDownloads = force => {
      dlPanel.hidden = !(force ?? dlPanel.hidden);
      if (!dlPanel.hidden) post('downloads:get');
    };
    commands.downloads = () => toggleDownloads();
    const bytes = b => {
      const u = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
      return `${b.toFixed(i === 0 || b >= 100 ? 0 : 1)} ${u[i]}`;
    };
    const eta = sec => { const s = Math.round(sec); return s < 60 ? `${s}s left` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s left` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m left`; };
    const join = (...p) => p.filter(Boolean).join(' · ');
    const isActive = it => ['queued', 'downloading', 'processing'].includes(it.status);
    const make = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
    const lowBadge = q => q?.low ? make('span', 'pocDlLow', 'Low quality') : '';
    const trackState = t => ({
      waiting: 'Waiting', skipped: t.reason, failed: t.reason || 'Failed',
      downloading: t.total ? `${Math.round(100 * (t.downloaded || 0) / t.total)}%` : 'Starting…',
      done: join(t.size ? bytes(t.size) : '', t.quality?.label),
    })[t.status] || t.status;
    const expanded = new Set();
    let lastItems = [];
    window.__downloads = items => {
      lastItems = items;
      const running = items.filter(isActive).length;
      dlBadge.hidden = !running;
      dlBadge.textContent = running;
      dlList.replaceChildren(...items.map(it => {
        const row = make('div', `pocDlRow ${it.status}`);
        row.dataset.id = it.id;
        const head = row.appendChild(make('div', 'pocDlHead'));
        const many = it.tracks.length > 1;
        if (many) {
          const open = expanded.has(it.id);
          const arrow = head.appendChild(make('button', open ? 'pocDlArrow open' : 'pocDlArrow'));
          arrow.innerHTML = icon('M6 3.5 10.5 8 6 12.5');
          Object.assign(arrow, { title: open ? 'Hide the tracks' : 'Show every track' });
          arrow.dataset.dl = 'expand';
        }
        head.appendChild(make('div', 'pocDlTitle', it.title)).title = it.title;
        const file = it.tracks.some(t => t.hasFile);
        if (isActive(it) || file) head.appendChild(make('button', '', isActive(it) ? 'Cancel' : 'Show')).dataset.dl = isActive(it) ? 'cancel' : 'show';
        const done = it.tracks.filter(t => t.status === 'done'), cur = it.tracks.find(t => t.status === 'downloading');
        if (isActive(it)) {
          const progress = row.appendChild(make('progress'));
          const frac = cur?.total ? (cur.downloaded || 0) / cur.total : 0;
          if (it.tracks.length && (cur?.total || done.length)) progress.value = (done.length + frac) / it.tracks.length;
        }
        const skipped = it.tracks.filter(t => t.status === 'skipped' || t.status === 'failed');
        const low = done.filter(t => t.quality?.low).length;
        const size = done.reduce((n, t) => n + (t.size || 0), 0);
        const detail = row.appendChild(make('div', 'pocDlDetail'));
        if (it.status === 'queued') detail.textContent = 'Waiting…';
        else if (it.status === 'downloading') detail.textContent = join(many && cur ? `Track ${it.tracks.indexOf(cur) + 1} of ${it.tracks.length}` : '',
          cur?.downloaded != null ? (cur.total ? `${bytes(cur.downloaded)} of ${bytes(cur.total)}` : bytes(cur.downloaded)) : 'Starting…',
          it.speed ? `${bytes(it.speed)}/s` : '', it.eta != null ? eta(it.eta) : '');
        else if (it.status === 'processing') detail.textContent = 'Finishing…';
        else if (it.status === 'done') {
          detail.textContent = join('Done', many ? `${done.length} of ${it.tracks.length} tracks` : '', size ? bytes(size) : '', !many ? done[0]?.quality?.label : '',
            many && low ? `${low} in low quality` : '', skipped.length ? `${skipped.length} skipped (${[...new Set(skipped.map(t => t.reason))].join(', ')})` : '');
          if (!many) detail.append(lowBadge(done[0]?.quality));
        } else detail.textContent = it.status === 'cancelled' ? 'Cancelled' : it.error || 'Failed';
        if (many && expanded.has(it.id)) {
          const ol = row.appendChild(make('ol', 'pocDlTracks'));
          it.tracks.forEach((t, n) => {
            const li = ol.appendChild(make('li', `pocDlTrack ${t.status}`));
            li.append(make('span', 'n', n + 1), Object.assign(make('span', 't', t.title), { title: t.title }));
            const st = li.appendChild(make('span', 's', trackState(t)));
            st.append(lowBadge(t.quality));
            if (t.status === 'downloading' && t.total) li.appendChild(make('progress')).value = (t.downloaded || 0) / t.total;
            if (t.hasFile) Object.assign(li.appendChild(make('button', 'show', 'Show')), { title: 'Show in folder' }).dataset.dl = 'show:' + n;
          });
        }
        return row;
      }));
    };
    // pointerdown: the list is redrawn several times a second, which would
    // swallow a click whose press and release land on different redraws
    dlPanel.addEventListener('pointerdown', e => {
      const b = e.target.closest('[data-dl]');
      if (!b || e.button !== 0) return;
      e.preventDefault();
      const [what, track] = b.dataset.dl.split(':'), id = Number(b.closest('.pocDlRow')?.dataset.id);
      if (what === 'close') return toggleDownloads(false);
      if (what === 'expand') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); return window.__downloads(lastItems); }
      post(['downloads', what, ...(id ? [id] : []), ...(track ? [track] : [])].join(':'));
    });
    for (const t of ['keydown', 'keypress', 'keyup']) dlPanel.addEventListener(t, e => e.stopPropagation());

    const DL_ICON = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="16" height="16"><path d="M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // Every title of an album or playlist up front, from SoundCloud's API (its
    // playlist answer has the full track only for the first few).
    const describe = async url => {
      const o = await apiGet('resolve?url=' + encodeURIComponent(url));
      const name = t => [t.user?.username, t.title].filter(Boolean).join(' - ');
      if (o.kind !== 'playlist') return { title: name(o), tracks: [{ id: o.id, title: name(o) }] };
      const full = new Map(o.tracks.filter(t => t.title).map(t => [t.id, t]));
      const missing = o.tracks.filter(t => !t.title).map(t => t.id);
      for (let i = 0; i < missing.length; i += 50) for (const t of await apiGet('tracks?ids=' + missing.slice(i, i + 50).join(','))) full.set(t.id, t);
      // within an album or playlist, the uploader only for tracks by someone else
      const own = t => t.user?.id === o.user?.id ? t.title : name(t);
      return { title: name(o), tracks: o.tracks.map((t, n) => ({ id: t.id, title: full.has(t.id) ? own(full.get(t.id)) : `Track ${n + 1}` })) };
    };
    const startDownload = async url => {
      url = url.split(/[?#]/)[0];
      toggleDownloads(true);
      const info = await describe(url).catch(() => ({ title: '', tracks: [] }));
      const token = settings.downloadUseAccount === false ? '' : document.cookie.split('; ').find(c => c.startsWith('oauth_token='))?.slice(12) || '';
      post('download:' + JSON.stringify({ url, token, ...info }));
    };
    const addDownloadButtons = () => {
      if (!settings.downloadButton) {
        // switched off: none in the track page's frame either
        document.querySelector('.webiIframe')?.contentDocument?.querySelectorAll('.pocDownload').forEach(b => b.remove());
        return;
      }
      for (const actions of document.querySelectorAll('.soundActions:not(:has(.pocDownload))')) {
        const size = actions.classList.contains('soundActions__small') ? 'small' : 'medium';
        const b = Object.assign(document.createElement('button'), { type: 'button', title: 'Download', className: `pocDownload sc-button-secondary sc-button sc-button-${size} sc-button-icon sc-button-responsive` });
        b.setAttribute('aria-label', 'Download');
        b.innerHTML = `<div>${DL_ICON}</div>`;
        b.addEventListener('click', e => {
          e.stopPropagation();
          if (!e.isTrusted) return; // not one the page synthesized
          // the row or stream item it sits in, else the page itself when it is the player's own row
          const link = b.closest('.trackItem, .sound, .soundBadge')?.querySelector('a.trackItem__trackTitle, a.soundTitle__title');
          const url = link?.href || (b.closest('.listenEngagement') ? location.href : '');
          if (url) startDownload(url);
        });
        (actions.querySelector('.sc-button-group') || actions).append(b);
      }
      // Track pages are SoundCloud's /n/ frame, with its own action row: a
      // copy of its "Add to playlist" button (styles, not handlers) after it.
      const d = document.querySelector('.webiIframe:not(.sc-hidden)')?.contentDocument;
      const add = d && !d.querySelector('.pocDownload') && d.querySelector('button[aria-label="Add to playlist"]');
      if (add && /^\/[^/]+\/[^/]+$/.test(location.pathname)) {
        const wrap = add.parentElement.children.length === 1 ? add.parentElement : add;
        const copy = wrap.cloneNode(true), b = copy.matches('button') ? copy : copy.querySelector('button');
        b.classList.add('pocDownload');
        b.setAttribute('aria-label', 'Download');
        b.title = 'Download';
        const svg = b.querySelector('svg');
        if (svg) svg.outerHTML = DL_ICON.replace(/width="16" height="16"/, `width="${svg.getAttribute('width') || 16}" height="${svg.getAttribute('height') || 16}"`);
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (e.isTrusted) startDownload(location.href); });
        wrap.after(copy);
      }
    };
    // Note: polls the track page's frame each second (its DOM isn't under
    // our observer); hook the frame's own MutationObserver if this shows up in CPU.
    setInterval(() => {
      if (document.querySelector('.webiIframe:not(.sc-hidden)')) addDownloadButtons();
      oledStyle(document.querySelector('.webiIframe')?.contentDocument, settings.theme === 'oled');
    }, 1000);
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
      if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); return post('tab:cycle:' + (e.shiftKey ? -1 : 1)); }
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key)) { e.preventDefault(); return post('tab:index:' + e.key); }
      const cmd = { '[': commands.back, ']': commands.forward, r: commands.reload, ',': () => toggleSettings(), f: () => search.q.focus(), l: editUrl, t: commands.newtab, w: () => post('tab:close') }[e.key];
      if (cmd) { e.preventDefault(); cmd(); }
    };
    const hook = w => { try { if (!w.__pocKeys) { w.__pocKeys = true; w.addEventListener('keydown', onKey, true); w.addEventListener('click', openInTab, true); w.addEventListener('auxclick', openInTab, true); } } catch {} };
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
    // --- Avatar menu gets the account items from the more menu. They only
    // exist while that menu is open, so each one opens it and clicks the real
    // link: SoundCloud's own handlers (sign out especially) do the work.
    const accountItems = [
      ['Support', 'a[href^="https://help.soundcloud.com"]', 'M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5zM6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.25M8 11.25v.01'],
      ['Subscription', 'a[href^="/you/subscriptions"]', 'M2 4h12v8H2zM2 6.75h12M4.5 9.5h2.5'],
      ['Settings', 'a[href="/settings"]', 'M2.5 4.5h6.5M12 4.5h1.5M2.5 11.5h1.5M7 11.5h6.5M10.5 3v3M5.5 10v3'],
      ['Sign out', 'a[href="/logout"]', 'M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6.5']];
    const viaMoreMenu = sel => {
      document.querySelector('.header__userNavUsernameButton')?.click(); // close the avatar menu
      document.querySelector('.header__moreButton')?.click();
      let tries = 0;
      const go = () => {
        const a = document.querySelector('.moreMenu ' + sel);
        if (a) a.click();
        else if (++tries < 60) requestAnimationFrame(go);
      };
      go();
    };
    // --- Accounts (accounts.rs): each extra one has its own sign-in, and
    // switching restarts the app on it. Listed in the avatar menu and in
    // Settings (a new account starts signed out, without an avatar menu).
    const accounts = window.__accounts || { accounts: [{ id: 'default', name: '', avatar: '' }], current: 'default' };
    const me = window.__sc_hydration?.find(x => x.hydratable === 'meUser')?.data;
    if (me) {
      const mine = { name: me.username, avatar: me.avatar_url || '' };
      Object.assign(accounts.accounts.find(a => a.id === accounts.current) || {}, mine);
      post('account:me:' + JSON.stringify(mine));
    }
    const accountRows = (list, rowClass) => {
      for (const acc of accounts.accounts) {
        const current = acc.id === accounts.current;
        const row = list.appendChild(document.createElement('li')).appendChild(Object.assign(document.createElement('a'), { className: rowClass + ' pocAccountRow', href: '#' }));
        row.append(Object.assign(document.createElement(acc.avatar ? 'img' : 'span'), { className: 'pocAccountAvatar', src: acc.avatar || '' }),
          Object.assign(document.createElement('span'), { className: 'pocAccountName', textContent: acc.name || 'Signed out' }));
        if (current) row.append(Object.assign(document.createElement('span'), { className: 'pocAccountCheck', innerHTML: icon('M3.5 8.5l3 3 6-7'), title: 'Current account' }));
        else if (acc.id !== 'default') {
          const x = row.appendChild(Object.assign(document.createElement('button'), { className: 'pocAccountRemove', innerHTML: icon('M4.5 4.5l7 7m0-7l-7 7'), title: 'Remove this account and its sign-in from the app' }));
          x.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            // (WKWebView has no confirm() dialog: a second click confirms)
            if (!x.classList.contains('confirm')) {
              x.classList.add('confirm'); x.textContent = 'Remove?';
              return setTimeout(() => { x.classList.remove('confirm'); x.innerHTML = icon('M4.5 4.5l7 7m0-7l-7 7'); }, 3000);
            }
            post('account:remove:' + acc.id);
            accounts.accounts = accounts.accounts.filter(a => a !== acc);
            row.parentElement.remove();
          });
        }
        row.addEventListener('click', e => { e.preventDefault(); if (!current) post('account:switch:' + acc.id); });
      }
      const add = list.appendChild(document.createElement('li')).appendChild(Object.assign(document.createElement('a'), { className: rowClass + ' pocAccountRow', href: '#' }));
      add.append(Object.assign(document.createElement('span'), { className: 'pocAccountAvatar pocAccountPlus', textContent: '+' }), Object.assign(document.createElement('span'), { className: 'pocAccountName', textContent: 'Add account' }));
      add.addEventListener('click', e => { e.preventDefault(); post('account:add'); });
    };
    accountRows(panel.querySelector('.pocAccountsList'), 'pocAccountsItem');
    const mergeMenus = () => {
      const menu = document.querySelector('.headerMenu.profileMenu');
      if (!menu || menu.querySelector('.pocAccount')) return;
      accountRows(menu.appendChild(Object.assign(document.createElement('ul'), { className: 'headerMenu__list sc-list-nostyle pocAccounts' })), 'headerMenu__link');
      const ul = menu.appendChild(Object.assign(document.createElement('ul'), { className: 'headerMenu__list sc-list-nostyle pocAccount' }));
      for (const [label, sel, d] of accountItems) {
        // SoundCloud's own item markup: <div><svg class="profileMenu__icon"></div> Label
        const a = ul.appendChild(document.createElement('li')).appendChild(Object.assign(document.createElement('a'), { className: 'headerMenu__link', href: '#' }));
        a.innerHTML = `<div>${icon(d).replace('<svg', '<svg class="profileMenu__icon"')}</div>`;
        a.append(label);
        a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); viaMoreMenu(sel); });
      }
    };
    let buttonsQueued = false;
    // (a timer, not requestAnimationFrame, which waits while the window is hidden)
    const queueButtons = () => { if (!buttonsQueued) { buttonsQueued = true; setTimeout(() => { buttonsQueued = false; addDownloadButtons(); }, 100); } };
    // SoundCloud places the menu from the avatar's old spot; right-align it to the avatar.
    const alignMenu = () => {
      const dd = document.querySelector('.dropdownMenu:has(.profileMenu)'), btn = document.querySelector('.header__userNavUsernameButton');
      if (!dd || !btn) return;
      const left = Math.round(btn.getBoundingClientRect().right - dd.offsetWidth) + 'px';
      if (dd.style.left !== left) dd.style.left = left;
    };
    addEventListener('resize', alignMenu);
    new MutationObserver(() => { renameArtist(); mergeMenus(); alignMenu(); queueButtons(); queueFit(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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
