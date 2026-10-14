import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { installedBundle, swapArgs, updateZip } from './utils/macUpdate';

describe('installedBundle', () => {
    it('finds the app the executable runs from', () => {
        expect(installedBundle('/Applications/SoundCloud.app/Contents/MacOS/SoundCloud')).toBe(
            '/Applications/SoundCloud.app',
        );
        expect(installedBundle('/Users/a/Apps/Sound Cloud.app/Contents/MacOS/SoundCloud')).toBe(
            '/Users/a/Apps/Sound Cloud.app',
        );
    });

    it('is nowhere to update when run off the disk image, from a translocated copy or outside an app', () => {
        expect(installedBundle('/Volumes/SoundCloud/SoundCloud.app/Contents/MacOS/SoundCloud')).toBeNull();
        expect(
            installedBundle('/private/var/folders/x/T/AppTranslocation/1-2/d/SoundCloud.app/Contents/MacOS/SoundCloud'),
        ).toBeNull();
        expect(installedBundle('/Users/a/sc-desktop/node_modules/electron/dist/electron')).toBeNull();
        expect(installedBundle('C:\\Program Files\\SoundCloud\\SoundCloud.exe')).toBeNull();
    });
});

describe('updateZip', () => {
    const files = [
        { url: 'soundcloud-1.2.1-beta-mac.dmg', sha512: 'ddd' },
        { url: 'soundcloud-1.2.1-beta-mac.zip', sha512: 'zzz' },
    ];

    it('takes the zip of the release and its checksum from the manifest', () => {
        expect(updateZip('1.2.1-beta', files)).toEqual({
            url: 'https://github.com/elricfd/sc-desktop/releases/download/v1.2.1-beta/soundcloud-1.2.1-beta-mac.zip',
            sha512: 'zzz',
        });
    });

    it('has nothing for a release without one, or for anything that is not a plain version and file name', () => {
        expect(updateZip('1.2.0-beta', [files[0]])).toBeNull();
        expect(updateZip('1.2.1/../../x', files)).toBeNull();
        expect(updateZip('1.2.1', [{ url: '../../evil/x.zip', sha512: 'a' }])).toBeNull();
        expect(updateZip('1.2.1', [{ url: 'https://evil.example/x.zip', sha512: 'a' }])).toBeNull();
        expect(updateZip('1.2.1', [{ url: 'x.zip' }])).toBeNull();
        expect(updateZip('1.2.1', null)).toBeNull();
        expect(updateZip(undefined, files)).toBeNull();
    });
});

// kill -0 etc. match macOS on any POSIX system; Windows has no /bin/sh
describe.skipIf(process.platform === 'win32')('the swap that runs as the app quits', () => {
    function setUp() {
        const root = mkdtempSync(join(tmpdir(), 'sc-desktop-swap-'));
        const bundle = join(root, 'Sound Cloud.app');
        const staging = join(root, '.sc-desktop-update');
        mkdirSync(bundle);
        writeFileSync(join(bundle, 'old'), '');
        mkdirSync(join(staging, 'Sound Cloud.app'), { recursive: true });
        writeFileSync(join(staging, 'Sound Cloud.app', 'new'), '');
        return { root, bundle, staging, staged: join(staging, 'Sound Cloud.app') };
    }

    it('waits for the app to be gone, then puts the new bundle in the old one’s place', async () => {
        const { root, bundle, staging, staged } = setUp();
        const running = spawn('sleep', ['1']);
        const exited = new Promise((resolve) => running.once('exit', resolve));
        // not spawnSync: "app" is our child, alive in process table until collected
        const status = await new Promise((resolve) =>
            spawn('/bin/sh', swapArgs(running.pid!, bundle, staged, staging)).once('close', resolve),
        );
        expect(status).toBe(0);
        // only gets here once "app" has exited
        expect(await exited).toBe(0);
        expect(existsSync(join(bundle, 'new'))).toBe(true);
        expect(existsSync(join(bundle, 'old'))).toBe(false);
        expect(existsSync(`${bundle}.old`)).toBe(false);
        expect(existsSync(staging)).toBe(false);
        rmSync(root, { recursive: true });
    });

    it('puts the old bundle back when the new one cannot be moved in', () => {
        const { root, bundle, staging } = setUp();
        // pid of already-exited process
        const gone = spawnSync('true').pid;
        spawnSync('/bin/sh', swapArgs(gone, bundle, join(staging, 'missing.app'), staging));
        expect(existsSync(join(bundle, 'old'))).toBe(true);
        expect(existsSync(`${bundle}.old`)).toBe(false);
        rmSync(root, { recursive: true });
    });
});
