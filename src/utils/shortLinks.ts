// scheme optional: message text is whatever sender typed or pasted
const SHORT_LINK = /(?:https?:\/\/)?\bon\.soundcloud\.com\/([A-Za-z0-9]+)/g;

/** short link's redirect target minus tracking params; null unless soundcloud.com */
export function canonicalUrl(location: string): string | null {
    try {
        const url = new URL(location);
        if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com') return null;
        return url.origin + url.pathname;
    } catch {
        return null;
    }
}

/** swaps each on.soundcloud.com link in `text` for `resolve`'s address, if any */
export async function expandShortLinks(
    text: string,
    resolve: (link: string) => Promise<string | null>,
): Promise<string> {
    const ids = [...new Set(Array.from(text.matchAll(SHORT_LINK), (match) => match[1]))];
    if (!ids.length) return text;

    const found = new Map<string, string | null>();
    await Promise.all(ids.map(async (id) => found.set(id, await resolve(`https://on.soundcloud.com/${id}`))));
    return text.replace(SHORT_LINK, (link, id: string) => found.get(id) ?? link);
}
