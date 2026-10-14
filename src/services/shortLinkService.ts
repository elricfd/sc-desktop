import { net, type Session, type WebContents } from 'electron';
import { canonicalUrl, expandShortLinks } from '../utils/shortLinks';

// short link -> target, never changes
const resolved = new Map<string, string>();

function resolve(session: Session, link: string): Promise<string | null> {
    const known = resolved.get(link);
    if (known) return Promise.resolve(known);

    return new Promise((done) => {
        // redirect itself is answer: read, don't follow
        const request = net.request({ url: link, method: 'HEAD', redirect: 'manual', session });
        const finish = (location: string | null) => {
            clearTimeout(timer);
            const url = location && canonicalUrl(location);
            if (url) resolved.set(link, url);
            done(url || null);
        };
        // messages wait on this
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

/** on.soundcloud.com short links in message API responses get swapped for their redirect targets;
 * site only builds players for readable track/playlist urls, rewriting needs `presentAsChrome`'s debugger */
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
            // no body (redirect, preflight)
        }

        const command =
            expanded === null
                ? dbg.sendCommand('Fetch.continueRequest', { requestId })
                : dbg.sendCommand('Fetch.fulfillRequest', {
                      requestId,
                      responseCode: params.responseStatusCode,
                      // body handed over decoded: length changed
                      responseHeaders: (params.responseHeaders as { name: string; value: string }[]).filter(
                          ({ name }) => !/^content-(encoding|length)$/i.test(name),
                      ),
                      body: Buffer.from(expanded).toString('base64'),
                  });
        // tab may be gone by answer time
        command.catch(() => {});
    });

    await dbg.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*://api-v2.soundcloud.com/*conversations*', requestStage: 'Response' }],
    });
}
