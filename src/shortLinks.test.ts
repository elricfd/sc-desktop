import { describe, expect, it } from 'vitest';
import { canonicalUrl, expandShortLinks } from './utils/shortLinks';

describe('canonicalUrl', () => {
    it('keeps the address and drops the tracking', () => {
        expect(canonicalUrl('https://soundcloud.com/user/track?ref=sc-messaging&si=ABC&utm_source=x')).toBe(
            'https://soundcloud.com/user/track',
        );
        expect(canonicalUrl('https://soundcloud.com/user/track/s-AbC123?si=ABC')).toBe(
            'https://soundcloud.com/user/track/s-AbC123',
        );
    });

    it('refuses anything that is not https://soundcloud.com', () => {
        expect(canonicalUrl('https://soundcloud.com.evil.example/user/track')).toBeNull();
        expect(canonicalUrl('https://evil.example/soundcloud.com/user')).toBeNull();
        expect(canonicalUrl('http://soundcloud.com/user/track')).toBeNull();
        expect(canonicalUrl('nonsense')).toBeNull();
    });
});

describe('expandShortLinks', () => {
    const resolve = async (link: string) =>
        link === 'https://on.soundcloud.com/abc123' ? 'https://soundcloud.com/user/track' : null;

    it('replaces the links that resolve and leaves the rest alone', async () => {
        const body =
            '{"content":"https://on.soundcloud.com/abc123 and on.soundcloud.com/abc123, not https://on.soundcloud.com/gone"}';
        expect(await expandShortLinks(body, resolve)).toBe(
            '{"content":"https://soundcloud.com/user/track and https://soundcloud.com/user/track, not https://on.soundcloud.com/gone"}',
        );
    });

    it('looks a repeated link up once, and nothing up in text without links', async () => {
        const seen: string[] = [];
        const counting = async (link: string) => (seen.push(link), null);

        await expandShortLinks('on.soundcloud.com/abc123 https://on.soundcloud.com/abc123', counting);
        await expandShortLinks('https://soundcloud.com/user/track https://xon.soundcloud.com/abc123', counting);
        expect(seen).toEqual(['https://on.soundcloud.com/abc123']);
    });
});
