const ipcRenderer = {
    send: (channel, ...args) => window.headerAPI.send(channel, ...args),
    invoke: (channel, ...args) => window.headerAPI.invoke(channel, ...args),
    on: (channel, listener) => window.headerAPI.on(channel, (...args) => listener(null, ...args)),
};
const platform = window.headerAPI.platform;

let isMaximized = false;
let canGoBack = false;
let canGoForward = false;
let isRefreshing = false;
let navButtons = null;
let themeColors = null;
let minimizeGlyphEl = null;
let maximizeGlyphEl = null;
let closeGlyphEl = null;

const SEGOE_GLYPHS = {
    minimize: '\uE921',
    maximize: '\uE922',
    restore: '\uE923',
    close: '\uE8BB',
    closeHighContrast: '\uEF2C',
};
const forcedColorsQuery = window.matchMedia ? window.matchMedia('(forced-colors: active)') : null;

function applyThemeColors(colors) {
    themeColors = colors;
    if (!colors) {
        // no custom theme: drop overrides so stylesheet theme classes apply again
        document.documentElement.style.removeProperty('--header-bg');
        document.documentElement.style.removeProperty('--header-text');
        document.documentElement.style.removeProperty('--header-accent');
        document.documentElement.style.removeProperty('--header-surface');
        resetHeaderColors();
        return;
    }

    document.documentElement.style.setProperty('--header-bg', colors.primary || colors.background);
    document.documentElement.style.setProperty('--header-text', colors.text);
    document.documentElement.style.setProperty('--header-accent', colors.accent || colors.primary);
    // bar's own paint, search suggestions match it
    document.documentElement.style.setProperty('--header-surface', colors.surface || colors.background);

    const header = document.querySelector('.custom-header');
    if (header) {
        header.style.backgroundColor = colors.surface || colors.background;
        header.style.color = colors.text;
    }
}

function resetHeaderColors() {
    const header = document.querySelector('.custom-header');
    header?.style.removeProperty('background-color');
    header?.style.removeProperty('color');
}

function setNavigationControlsVisible(visible) {
    const navControls = document.querySelector('.navigation-controls');
    navControls?.classList.toggle('visible', visible);
    navControls?.classList.toggle('hidden', !visible);
}

function updateNavigationState(state = {}) {
    if (!navButtons) {
        navButtons = {
            back: document.getElementById('back-btn'),
            forward: document.getElementById('forward-btn'),
            refresh: document.getElementById('refresh-btn'),
        };
    }

    if ('canGoBack' in state) canGoBack = state.canGoBack;
    if ('canGoForward' in state) canGoForward = state.canGoForward;

    if ('refreshing' in state) {
        isRefreshing = state.refreshing;
        if (navButtons.refresh) {
            navButtons.refresh.classList.toggle('refreshing', isRefreshing);
            navButtons.refresh.title = isRefreshing ? 'Cancel Refresh' : 'Refresh Page';
        }
    }

    if (navButtons.back) navButtons.back.classList.toggle('disabled', !canGoBack);
    if (navButtons.forward) navButtons.forward.classList.toggle('disabled', !canGoForward);
}

// only Windows draws its own caption buttons
function updateWindowControls() {
    if (platform === 'win32') {
        if (!maximizeGlyphEl) {
            maximizeGlyphEl = document.querySelector('#maximize-btn .icon-glyph');
        }
        if (!maximizeGlyphEl) return;

        setIconGlyph(maximizeGlyphEl, isMaximized ? SEGOE_GLYPHS.restore : SEGOE_GLYPHS.maximize);

        const label = isMaximized ? 'Restore' : 'Maximize';
        document.getElementById('maximize-btn').title = label;
        document.getElementById('maximize-btn').setAttribute('aria-label', label);
    }
}

function setIconGlyph(element, glyph) {
    if (!element) return;
    element.textContent = glyph;
}

function initializeIcons() {
    try {
        if (platform === 'win32') {
            minimizeGlyphEl = document.querySelector('#minimize-btn .icon-glyph');
            maximizeGlyphEl = document.querySelector('#maximize-btn .icon-glyph');
            closeGlyphEl = document.querySelector('#close-btn .icon-glyph');

            setIconGlyph(minimizeGlyphEl, SEGOE_GLYPHS.minimize);
            setIconGlyph(maximizeGlyphEl, SEGOE_GLYPHS.maximize);
            setIconGlyph(closeGlyphEl, getCloseGlyph());

            if (forcedColorsQuery?.addEventListener) {
                forcedColorsQuery.addEventListener('change', handleForcedColorsChange);
            } else if (forcedColorsQuery?.addListener) {
                forcedColorsQuery.addListener(handleForcedColorsChange);
            }
        }
    } catch (error) {
        console.error('Error initializing icons:', error);
    }
}

