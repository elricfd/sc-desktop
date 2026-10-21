/** search box row: search to run, or page to open when `url` is set */
export interface Suggestion {
    title: string;
    url?: string;
    image?: string;
    /** person, shown with round picture */
    round?: boolean;
}

// page world: client id, session, API, and account's likes and follows (once per page load, null signed out)
// first 200 of each, cached till reload
const PAGE_API = `
    const clientId = () =>
        (window.__sc_hydration || []).find((entry) => entry.hydratable === 'apiClient')?.data?.id ??
        // not every page passes it this way, but every API request carries it
        performance
            .getEntriesByType('resource')
            .map((entry) => URL.parse(entry.name)?.searchParams.get('client_id'))
            .find(Boolean);
    const token = () => document.cookie.match(/(?:^|; )oauth_token=([^;]+)/)?.[1];
    const get = async (path, params = {}) => {
        const address = 'https://api-v2.soundcloud.com/' + path + '?' + new URLSearchParams({ ...params, client_id: clientId() });
        // own calls skip search hook
        const response = await (window.__scDesktopFetch ?? window.fetch)(address, { headers: { Authorization: 'OAuth ' + token() } });
        return response.json();
    };
    const library = () =>
        (window.__scDesktopLibrary ??= (async () => {
            if (!token() || !clientId()) return null;
            const me = await get('me');
            const [likes, follows] = await Promise.all([
                get('users/' + me.id + '/track_likes', { limit: '200' }),
                get('users/' + me.id + '/followings', { limit: '200' }),
            ]);
            const tracks = likes.collection.map((like) => like.track).filter(Boolean);
            // artist weight: follow 2, each liked track 1
            const artists = new Map(follows.collection.map((user) => [user.id, 2]));
            for (const track of tracks) artists.set(track.user_id, (artists.get(track.user_id) ?? 0) + 1);
            const genres = new Set(tracks.map((track) => (track.genre || '').toLowerCase()).filter(Boolean));
            return { tracks, users: follows.collection, liked: new Set(tracks.map((track) => track.id)), artists, genres };
        })().catch(() => null));
    const matches = (text, typed) => !!typed && (text || '').toLowerCase().includes(typed);
`;

/** page script: account's follows and likes matching `query`; result goes to `readSuggestions` */
export function suggestScript(query: string): string {
    return `(async () => {
        const query = ${JSON.stringify(query)};
        ${PAGE_API}
        const own = await library();
        if (!own) return [];
        const typed = query.trim().toLowerCase();
        const users = own.users.filter((user) => matches(user.username, typed)).slice(0, 3);
        const tracks = own.tracks
            .filter((track) => matches(track.title, typed) || matches(track.user?.username, typed))
            .slice(0, 10 - users.length);
        return [...users, ...tracks].map((entry) => ({
            title: entry.username || entry.title,
            url: entry.permalink_url,
            image: entry.avatar_url || entry.artwork_url,
            round: entry.kind === 'user',
        }));
    })()`;
}

/** page script, once per load: SoundCloud's search answers reordered for account
 * first page leads with liked tracks matching query; then liked tracks, liked or followed artists, liked genres
 * installed after load: first search on freshly loaded /search page keeps SoundCloud order */
export const personalSearchScript = `(() => {
    if (window.__scDesktopFetch) return;
    window.__scDesktopFetch = window.fetch;
    ${PAGE_API}
    const searchUrl = (address) => {
        const url = URL.parse(address, location.href);
        return url?.hostname === 'api-v2.soundcloud.com' && /^\\/search(\\/tracks)?$/.test(url.pathname) ? url : null;
    };
    // slow library: search goes ahead unchanged
    const ready = () => Promise.race([library(), new Promise((done) => setTimeout(done, 3000, null))]);

    // liked matches put on first page, kept off later ones
    let shown = new Set();
    const personalise = (body, url, own) => {
        if (!Array.isArray(body?.collection)) return body;
        const typed = (url.searchParams.get('q') || '').trim().toLowerCase();
        let items = body.collection;
        if (!Number(url.searchParams.get('offset'))) {
            const liked = own.tracks.filter((track) => matches(track.title, typed) || matches(track.user?.username, typed)).slice(0, 5);
            shown = new Set(liked.map((track) => track.id));
            items = [...liked, ...items.filter((item) => item.kind !== 'track' || !shown.has(item.id))];
        } else {
            items = items.filter((item) => item.kind !== 'track' || !shown.has(item.id));
        }
        const score = (item) =>
            (item.kind === 'track' && own.liked.has(item.id) ? 8 : 0) +
            Math.min(own.artists.get(item.kind === 'user' ? item.id : (item.user_id ?? item.user?.id)) ?? 0, 4) +
            (own.genres.has((item.genre || '').toLowerCase()) ? 1 : 0);
        // stable sort: SoundCloud's order breaks ties
        const ranked = items.map((item) => [score(item), item]).sort((a, b) => b[0] - a[0]);
        return { ...body, collection: ranked.map(([, item]) => item) };
    };

    window.fetch = async (input, init) => {
        const url = searchUrl(input instanceof Request ? input.url : String(input));
        const [response, own] = await Promise.all([window.__scDesktopFetch(input, init), url && ready()]);
        if (!own || !response.ok) return response;
        try {
            const body = personalise(await response.clone().json(), url, own);
            return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch {
            return response;
        }
    };

    const proto = XMLHttpRequest.prototype;
    const { open, send, abort } = proto;
    const text = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
    const raw = Object.getOwnPropertyDescriptor(proto, 'response').get;
    proto.open = function (method, address, ...rest) {
        this.__scSearch = searchUrl(String(address));
        this.__scAborted = false;
        delete this.responseText;
        delete this.response;
        return open.call(this, method, address, ...rest);
    };
    proto.abort = function () {
        this.__scAborted = true;
        return abort.call(this);
    };
    // search held till library is in, then answer read through personalise
    proto.send = function (body) {
        const url = this.__scSearch;
        if (!url) return send.call(this, body);
        ready().then((own) => {
            if (this.__scAborted) return;
            if (own) {
                let personal;
                const read = () => {
                    if (this.readyState !== 4 || this.status !== 200) return null;
                    try {
                        personal ??= personalise(this.responseType === 'json' ? raw.call(this) : JSON.parse(text.call(this)), url, own);
                        return personal;
                    } catch {
                        return null;
                    }
                };
                const asText = () => (read() ? JSON.stringify(read()) : text.call(this));
                Object.defineProperty(this, 'responseText', { configurable: true, get: asText });
                Object.defineProperty(this, 'response', {
                    configurable: true,
                    get: () => (this.responseType === 'json' ? (read() ?? raw.call(this)) : this.responseType === '' || this.responseType === 'text' ? asText() : raw.call(this)),
                });
            }
            send.call(this, body);
        });
    };
})()`;

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
