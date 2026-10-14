import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/** ipcMain is one bus for all renderers, incl. soundcloud.com tabs and ad frames: privileged handlers
 * only accept views built by app itself (markTrustedSender), never tabs */
const trustedSenderIds = new Set<number>();

export function markTrustedSender(webContents: WebContents): void {
    trustedSenderIds.add(webContents.id);

    // ids recycled: stale entry would silently grant trust to later view
    webContents.once('destroyed', () => {
        trustedSenderIds.delete(webContents.id);
    });
}

export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return trustedSenderIds.has(event.sender.id);
}

/** wrap `ipcMain.on` listener: drop messages from untrusted renderers */
export function trustedOn<T extends unknown[]>(
    handler: (event: IpcMainEvent, ...args: T) => void,
    channel = 'ipc',
): (event: IpcMainEvent, ...args: T) => void {
    return (event, ...args) => {
        if (!isTrustedSender(event)) {
            console.warn(`Ignored "${channel}" from an untrusted renderer`);
            return;
        }
        handler(event, ...args);
    };
}

/** wrap `ipcMain.handle` handler: untrusted renderers get rejection, not result */
export function trustedHandle<T extends unknown[], R>(
    handler: (event: IpcMainInvokeEvent, ...args: T) => R,
    channel = 'ipc',
): (event: IpcMainInvokeEvent, ...args: T) => R | Promise<never> {
    return (event, ...args) => {
        if (!isTrustedSender(event)) {
            console.warn(`Rejected "${channel}" from an untrusted renderer`);
            return Promise.reject(new Error(`Blocked ${channel}`));
        }
        return handler(event, ...args);
    };
}
