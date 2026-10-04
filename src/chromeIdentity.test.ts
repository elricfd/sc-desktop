import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { once: vi.fn(), off: vi.fn() } }));

import { presentAsChrome } from './utils/chromeIdentity';

describe('presentAsChrome', () => {
    it('tells a restarted service worker to run, on the session it kept', async () => {
        let onMessage: (...args: unknown[]) => void = () => {};
        const sendCommand = vi.fn(async () => ({}));
        const content = {
            loadURL: async () => {},
            once: vi.fn(),
            debugger: {
                attach: vi.fn(),
                sendCommand,
                on: (_event: string, listener: typeof onMessage) => {
                    onMessage = listener;
                },
            },
        };
        const secureView = { executeJavaScript: async () => ({ uaFullVersion: '146.0.7680.80' }) };
        await presentAsChrome(content as never, secureView as never, 'user agent');

        sendCommand.mockClear();
        onMessage({}, 'Inspector.targetReloadedAfterCrash', {}, 'worker session');
        await vi.waitFor(() =>
            expect(sendCommand).toHaveBeenLastCalledWith('Runtime.runIfWaitingForDebugger', {}, 'worker session'),
        );

        // the tab's own page coming back after a crash is not a child session and was never paused
        sendCommand.mockClear();
        onMessage({}, 'Inspector.targetReloadedAfterCrash', {}, '');
        expect(sendCommand).not.toHaveBeenCalled();
    });
});
