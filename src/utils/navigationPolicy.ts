import { shell, type WebContents } from 'electron';

interface NavigationPolicyOptions {
    /** tabs need window.open for third-party sign-in (Google, Apple, Facebook); no other view does */
    allowPopups?: boolean;
    /** called instead of opening window for soundcloud.com link in new tab (cmd/ctrl/middle click, target=_blank) */
    onNewTab?: (url: string, background: boolean) => void;
}

/** left alone, any window.open or target=_blank (incl. from ad frames) makes app window with no URL check
 * popups allowed are held to https and hardened renderer, never more privileged than opener */
export function applyNavigationPolicy(webContents: WebContents, options: NavigationPolicyOptions = {}): void {
    const { allowPopups = false, onNewTab } = options;

    webContents.setWindowOpenHandler(({ url, disposition }) => {
        const isHttps = /^https:\/\//i.test(url);
        const wantsTab = disposition === 'foreground-tab' || disposition === 'background-tab';

        if (onNewTab && wantsTab && /^https:\/\/soundcloud\.com(\/|$)/i.test(url)) {
            onNewTab(url, disposition === 'background-tab');
            return { action: 'deny' };
        }

        if (allowPopups && isHttps) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        webSecurity: true,
                        allowRunningInsecureContent: false,
                        nodeIntegrationInSubFrames: false,
                        nodeIntegrationInWorker: false,
                    },
                },
            };
        }

        // plain links go to user's browser, not in-app
        if (isHttps) void shell.openExternal(url);
        return { action: 'deny' };
    });

    webContents.on('will-navigate', (event, url) => {
        if (/^https?:\/\//i.test(url)) return;

        // file:, javascript:, OS protocol handlers: page must not be able to force these
        event.preventDefault();
        console.warn('Blocked navigation to non-web URL:', url);
    });
}
