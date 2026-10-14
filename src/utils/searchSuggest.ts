/** search box row: search to run, or page to open when `url` is set */
export interface Suggestion {
    title: string;
    url?: string;
    image?: string;
    /** person, shown with round picture */
    round?: boolean;
}

/** page script: account's own matches for `query` (follows, likes, uploads), then SoundCloud's search suggestions
 * runs in page for its client id and session; result goes to `readSuggestions` */
export function suggestScript(query: string): string {
    return `(async () => {
        const query = ${JSON.stringify(query)};
        const id =
            (window.__sc_hydration || []).find((entry) => entry.hydratable === 'apiClient')?.data?.id ??
            // not every page passes it this way, but every API request carries it
            performance
                .getEntriesByType('resource')
                .map((entry) => new URL(entry.name).searchParams.get('client_id'))
                .find(Boolean);
        if (!id) return [];

        // signed out: no token, so nothing of account's to match
        const token = document.cookie.match(/(?:^|; )oauth_token=([^;]+)/)?.[1];
        const get = async (path, params) => {
            const address = 'https://api-v2.soundcloud.com/' + path + '?' + new URLSearchParams({ ...params, client_id: id, limit: '10' });
            const response = await fetch(address, { headers: token ? { Authorization: 'OAuth ' + token } : {} });
            return (await response.json()).collection;
        };

        window.__scDesktopShortcuts ??= Promise.all(
            (token ? ['followings', 'track-likes', 'own-tracks'] : []).map((list) => get('me/shortcuts/' + list, {}).catch(() => [])),
        ).then((lists) => lists.flat());

        const [shortcuts, queries] = await Promise.all([
            window.__scDesktopShortcuts,
            get('search/queries', { q: query }).catch(() => []),
        ]);
        const typed = query.trim().toLowerCase();
        const own = shortcuts
            .filter((entry) => (entry.username || entry.title || '').toLowerCase().includes(typed))
            // track can be both liked and own
            .filter((entry, position, all) => all.findIndex((other) => other.permalink_url === entry.permalink_url) === position)
            .slice(0, 4)
            .map((entry) => ({
                title: entry.username || entry.title,
                url: entry.permalink_url,
                image: entry.avatar_url || entry.artwork_url,
                round: entry.kind === 'user',
            }));
        return [...own, ...queries.slice(0, 6).map((entry) => ({ title: entry.output }))];
    })()`;
}

function addressOn(value: unknown, allowed: (host: string) => boolean): string | undefined {
    if (typeof value !== 'string') return undefined;
    const url = URL.parse(value);
    return url?.protocol === 'https:' && allowed(url.hostname) ? url.href : undefined;
}

/** suggestions from page answer; trusted only for short titles, soundcloud.com links, image hosts */
export function readSuggestions(result: unknown): Suggestion[] {
    if (!Array.isArray(result)) return [];
    return result
        .flatMap((entry): Suggestion[] => {
            if (typeof entry?.title !== 'string' || !entry.title || entry.title.length > 200) return [];
            const url = addressOn(entry.url, (host) => host === 'soundcloud.com');
            // disallowed link: drop entry, don't fall back to search
            if (entry.url && !url) return [];
            const image = addressOn(entry.image, (host) => host.endsWith('.sndcdn.com'));
            return [{ title: entry.title, url, image, round: entry.round === true }];
        })
        .slice(0, 10);
}
