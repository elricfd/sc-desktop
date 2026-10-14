import { contextBridge, ipcRenderer } from 'electron';
import type { TrackInfo, TrackUpdateReason } from './types';

contextBridge.exposeInMainWorld('soundcloudAPI', {
    sendTrackUpdate: (data: TrackInfo, reason: TrackUpdateReason) => {
        ipcRenderer.send('soundcloud:track-update', {
            data,
            reason,
        });
    },
});

// download button per action row (tracks, albums, player); added here so page JS cannot start downloads
const DOWNLOAD_ICON =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function addDownloadButtons(): void {
    for (const actions of document.querySelectorAll('.soundActions:not(:has(.scrpc-download))')) {
        const size = actions.classList.contains('soundActions__small') ? 'small' : 'medium';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `scrpc-download sc-button-secondary sc-button sc-button-${size} sc-button-icon sc-button-responsive`;
        button.title = 'Download';
        button.setAttribute('aria-label', 'Download');
        button.innerHTML = `<div>${DOWNLOAD_ICON}</div>`;

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!e.isTrusted) return; // ignore page-synthesized clicks

            // link of row this button sits in; page URL for player row
            const link = button
                .closest('.trackItem, .sound, .soundBadge')
                ?.querySelector<HTMLAnchorElement>('a.trackItem__trackTitle, a.soundTitle__title');
            const url = link?.href ?? (button.closest('.listenEngagement') ? location.href : '');
            if (url) ipcRenderer.send('soundcloud:download', url);
        });

        (actions.querySelector('.sc-button-group') ?? actions).append(button);
    }
}

// SoundCloud tags every link it hands out with who shared it (`si`) and where (`utm_*`).
function stripTracking(link: string): string {
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return link;
    }
    if (!/(^|\.)soundcloud\.com$/.test(url.hostname)) return link;

    // filter as text: searchParams.delete would re-encode kept params
    const query = url.search.slice(1);
    const kept = query
        .split('&')
        .filter((param) => !/^(si|utm_\w+)(=|$)/.test(param))
        .join('&');
    if (kept === query) return link;
    url.search = kept;
    return url.href;
}

// "Copy Link" and share field both copy via selection: one listener covers both
document.addEventListener(
    'copy',
    (e) => {
        const text = String(getSelection()).trim();
        const clean = stripTracking(text);
        if (clean === text) return;
        e.clipboardData?.setData('text/plain', clean);
        e.preventDefault();
    },
    true,
);

// share buttons: link again, percent-encoded inside href
const ENCODED_TRACKING = /(%3F|%26)(si|utm_[a-z]+)%3D[\w.~-]*/gi;

function cleanShareDialog(): void {
    const field = document.querySelector<HTMLInputElement>('input.shareLink__field');
    // write only on change, else user's selection is dropped
    if (field && stripTracking(field.value) !== field.value) field.value = stripTracking(field.value);

    for (const button of document.querySelectorAll<HTMLAnchorElement>('a.shareButton')) {
        const href = button.getAttribute('href') ?? '';
        const clean = href.replace(ENCODED_TRACKING, '');
        if (clean !== href) button.setAttribute('href', clean);
    }
}

// tab title from page UI (document.title is localized SEO text), tab icon from cover or profile pic
let lastPageInfo = '';
setInterval(() => {
    addDownloadButtons();
    cleanShareDialog();
    watchFrames();

    // SC re-renders "Artist Studio" header link text: force "Artist"
    const artistLink = document.querySelector('.header__forArtistsButton');
    if (artistLink && artistLink.textContent !== 'Artist') artistLink.textContent = 'Artist';

    const text = (selector: string) => document.querySelector<HTMLElement>(selector)?.innerText.trim() ?? '';
    const ownProfile = document.querySelector<HTMLAnchorElement>(
        '.header__userNav [data-menu-name="profile"], .header__userNavUsernameButton',
    );
    // artwork: span background-image, or plain <img> on some pages
    const artwork = document.querySelector<HTMLElement>(
        '.fullHero__artwork span.sc-artwork, .fullHero__artwork img, .profileHeaderInfo__avatar span.sc-artwork',
    );
    const info = {
        title: text('.fullHero__title .soundTitle__title'),
        user: text('.fullHero__title .soundTitle__username'),
        profile: text('.profileHeaderInfo__userName'),
        ownProfilePath: ownProfile?.pathname ?? '',
        artwork:
            artwork instanceof HTMLImageElement
                ? artwork.src
                : (/url\("?([^")]+)"?\)/.exec(artwork?.style.backgroundImage ?? '')?.[1] ?? ''),
    };

    const key = JSON.stringify(info);
    if (key === lastPageInfo) return;
    lastPageInfo = key;
    ipcRenderer.send('soundcloud:page-info', info);
}, 500);

