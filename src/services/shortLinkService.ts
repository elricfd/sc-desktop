import { net, type Session, type WebContents } from 'electron';
import { canonicalUrl, expandShortLinks } from '../utils/shortLinks';

// what each short link stands for, which never changes
const resolved = new Map<string, string>();

function resolve(session: Session, link: string): Promise<string | null> {
    const known = resolved.get(link);
    if (known) return Promise.resolve(known);

    return new Promise((done) => {
        // the redirect is the answer, so it is read and not followed
        const request = net.request({ url: link, method: 'HEAD', redirect: 'manual', session });
        const finish = (location: string | null) => {
            clearTimeout(timer);
            const url = location && canonicalUrl(location);
            if (url) resolved.set(link, url);
            done(url || null);
        };
        // the messages wait on this
        const timer = setTimeout(() => {
            request.abort();
            finish(null);
        }, 5000);

        request.on('redirect', (_status, _method, location) => finish(location));
        request.on('response', () => finish(null));
        request.on('error', () => finish(null));
        request.end();
    });
}

/**
 * Tracks shared from SoundCloud's mobile apps arrive in messages as on.soundcloud.com short links,
 * which the site leaves as bare links: it only builds a player for an address it can read a track or
 * playlist out of. Swapping in the address each one redirects to, in the API responses messages are
 * loaded from, leaves the rest to the site.
 *
 * Rides on the debugger `presentAsChrome` attaches, the only way to rewrite a response.
 */
export async function expandShortLinksInMessages(webContents: WebContents): Promise<void> {
    const dbg = webContents.debugger;

    dbg.on('message', async (_event, method, params) => {
        if (method !== 'Fetch.requestPaused') return;
        const { requestId } = params;

        let expanded: string | null = null;
        try {
            const { body, base64Encoded } = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
            const text = base64Encoded ? Buffer.from(body, 'base64').toString() : body;
            const result = await expandShortLinks(text, (link) => resolve(webContents.session, link));
            if (result !== text) expanded = result;
        } catch {
            // a response without a body, such as a redirect or a preflight
        }

        const command =
            expanded === null
                ? dbg.sendCommand('Fetch.continueRequest', { requestId })
                : dbg.sendCommand('Fetch.fulfillRequest', {
                      requestId,
                      responseCode: params.responseStatusCode,
                      // the body is handed over decoded, and is now a different length
                      responseHeaders: (params.responseHeaders as { name: string; value: string }[]).filter(
                          ({ name }) => !/^content-(encoding|length)$/i.test(name),
                      ),
                      body: Buffer.from(expanded).toString('base64'),
                  });
        // the tab can be gone by the time the answer is ready
        command.catch(() => {});
    });

    await dbg.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*://api-v2.soundcloud.com/*conversations*', requestStage: 'Response' }],
    });
}