function getCloseGlyph() {
    return forcedColorsQuery?.matches ? SEGOE_GLYPHS.closeHighContrast : SEGOE_GLYPHS.close;
}

function handleForcedColorsChange() {
    if (closeGlyphEl) {
        setIconGlyph(closeGlyphEl, getCloseGlyph());
    }
}

document.body.classList.add(`platform-${platform}`);

document.querySelector('.navigation-controls')?.addEventListener('click', (e) => {
    const { id } = e.target.closest('.nav-button') || {};

    switch (id) {
        case 'back-btn':
            if (canGoBack) ipcRenderer.send('navigate-back');
            break;
        case 'forward-btn':
            if (canGoForward) ipcRenderer.send('navigate-forward');
            break;
        case 'refresh-btn':
            if (isRefreshing) {
                ipcRenderer.send('cancel-refresh');
                updateNavigationState({ refreshing: false });
            } else {
                ipcRenderer.send('refresh-page');
                updateNavigationState({ refreshing: true });
            }
            break;
    }
});

document.getElementById('minimize-btn')?.addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});

document.getElementById('maximize-btn')?.addEventListener('click', () => {
    ipcRenderer.send('maximize-window');
    isMaximized = !isMaximized;
    updateWindowControls();
});

document.getElementById('close-btn')?.addEventListener('click', () => {
    ipcRenderer.send('close-window');
});

document.querySelectorAll('.title-bar').forEach((spacer) =>
    spacer.addEventListener('dblclick', () => {
        ipcRenderer.send('title-bar-double-click');
        isMaximized = !isMaximized;
        updateWindowControls();
    }),
);

// selected tab doubles as URL bar: address minus soundcloud prefix, full while editing
const tabGroup = document.getElementById('tab-group');
let tabState = { tabs: [], activeId: null, url: '', display: '', fallbackIcon: '' };
let renderedTabState = '';
// state that arrived mid-edit or mid-drag: rebuilding would drop input or drag
let pendingTabState = null;

function renderTabs(state) {
    if (tabGroup.querySelector('.tab.editing, .tab.dragging')) {
        pendingTabState = state;
        return;
    }
    pendingTabState = null;

    const serialized = JSON.stringify(state);
    if (serialized === renderedTabState) return;
    renderedTabState = serialized;
    tabState = state;

    tabGroup.classList.toggle('single', state.tabs.length === 1);
    tabGroup.replaceChildren(...state.tabs.map(buildTab));
}

function buildTab(tab) {
    const active = tab.id === tabState.activeId;
    const el = document.createElement('div');
    el.className = active ? 'tab active' : 'tab';
    el.dataset.id = tab.id;
    el.draggable = true;
    el.title = tab.title;

    const icon = document.createElement('img');
    icon.className = 'tab-icon';
    icon.draggable = false;
    icon.onerror = () => {
        icon.onerror = null;
        icon.src = tabState.fallbackIcon;
    };
    icon.src = tab.icon || tabState.fallbackIcon;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.append(icon, title);

    if (active) {
        const path = document.createElement('span');
        path.className = 'tab-path';
        path.textContent = tabState.display;

        const input = document.createElement('input');
        input.className = 'tab-url';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Address');
        el.append(path, input);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.title = 'Close Tab';
    close.textContent = '\u00d7';
    el.append(close);

    return el;
}

function applyPendingTabState() {
    if (pendingTabState) renderTabs(pendingTabState);
}

function editUrl() {
    const tab = tabGroup.querySelector('.tab.active');
    const input = tab?.querySelector('.tab-url');
    if (!input || tab.classList.contains('editing')) return;

    tab.classList.add('editing');
    tab.draggable = false;
    input.value = tabState.url;
    input.focus();
    input.select();
}

const tabId = (el) => Number(el?.closest('.tab')?.dataset.id);

tabGroup.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;

    if (e.target.closest('.tab-close')) ipcRenderer.send('tab-close', tabId(tab));
    else if (tab.classList.contains('active')) editUrl();
    else ipcRenderer.send('tab-select', tabId(tab));
});

