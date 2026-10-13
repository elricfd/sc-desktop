import { app } from 'electron';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { installedBundle, swapArgs, updateZip } from '../utils/macUpdate';

let staged = false;

/**
 * Updates the app on macOS, where Electron's own updater only takes over a build signed with an
 * Apple Developer ID, which these are not: it checks that the new build is signed by whoever
 * signed the running one.
 *
 * So the release's zip is fetched here, checked against the checksum in the release's manifest,
 * and unpacked next to the installed app; when the app quits, the new bundle takes the old one's
 * place. Nothing marks the download as quarantined, so macOS opens it without asking again.
 *
 * Resolves to whether an update is now waiting for the app to quit. Throws when it could not be
 * fetched or unpacked, e.g. because the folder the app is in cannot be written to.
 */
export async function stageMacUpdate(version: unknown, files: unknown): Promise<boolean> {
    const bundle = installedBundle(process.execPath);
    const zip = updateZip(version, files);
    if (staged || !bundle || !zip) return false;
    // one at a time: a second check for updates finds the same one
    staged = true;

    const staging = join(dirname(bundle), '.sc-desktop-update');
    try {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);

        const archive = join(staging, 'update.zip');
        const response = await fetch(zip.url);
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${zip.url}`);
        const hash = createHash('sha512');
        await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            async function* (chunks: AsyncIterable<Buffer>) {
                for await (const chunk of chunks) {
                    hash.update(chunk);
                    yield chunk;
                }
            },
            createWriteStream(archive),
        );
        if (hash.digest('base64') !== zip.sha512) throw new Error('the update does not match its checksum');

        // ditto, not unzip: it keeps the links, permissions and signature of an app bundle
        await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', archive, staging]);
        rmSync(archive);
        const name = readdirSync(staging).find((entry) => entry.endsWith('.app'));
        if (!name || !existsSync(join(staging, name, 'Contents', 'Info.plist'))) {
            throw new Error('the update holds no app');
        }

        app.once('quit', () => {
            // outlives the app, which it waits for
            spawn('/bin/sh', swapArgs(process.pid, bundle, join(staging, name), staging), {
                detached: true,
                stdio: 'ignore',
            }).unref();
        });
        return true;
    } catch (error) {
        staged = false;
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}
