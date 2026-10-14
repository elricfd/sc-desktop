import { posix } from 'path';

const RELEASES = 'https://github.com/elricfd/sc-desktop/releases/download';

/** .app this executable runs from, or null if no place to update: disk image, or translocated copy */
export function installedBundle(execPath: string): string | null {
    // <bundle>.app/Contents/MacOS/<name>
    const bundle = posix.resolve(execPath, '../../..');
    if (!execPath.startsWith('/') || !bundle.endsWith('.app')) return null;
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return null;
    return bundle;
}

/** zip url and sha512 from release manifest's `files`, both checked against download
 * so only plain version and file names pass */
export function updateZip(version: unknown, files: unknown): { url: string; sha512: string } | null {
    if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version) || !Array.isArray(files)) return null;
    const file = files.find(
        (entry) =>
            typeof entry?.sha512 === 'string' && typeof entry.url === 'string' && /^[\w.+-]+\.zip$/.test(entry.url),
    );
    return file ? { url: `${RELEASES}/v${version}/${file.url}`, sha512: file.sha512 } : null;
}

// runs at quit, as running bundle cannot be replaced: waits for pid $1, then swaps $3 in for $2
// $2 is moved aside and restored on failure; $4 is unpack folder
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

/** args for /bin/sh; paths passed as parameters, never written into script */
export function swapArgs(pid: number, bundle: string, staged: string, staging: string): string[] {
    return ['-c', SWAP_SCRIPT, 'sh', String(pid), bundle, staged, staging];
}
