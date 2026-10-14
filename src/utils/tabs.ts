export const SOUNDCLOUD_ORIGIN = 'https://soundcloud.com';

/** page info from preload.ts; empty strings when absent */
export interface PageInfo {
    /** track or playlist title from page hero */
    title: string;
    /** uploader of that track or playlist */
    user: string;
    /** display name on profile page */
    profile: string;
    /** path of signed-in user's own profile, e.g. "/some-user" */
    ownProfilePath: string;
    /** cover of track or playlist, or profile picture */
    artwork: string;
}

export const EMPTY_PAGE_INFO: PageInfo = { title: '', user: '', profile: '', ownProfilePath: '', artwork: '' };

export function parsePageInfo(payload: unknown): PageInfo | null {
    if (typeof payload !== 'object' || payload === null) return null;

    const info = { ...EMPTY_PAGE_INFO };
    for (const key of Object.keys(info) as (keyof PageInfo)[]) {
        const value = (payload as Record<string, unknown>)[key];
        if (typeof value !== 'string' || value.length > 300) return null;
        info[key] = value;
    }
    return info;
}

function soundCloudPath(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.origin === SOUNDCLOUD_ORIGIN ? parsed.href.slice(SOUNDCLOUD_ORIGIN.length + 1) : null;
    } catch {
        return null;
    }
}

/** URL bar text when unfocused: address minus https://soundcloud.com/ prefix */
export function displayUrl(url: string): string {
    if (url === 'about:blank') return '';
    return soundCloudPath(url) ?? url;
}

/** URL bar input to SoundCloud address, or null if it points elsewhere */
export function resolveUrlInput(input: string): string | null {
    const text = input.trim();
    if (!text) return null;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        try {
            const url = new URL(text);
            const onSoundCloud = url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com');
            return url.protocol === 'https:' && onSoundCloud ? url.href : null;
        } catch {
            return null;
        }
    }

    const path = text.replace(/^(www\.)?soundcloud\.com(\/|$)/i, '').replace(/^\/+/, '');
    if (/\s/.test(path)) return `${SOUNDCLOUD_ORIGIN}/search?q=${encodeURIComponent(path)}`;
    return `${SOUNDCLOUD_ORIGIN}/${path}`;
}

/** tab icon: page cover or profile picture at thumbnail size, '' without one (gets SoundCloud icon);
 * only SoundCloud's image CDN accepted, since URL read from page and becomes <img> */
export function tabIcon(info: PageInfo): string {
    if (!info.title && !info.profile) return '';
    try {
        const url = new URL(info.artwork);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.sndcdn.com')) return '';
        return url.href.replace(/-t\d+x\d+(\.\w+)$/, '-t120x120$1');
    } catch {
        return '';
    }
}

/** new order after dragging tab at `from` onto slot `to` */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
    const moved = [...items];
    moved.splice(to, 0, ...moved.splice(from, 1));
    return moved;
}

const pageName = (segment: string) => {
    const words = segment.replace(/-/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
};

/** tab label: "playlist name - author", "uploader - song title", else page name; own profile is "Profile" */
export function tabTitle(url: string, info: PageInfo): string {
    const path = soundCloudPath(url);
    if (path === null) {
        try {
            return new URL(url).hostname || 'New Tab';
        } catch {
            return 'New Tab';
        }
    }

    const segments = path.split(/[?#]/)[0].split('/').filter(Boolean);

    if (info.title) {
        if (!info.user) return info.title;
        // playlists read "name - author", songs "uploader - title"
        return segments.includes('sets') ? `${info.title} - ${info.user}` : `${info.user} - ${info.title}`;
    }
    if (info.profile) return info.ownProfilePath === `/${segments[0]}` ? 'Profile' : info.profile;

    if (segments.length === 0 || segments[0] === 'discover') return 'Home';
    if (segments[0] === 'you' && segments[1]) return pageName(segments[1]);
    return pageName(segments[0]);
}
