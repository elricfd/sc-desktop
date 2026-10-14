import { app, type WebContents } from 'electron';
import { chromeBrandList } from './userAgent';

/** Electron's bare "Chromium" brand vs Chrome UA: bot-detection mismatch, add "Google Chrome" brand
 * via devtools, only route keeping Sec-CH-UA and navigator.userAgentData consistent */
export async function presentAsChrome(content: WebContents, secureView: WebContents, userAgent: string): Promise<void> {
    const real = await secureView.executeJavaScript(
        `navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'formFactors', 'model', 'platformVersion', 'uaFullVersion', 'wow64'])`,
    );
    const override = {
        userAgent,
        userAgentMetadata: {
            brands: chromeBrandList(real.uaFullVersion, false),
            fullVersionList: chromeBrandList(real.uaFullVersion, true),
            fullVersion: real.uaFullVersion,
            platform: real.platform,
            platformVersion: real.platformVersion,
            architecture: real.architecture,
            model: real.model,
            mobile: real.mobile,
            bitness: real.bitness,
            wow64: real.wow64,
            formFactors: real.formFactors,
        },
    };
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

    await content.loadURL('about:blank');
    const dbg = content.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setUserAgentOverride', override);

    // cross-site iframes, workers, service worker: separate targets, start paused so override lands first
    // best-effort: not every target has every domain, and targets can vanish mid-setup
    const quiet = (method: string, params: object, sessionId: string) =>
        dbg.sendCommand(method, params, sessionId).catch(() => {});
    const start = async (sessionId: string) => {
        await quiet('Emulation.setUserAgentOverride', override, sessionId);
        await quiet('Target.setAutoAttach', autoAttach, sessionId);
        await quiet('Runtime.runIfWaitingForDebugger', {}, sessionId);
    };
    dbg.on('message', (_event, method, params, sessionId) => {
        if (method === 'Target.attachedToTarget') void start(params.sessionId);
        // restarted service worker keeps session: no attachedToTarget, only this, and it stays paused
        // until told to run, blocking every request of its tabs, reloads included
        else if (method === 'Inspector.targetReloadedAfterCrash' && sessionId) void start(sessionId);
    });
    await dbg.sendCommand('Target.setAutoAttach', autoAttach);

    // debugger attached at shutdown crashes Electron on V8 dispose (SIGTRAP): detach first
    const detach = () => {
        if (!content.isDestroyed() && dbg.isAttached()) dbg.detach();
    };
    app.once('before-quit', detach);
    content.once('destroyed', () => app.off('before-quit', detach));
}
