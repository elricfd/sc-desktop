import { posix } from 'path';

const RELEASES = 'https://github.com/elricfd/sc-desktop/releases/download';

/**
 * The .app this executable runs from, or null when that is no place to update: still on the disk
 * image it came on, or run by macOS from a read-only copy elsewhere, as it does with an app that
 * was never moved out of Downloads.
 */
export function installedBundle(execPath: string): string | null {
    // <bundle>.app/Contents/MacOS/<name>
    const bundle = posix.resolve(execPath, '../../..');
    if (!execPath.startsWith('/') || !bundle.endsWith('.app')) return null;
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return null;
    return bundle;
}

/**
 * Where to get the zip of a release, and the checksum it has to have, out of the `files` of the
 * release's manifest. Both are put into an address and compared against a download, so anything
 * but a plain version and file name is refused.
 */
export function updateZip(version: unknown, files: unknown): { url: string; sha512: string } | null {
    if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version) || !Array.isArray(files)) return null;
    const file = files.find(
        (entry) =>
            typeof entry?.sha512 === 'string' && typeof entry.url === 'string' && /^[\w.+-]+\.zip$/.test(entry.url),
    );
    return file ? { url: `${RELEASES}/v${version}/${file.url}`, sha512: file.sha512 } : null;
}

// Run as the app quits, since a bundle cannot be replaced under a running app: waits for the app
// ($1, its pid) to be gone, then puts the new bundle ($3) where the old one is ($2). The old one is
// only moved aside until the new one is in place, and put back if that fails. $4 is the folder the
// new one was unpacked in.
const SWAP_SCRIPT = `
tries=0
while kill -0 "$1" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -gt 300 ] && exit 1
    sleep 0.2
done
rm -rf "$2.old"
mv "$2" "$2.old" || exit 1
if mv "$3" "$2"; then
    rm -rf "$2.old" "$4"
else
    mv "$2.old" "$2"
fi
`;

/** Arguments for /bin/sh. The paths are handed over as parameters, never written into the script. */
export function swapArgs(pid: number, bundle: string, staged: string, staging: string): string[] {
    return ['-c', SWAP_SCRIPT, 'sh', String(pid), bundle, staged, staging];
}
