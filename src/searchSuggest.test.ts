import { describe, expect, it } from 'vitest';
import { readSuggestions, suggestScript } from './utils/searchSuggest';

interface Page {
    hydration?: unknown[];
    resources?: string[];
    cookie?: string;
    /** API answer, keyed by path */
    api?: Record<string, unknown[]>;
}

// run script as page would, page globals stubbed
function run(query: string, page: Page, window: Record<string, unknown> = {}) {
    const asked: { url: URL; authorization?: string }[] = [];
    window.__sc_hydration = page.hydration;
    const document = { cookie: page.cookie ?? '' };
    const performance = { getEntriesByType: () => (page.resources ?? []).map((name) => ({ name })) };
    const fetch = async (address: string, init: { headers: { Authorization?: string } }) => {
        const url = new URL(address);
        asked.push({ url, authorization: init.headers.Authorization });
        return { json: async () => ({ collection: page.api?.[url.pathname] ?? [] }) };
    };
    const result = new Function('window', 'document', 'performance', 'fetch', `return ${suggestScript(query)}`)(
        window,
        document,
        performance,
        fetch,
    ) as Promise<unknown>;
    return result.then((value) => ({ value, asked }));
}

const hydration = [{ hydratable: 'user' }, { hydratable: 'apiClient', data: { id: 'abc' } }];
const queries = { '/search/queries': [{ output: 'flume' }, { output: 'flume remix' }] };

describe('suggestScript', () => {
    it('asks SoundCloud as the page, with the client id the page was given', async () => {
        const { value, asked } = await run('flum', { hydration, api: queries });
        expect(value).toEqual([{ title: 'flume' }, { title: 'flume remix' }]);
        // signed out: searches only, no session sent
        expect(asked.map(({ url }) => url.href)).toEqual([
            'https://api-v2.soundcloud.com/search/queries?q=flum&client_id=abc&limit=10',
        ]);
        expect(asked[0].authorization).toBeUndefined();
    });

    it('puts the account’s own that match first, asked for once per page with its session', async () => {
        const flume = {
            kind: 'user',
            username: 'Flume',
            permalink_url: 'https://soundcloud.com/flume',
            avatar_url: 'a',
        };
        const track = { kind: 'track', title: 'Reflume', permalink_url: 'https://soundcloud.com/x/reflume' };
        const api = {
            ...queries,
            '/me/shortcuts/followings': [flume, { kind: 'user', username: 'Other', permalink_url: 'o' }],
            '/me/shortcuts/track-likes': [track],
            // liked too: listed once
            '/me/shortcuts/own-tracks': [track],
        };
        const window = {};
        const page = { hydration, cookie: 'a=1; oauth_token=2-tok; b=2', api };
        const first = await run('flum', page, window);
        expect(first.value).toEqual([
            { title: 'Flume', url: 'https://soundcloud.com/flume', image: 'a', round: true },
            { title: 'Reflume', url: 'https://soundcloud.com/x/reflume', image: undefined, round: false },
            { title: 'flume' },
            { title: 'flume remix' },
        ]);
        expect(first.asked).toHaveLength(4);
        expect(first.asked.every(({ authorization }) => authorization === 'OAuth 2-tok')).toBe(true);

        const second = await run('oth', page, window);
        expect(second.asked.map(({ url }) => url.pathname)).toEqual(['/search/queries']);
        expect(second.value).toMatchObject([{ title: 'Other' }, { title: 'flume' }, { title: 'flume remix' }]);
    });

    it('falls back to the client id of a request the page has made, and asks nothing without one', async () => {
        const resources = ['https://a-v2.sndcdn.com/app.js', 'https://api-v2.soundcloud.com/me?client_id=xyz'];
        expect((await run('a', { resources })).asked[0].url.searchParams.get('client_id')).toBe('xyz');
        expect(await run('a', {})).toEqual({ value: [], asked: [] });
    });

    it('carries the query as text, whatever is in it', async () => {
        const query = `"); alert(1); (" \${x} \` </script> \\`;
        const { asked } = await run(query, { hydration });
        expect(asked[0].url.searchParams.get('q')).toBe(query);
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
