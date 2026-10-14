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

/** macOS update: Electron's updater wants Developer ID signing, which these builds lack;
 * so fetch and checksum zip here, unpack beside app, swap on quit; true if waiting, throws on failure */
export async function stageMacUpdate(version: unknown, files: unknown): Promise<boolean> {
    const bundle = installedBundle(process.execPath);
    const zip = updateZip(version, files);
    if (staged || !bundle || !zip) return false;
    // serial: parallel checks would find same update
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

        // ditto not unzip: keeps links, permissions and signature of app bundle
        await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', archive, staging]);
        rmSync(archive);
        const name = readdirSync(staging).find((entry) => entry.endsWith('.app'));
        if (!name || !existsSync(join(staging, name, 'Contents', 'Info.plist'))) {
            throw new Error('the update holds no app');
        }

        app.once('quit', () => {
            // detached: outlives app, script waits on its pid
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