// two-finger swipes arrive as horizontal wheel events: map to back/forward (3-finger swipe is in main.ts)
// sandboxed preload cannot require local modules, so this lives here, not in utils/

const SWIPE_PX = 150; // horizontal px per swipe; raise if too sensitive
const SWIPE_GAP_MS = 150; // silence that ends gesture; momentum events keep it alive

// can any scroller under pointer still move sideways this way?
function canScrollX(e: WheelEvent, direction: number): boolean {
    // document of event: this one or same-origin iframe (see watchFrames)
    const { documentElement: html, body } = (e.target as Node | null)?.ownerDocument ?? document;
    const overflowX = (el: Element) => getComputedStyle(el).overflowX;
    // viewport: <html> overflow, or <body>'s if <html> is visible (soundcloud.com overflows sideways <960px)
    // visible still scrolls on viewport, unlike other elements
    const bodyGoesToViewport = overflowX(html) === 'visible';
    const viewport = bodyGoesToViewport ? overflowX(body) : overflowX(html);

    for (const target of e.composedPath()) {
        // nodeType, not instanceof: iframe elements have their own Element class
        const node = target as Element;
        if (node.nodeType !== 1 || (node === body && bodyGoesToViewport)) continue;
        const isViewport = node === html;
        const overflow = isViewport ? viewport : overflowX(node);
        if (isViewport ? overflow === 'hidden' || overflow === 'clip' : overflow !== 'auto' && overflow !== 'scroll') {
            continue;
        }
        const max = node.scrollWidth - node.clientWidth;
        if (max > 0 && (direction < 0 ? node.scrollLeft > 0 : node.scrollLeft < max - 1)) return true;
    }
    return false;
}

let last = 0;
let dx = 0;
let dy = 0;
let ignored = false; // gesture already navigated, or scroller owns it
let checked = false; // scroller check once per gesture, on first horizontal event

function onSwipeWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.shiftKey) return; // pinch-zoom, shift-scroll

    // one clock: e.timeStamp counts from its document's load, iframes load later
    const now = e.timeStamp + (e.view?.performance.timeOrigin ?? 0);
    if (now - last > SWIPE_GAP_MS) {
        dx = 0;
        dy = 0;
        ignored = false;
        checked = false;
    }
    last = now;
    if (ignored) return;

    if (!checked && e.deltaX) {
        checked = true;
        ignored = canScrollX(e, e.deltaX);
        if (ignored) return;
    }

    dx += e.deltaX;
    dy += e.deltaY;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;

    ignored = true;
    // overscroll past left edge = back, as in Chromium
    ipcRenderer.send(dx < 0 ? 'navigate-back' : 'navigate-forward');
}

if (process.platform === 'darwin') window.addEventListener('wheel', onSwipeWheel, { passive: true });

// some pages render in same-origin iframe (track pages when signed in): wheel never reaches this document
// frame window gets same listener; swipe tail after navigating must not count again
function watchFrames(): void {
    if (process.platform !== 'darwin') return;

    for (const frame of document.querySelectorAll('iframe')) {
        // null if cross-origin; re-adding listener is no-op until frame load gives new window
        if (frame.contentDocument) frame.contentWindow?.addEventListener('wheel', onSwipeWheel, { passive: true });
    }
}