// middle click closes, as browsers do
tabGroup.addEventListener('auxclick', (e) => {
    if (e.button === 1 && e.target.closest('.tab') && tabState.tabs.length > 1) {
        ipcRenderer.send('tab-close', tabId(e.target));
    }
});

function stopEditingUrl() {
    const tab = tabGroup.querySelector('.tab.editing');
    if (!tab) return;
    tab.classList.remove('editing');
    tab.draggable = true;
    applyPendingTabState();
}

tabGroup.addEventListener('keydown', (e) => {
    if (!e.target.matches('.tab-url')) return;
    if (e.key === 'Enter') ipcRenderer.send('navigate-url', e.target.value);
    if (e.key === 'Enter' || e.key === 'Escape') {
        // not focusout alone: it does not fire while window is in background
        stopEditingUrl();
        e.target.blur();
    }
});

tabGroup.addEventListener('focusout', (e) => {
    if (e.target.matches('.tab-url')) stopEditingUrl();
});

// drop onto another tab to take its slot
tabGroup.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.id);
});

tabGroup.addEventListener('dragover', (e) => {
    const target = e.target.closest('.tab');
    if (!target || !tabGroup.querySelector('.tab.dragging')) return;
    e.preventDefault();
    tabGroup.querySelector('.tab.drop-target')?.classList.remove('drop-target');
    if (!target.classList.contains('dragging')) target.classList.add('drop-target');
});

tabGroup.addEventListener('drop', (e) => {
    const dragged = tabGroup.querySelector('.tab.dragging');
    const target = e.target.closest('.tab');
    if (!dragged || !target || dragged === target) return;
    e.preventDefault();
    ipcRenderer.send('tab-move', tabId(dragged), [...tabGroup.children].indexOf(target));
});

tabGroup.addEventListener('dragend', () => {
    tabGroup
        .querySelectorAll('.dragging, .drop-target')
        .forEach((el) => el.classList.remove('dragging', 'drop-target'));
    applyPendingTabState();
});

document.getElementById('new-tab-btn')?.addEventListener('click', () => {
    ipcRenderer.send('tab-new');
});

// search: replaces SoundCloud's header box, suggestions underneath
const searchInput = document.getElementById('search-input');
const suggestions = document.getElementById('search-suggestions');
let suggestTimer = null;
// list on screen or on its way; stale answers ignored
let suggestedFor = '';

function search(query) {
    if (query) ipcRenderer.send('navigate-url', `https://soundcloud.com/search?q=${encodeURIComponent(query)}`);
    searchInput.blur();
}

// typed text first, then main's matches: own follows, likes, uploads (places) and search suggestions
function showSuggestions(typed, items) {
    const rows = items.length ? [{ title: typed }, ...items.filter((item) => item.url || item.title !== typed)] : [];
    suggestions.replaceChildren(
        ...rows.map((item, position) => {
            const row = document.createElement('li');
            row.setAttribute('role', 'option');
            row.dataset.query = item.title;
            if (item.url) row.dataset.url = item.url;
            if (item.image) {
                const image = document.createElement('img');
                image.className = item.round ? 'round' : '';
                image.src = item.image;
                image.onerror = () => image.remove();
                row.append(image);
            }
            const title = document.createElement('span');
            // textContent: suggestions come from soundcloud.com
            title.textContent = position ? item.title : `Search for “${item.title}”`;
            row.append(title);
            return row;
        }),
    );
    suggestions.hidden = !rows.length;
    // view ends at title bar; main stretches it down for list and shadow
    ipcRenderer.send('header-height', rows.length ? Math.ceil(suggestions.getBoundingClientRect().bottom) + 16 : 0);
}

function closeSuggestions() {
    clearTimeout(suggestTimer);
    suggestedFor = '';
    if (!suggestions.hidden) showSuggestions('', []);
}

searchInput?.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const typed = searchInput.value.trim();
    suggestedFor = typed;
    if (!typed) return closeSuggestions();
    // not one request per keystroke
    suggestTimer = setTimeout(async () => {
        const items = await ipcRenderer.invoke('search-suggest', typed).catch(() => []);
        if (suggestedFor === typed && document.activeElement === searchInput) showSuggestions(typed, items);
    }, 150);
});

// place rows navigate; others are searched
function pick(row) {
    if (!row.dataset.url) return search(row.dataset.query);
    ipcRenderer.send('navigate-url', row.dataset.url);
    searchInput.blur();
}

