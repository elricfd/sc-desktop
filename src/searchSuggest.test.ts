import { describe, expect, it } from 'vitest';
import { personalSearchScript, readSuggestions, suggestScript } from './utils/searchSuggest';

interface Page {
    hydration?: unknown[];
    resources?: string[];
    cookie?: string;
    /** API answer, keyed by path */
    api?: Record<string, unknown>;
}

// XHR answering `FakeXHR.answer` once sent
class FakeXHR {
    static answer = '';
    readyState = 1;
    status = 0;
    responseType = '';
    onload?: () => void;
    open(...request: [string, string]) {
        return request;
    }
    abort() {}
    send() {
        this.readyState = 4;
        this.status = 200;
        this.onload?.();
    }
    get responseText() {
        return FakeXHR.answer;
    }
    get response() {
        return FakeXHR.answer;
    }
}

// page globals stubbed, shared by scripts run on same page
function page({ hydration, resources = [], cookie = '', api = {} }: Page) {
    const asked: { url: URL; authorization?: string }[] = [];
    const fetch = async (address: string, init?: { headers?: { Authorization?: string } }) => {
        const url = new URL(address);
        asked.push({ url, authorization: init?.headers?.Authorization });
        return new Response(JSON.stringify(api[url.pathname] ?? {}));
    };
    const window: Record<string, unknown> = { __sc_hydration: hydration, fetch };
    const globals = {
        window,
        document: { cookie },
        performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
        location: { href: 'https://soundcloud.com/search?q=hi' },
        XMLHttpRequest: FakeXHR,
    };
    const run = (script: string) =>
        new Function(...Object.keys(globals), `return ${script}`)(...Object.values(globals)) as unknown;
    const search = (address: string) => (window.fetch as typeof fetch)(address).then((answer) => answer.json());
    return { window, asked, run, search, suggest: (query: string) => run(suggestScript(query)) as Promise<unknown> };
}

const hydration = [{ hydratable: 'user' }, { hydratable: 'apiClient', data: { id: 'abc' } }];
const flume = {
    kind: 'user',
    id: 1,
    username: 'Flume',
    permalink_url: 'https://soundcloud.com/flume',
    avatar_url: 'a',
};
const track = (id: number, title: string, user_id = 9, genre = '') => ({
    kind: 'track',
    id,
    title,
    user_id,
    genre,
    permalink_url: `https://soundcloud.com/x/${id}`,
});
const library = {
    '/me': { id: 7 },
    '/users/7/track_likes': {
        collection: [
            { track: track(10, 'Hi There', 1, 'House') },
            { track: track(11, 'Say Hi', 2) },
            { track: track(12, 'Other') },
        ],
    },
    '/users/7/followings': { collection: [flume, { kind: 'user', id: 3, username: 'Hiatus' }] },
};
const signedIn = { hydration, cookie: 'a=1; oauth_token=2-tok; b=2', api: library };

describe('suggestScript', () => {
    it('lists only the account’s own matching follows and likes, library asked once per page with its session', async () => {
        const tab = page(signedIn);
        expect(await tab.suggest('hi')).toEqual([
            { title: 'Hiatus', url: undefined, image: undefined, round: true },
            { title: 'Hi There', url: 'https://soundcloud.com/x/10', image: undefined, round: false },
            { title: 'Say Hi', url: 'https://soundcloud.com/x/11', image: undefined, round: false },
        ]);
        expect(tab.asked.map(({ url }) => url.pathname)).toEqual([
            '/me',
            '/users/7/track_likes',
            '/users/7/followings',
        ]);
        expect(
            tab.asked.every(
                ({ url, authorization }) =>
                    authorization === 'OAuth 2-tok' && url.searchParams.get('client_id') === 'abc',
            ),
        ).toBe(true);

        expect(await tab.suggest('flu')).toMatchObject([{ title: 'Flume', round: true }]);
        expect(tab.asked).toHaveLength(3);
    });

    it('asks nothing signed out, and falls back to the client id a page request carried', async () => {
        const signedOut = page({ hydration });
        expect(await signedOut.suggest('hi')).toEqual([]);
        expect(signedOut.asked).toEqual([]);

        const resources = ['https://a-v2.sndcdn.com/app.js', 'https://api-v2.soundcloud.com/me?client_id=xyz'];
        const fallback = page({ ...signedIn, hydration: undefined, resources });
        await fallback.suggest('hi');
        expect(fallback.asked[0].url.searchParams.get('client_id')).toBe('xyz');
    });

    it('matches the query as text, whatever is in it', async () => {
        const query = `"); alert(1); (" \${x} \` </script> \\`;
        expect(await page(signedIn).suggest(query)).toEqual([]);
    });
});

