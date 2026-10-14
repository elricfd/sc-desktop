import { protocol } from 'electron';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { resolveAssetPath } from './assetPath';

/** app views (settings, toasts, downloads, homepage-confirm): real origin for separate scripts and strict CSP */
export const APP_SCHEME = 'scrpc';

type DocumentProvider = () => string;

const documentProviders = new Map<string, DocumentProvider>();

// before app.whenReady(). supportFetchAPI off: on + corsEnabled off allows cross-origin reads
// (GHSA-v3j7-r9gq-3gjw); these pages have nothing to fetch
export function registerAppScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: APP_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: false,
                corsEnabled: false,
            },
        },
    ]);
}

/** markup per view host, e.g. 'settings'; called every load, so reflects current settings */
export function provideDocument(host: string, provider: DocumentProvider): void {
    documentProviders.set(host, provider);
}

export function appUrl(host: string, path = '/'): string {
    return `${APP_SCHEME}://${host}${path}`;
}

// scripts only from this scheme, never inline; connect-src 'none' leaves nowhere to send data
// 'unsafe-inline' styles for view <style> blocks; theme CSS via insertCSS, which page CSP skips
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    `script-src ${APP_SCHEME}:`,
    `style-src ${APP_SCHEME}: 'unsafe-inline'`,
    `img-src ${APP_SCHEME}: data: https:`,
    'font-src https: data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
};

function securityHeaders(contentType: string): HeadersInit {
    return {
        'Content-Type': contentType,
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
    };
}

/** after `app.whenReady()` */
export function handleAppScheme(): void {
    // compiled to tsc/utils/, so output root (view scripts copied there) is one level up
    const rootDir = join(__dirname, '..');

    protocol.handle(APP_SCHEME, async (request) => {
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return new Response('Bad request', { status: 400 });
        }

        const host = url.hostname;

        if (url.pathname === '/' || url.pathname === '') {
            const provider = documentProviders.get(host);
            if (!provider) return new Response('Not found', { status: 404 });

            return new Response(provider(), {
                headers: securityHeaders('text/html; charset=utf-8'),
            });
        }

        // static asset, confined to view dir so crafted requests can't leave bundle
        const filePath = resolveAssetPath(rootDir, host, url.pathname);
        if (!filePath) return new Response('Forbidden', { status: 403 });

        const extension = extname(filePath).toLowerCase();
        const contentType = CONTENT_TYPES[extension];
        if (!contentType) return new Response('Unsupported type', { status: 415 });

        try {
            const body = await readFile(filePath);
            return new Response(new Uint8Array(body), { headers: securityHeaders(contentType) });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    });
}

/** <meta> equivalent, defence in depth if page loads another way */
export function cspMetaTag(): string {
    return `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY.replace(/"/g, '&quot;')}">`;
}