document.getElementById('search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const row = suggestions.querySelector('.active');
    if (row) pick(row);
    else search(searchInput.value.trim());
});

searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') searchInput.blur();
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || suggestions.hidden) return;

    // up/down wraps past either end; box shows active row
    e.preventDefault();
    const rows = [...suggestions.children];
    const current = rows.findIndex((row) => row.classList.contains('active'));
    const next = (current + (e.key === 'ArrowDown' ? 1 : current < 0 ? 0 : -1) + rows.length) % rows.length;
    rows[current]?.classList.remove('active');
    rows[next].classList.add('active');
    searchInput.value = rows[next].dataset.query;
});

// mousedown + preventDefault: click would land after blur closed list
suggestions?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = e.target.closest('li');
    if (!row) return;
    searchInput.value = row.dataset.query;
    pick(row);
});

searchInput?.addEventListener('blur', closeSuggestions);
// not blur alone: it does not fire when whole window goes to background
window.addEventListener('blur', closeSuggestions);

// show what results on screen are for, as page's box did
function syncSearch(url) {
    if (!searchInput || document.activeElement === searchInput) return;
    const { pathname, searchParams } = URL.parse(url) ?? {};
    searchInput.value = pathname?.startsWith('/search') ? (searchParams.get('q') ?? '') : '';
}

// downloads: opens progress popup; lit while downloading, else only if Settings keeps it
const downloadsBtn = document.getElementById('downloads-btn');
let downloadsButtonAlways = false;
let downloadsActive = false;

function updateDownloadsButton() {
    downloadsBtn?.classList.toggle('hidden', !downloadsButtonAlways && !downloadsActive);
    downloadsBtn?.classList.toggle('active', downloadsActive);
}

downloadsBtn?.addEventListener('click', () => ipcRenderer.send('toggle-downloads'));
ipcRenderer.on('download-button-toggle', (_, always) => {
    downloadsButtonAlways = always;
    updateDownloadsButton();
});
ipcRenderer.on('downloads-active', (_, active) => {
    downloadsActive = active > 0;
    updateDownloadsButton();
});

document.getElementById('menu-btn')?.addEventListener('click', () => ipcRenderer.send('toggle-settings'));

ipcRenderer.on('tabs-changed', (_, state) => {
    renderTabs(state);
    syncSearch(state.url);
});
ipcRenderer.on('focus-url-bar', () => editUrl());

ipcRenderer.on('theme-changed', (_, isDark) => {
    document.documentElement.classList.toggle('theme-light', !isDark);
    if (!themeColors) resetHeaderColors();
});

ipcRenderer.on('theme-colors-changed', (_, colors) => applyThemeColors(colors));

ipcRenderer.on('window-maximized-changed', (_, maximized) => {
    if (isMaximized === maximized) return;
    isMaximized = maximized;
    updateWindowControls();
});

// macOS fullscreen: no traffic lights, header.css drops their gap
const setFullscreen = (on) => document.body.classList.toggle('fullscreen', on);
ipcRenderer.on('fullscreen-changed', (_, on) => setFullscreen(on));

ipcRenderer.on('navigation-state-changed', (_, state) => updateNavigationState(state));
ipcRenderer.on('refresh-state-changed', (_, refreshing) => updateNavigationState({ refreshing }));
ipcRenderer.on('navigation-controls-toggle', (_, enabled) => setNavigationControlsVisible(enabled));

document.addEventListener('DOMContentLoaded', () => {
    initializeIcons();
    updateNavigationState();

    ipcRenderer.invoke('get-navigation-controls-enabled').then((enabled) => {
        if (enabled) setNavigationControlsVisible(true);
    });

    ipcRenderer.invoke('get-download-button-enabled').then((always) => {
        downloadsButtonAlways = always;
        updateDownloadsButton();
    });

    // tabs opened before page finished loading
    ipcRenderer.invoke('get-tab-state').then((state) => {
        renderTabs(state);
        syncSearch(state.url);
    });

    ipcRenderer.invoke('get-theme-colors').then((colors) => {
        if (colors) applyThemeColors(colors);
    });

    // seed once; later changes come via 'window-maximized-changed'
    ipcRenderer.invoke('is-maximized').then((maximized) => {
        if (isMaximized !== maximized) {
            isMaximized = maximized;
            updateWindowControls();
        }
    });

    ipcRenderer.invoke('is-fullscreen').then(setFullscreen);
});
