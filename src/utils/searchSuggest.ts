/** One row under the search box: a search to run, or with `url` somewhere to go straight to. */
export interface Suggestion {
    title: string;
    url?: string;
    image?: string;
    /** a person, whose picture SoundCloud shows round */
    round?: boolean;
}

/**
 * A script for a soundcloud.com page that puts together what the site's own search box would show
 * for `query`: the account's own that match it (who it follows, what it liked or uploaded), then
 * the searches SoundCloud suggests. It runs in the page because that is where the API's client id
 * and the session are to be had, and asks as the page does; `readSuggestions` takes what it
 * resolves to.
 */
export function suggestScript(query: string): string {
    return `(async () => {
        const query = ${JSON.stringify(query)};
        const id =
            (window.__sc_hydration || []).find((entry) => entry.hydratable === 'apiClient')?.data?.id ??
            // not every page is handed it that way, but every API request the page has made carries it
            performance
                .getEntriesByType('resource')
                .map((entry) => new URL(entry.name).searchParams.get('client_id'))
                .find(Boolean);
        if (!id) return [];

        // signed out, there is none, and nothing of the account's own to match
        const token = document.cookie.match(/(?:^|; )oauth_token=([^;]+)/)?.[1];
        const get = async (path, params) => {
            const address = 'https://api-v2.soundcloud.com/' + path + '?' + new URLSearchParams({ ...params, client_id: id, limit: '10' });
            const response = await fetch(address, { headers: token ? { Authorization: 'OAuth ' + token } : {} });
            return (await response.json()).collection;
        };

        // ponytail: fetched once per page, so a new like or follow shows up after a reload
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
            // a track can be both liked and the account's own
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

/**
 * The suggestions out of a page's answer, which is trusted with no more than a few short titles,
 * links into soundcloud.com and pictures from its image hosts.
 */
export function readSuggestions(result: unknown): Suggestion[] {
    if (!Array.isArray(result)) return [];
    return result
        .flatMap((entry): Suggestion[] => {
            if (typeof entry?.title !== 'string' || !entry.title || entry.title.length > 200) return [];
            const url = addressOn(entry.url, (host) => host === 'soundcloud.com');
            // one that was to lead somewhere it may not is left out, not turned into a search
            if (entry.url && !url) return [];
            const image = addressOn(entry.image, (host) => host.endsWith('.sndcdn.com'));
            return [{ title: entry.title, url, image, round: entry.round === true }];
        })
        .slice(0, 10);
}