describe('personalSearchScript', () => {
    // SoundCloud's order: stranger, followed artist, liked track, stranger in liked genre, followed user
    const results = {
        collection: [
            track(20, 'hi stranger', 50),
            track(21, 'hi flume', 1),
            track(11, 'Say Hi', 2),
            track(22, 'hi house', 51, 'house'),
            { kind: 'user', id: 3 },
        ],
        next_href: 'n',
    };
    const ids = (body: { collection: { id: number }[] }) => body.collection.map((item) => item.id);
    // 10 liked match put first, 11 liked, 21 by followed and liked artist, 3 followed, 22 liked genre
    const personal = [10, 11, 21, 3, 22, 20];

    it('leads the first page with liked matches, then liked tracks, liked or followed artists and liked genres', async () => {
        const tab = page({ ...signedIn, api: { ...library, '/search/tracks': results } });
        tab.run(personalSearchScript);
        const first = await tab.search('https://api-v2.soundcloud.com/search/tracks?q=Hi&limit=20');
        expect(ids(first)).toEqual(personal);
        expect(first.next_href).toBe('n');

        // later page: liked matches already shown stay off
        expect(ids(await tab.search('https://api-v2.soundcloud.com/search/tracks?q=Hi&offset=20'))).toEqual([
            21, 3, 22, 20,
        ]);
        // other answers untouched
        expect(await tab.search('https://api-v2.soundcloud.com/search/users?q=Hi')).toEqual({});
    });

    it('reorders XHR search answers too, sent once the library is in', async () => {
        const tab = page(signedIn);
        tab.run(personalSearchScript);
        FakeXHR.answer = JSON.stringify(results);
        const xhr = new FakeXHR();
        const loaded = new Promise<void>((done) => (xhr.onload = done));
        xhr.open('GET', 'https://api-v2.soundcloud.com/search?q=hi');
        xhr.send();
        expect(xhr.readyState).toBe(1);
        await loaded;
        expect(ids(JSON.parse(xhr.responseText))).toEqual(personal);
        expect(xhr.response).toBe(xhr.responseText);

        // aborted while waiting: never sent
        const stale = new FakeXHR();
        stale.open('GET', 'https://api-v2.soundcloud.com/search?q=hi');
        stale.send();
        stale.abort();
        await new Promise((done) => setTimeout(done, 10));
        expect(stale.readyState).toBe(1);
    });

    it('leaves search alone signed out', async () => {
        const tab = page({ hydration, api: { '/search/tracks': results } });
        tab.run(personalSearchScript);
        expect(ids(await tab.search('https://api-v2.soundcloud.com/search/tracks?q=hi'))).toEqual([20, 21, 11, 22, 3]);
    });
});

describe('readSuggestions', () => {
    it('keeps a few short titles, links into soundcloud.com and pictures from its image hosts', () => {
        expect(
            readSuggestions([
                { title: 'a' },
                { title: 'b', url: 'https://soundcloud.com/b', image: 'https://i1.sndcdn.com/b.jpg', round: true },
                { title: 'c', image: 'https://evil.example/c.jpg' },
                // dropped whole
                { title: 'd', url: 'https://evil.example/d' },
                { title: 'e', url: 'javascript:alert(1)' },
                { title: 'x'.repeat(201) },
                { title: 2 },
                'f',
                null,
            ]),
        ).toEqual([
            { title: 'a', url: undefined, image: undefined, round: false },
            { title: 'b', url: 'https://soundcloud.com/b', image: 'https://i1.sndcdn.com/b.jpg', round: true },
            { title: 'c', url: undefined, image: undefined, round: false },
        ]);
        expect(readSuggestions(Array.from({ length: 20 }, (_, i) => ({ title: `${i}` })))).toHaveLength(10);
        expect(readSuggestions(null)).toEqual([]);
        expect(readSuggestions({ collection: [] })).toEqual([]);
    });
});
