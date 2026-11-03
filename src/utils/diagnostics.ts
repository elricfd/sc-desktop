import { app, crashReporter, powerMonitor } from 'electron';
import { mkdirSync, openSync, renameSync, statSync, writeSync } from 'fs';
import { join } from 'path';
import { format } from 'util';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** console also to <dir>/main.log; written per line so app killed while frozen keeps last lines
 * rotated at start only: one main.old.log kept */
export function startLogFile(dir = app.getPath('logs')): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'main.log');
    try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, join(dir, 'main.old.log'));
    } catch {
        // no log yet
    }

    const fd = openSync(file, 'a');
    for (const level of LEVELS) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            original(...args);
            try {
                writeSync(fd, `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`);
            } catch {
                // disk full or gone: console still works
            }
        };
    }
    console.log(`--- SoundCloud ${app.getVersion()} on ${process.platform} ${process.arch}`);
    return file;
}

/** dumps stay in crashDumps folder, never uploaded; errors and dead child processes logged */
export function startCrashReports(): void {
    crashReporter.start({ uploadToServer: false });
    process.on('uncaughtExceptionMonitor', (error) => console.error('Uncaught exception:', error));
    process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
    app.on('child-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit') console.error(`${details.type} process gone (${details.reason})`, details);
    });
}

/** main thread blocked past threshold: logged once it frees up; sleep logged too, as it looks like stall */
export function watchStalls(threshold = 2000, interval = 500): NodeJS.Timeout {
    for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) {
        powerMonitor.on(event as 'suspend', () => console.log(`System ${event}`));
    }
    let last = Date.now();
    return setInterval(() => {
        const now = Date.now();
        const late = now - last - interval;
        if (late > threshold) console.warn(`Main process stalled ${late}ms`);
        last = now;
    }, interval).unref();
}
