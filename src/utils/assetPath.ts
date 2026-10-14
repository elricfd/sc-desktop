import { join, normalize, sep } from 'path';

/** app-scheme asset path kept inside <rootDir>/<host>; attacker-shaped input, so no Electron import */
export function resolveAssetPath(rootDir: string, host: string, pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        // malformed percent-encoding; refuse rather than guess
        return null;
    }

    // NUL can truncate path at syscall boundary on some platforms
    if (decoded.includes('\0')) return null;

    const relative = normalize(decoded).replace(/^([/\\]|\.\.[/\\])+/, '');
    const hostDir = join(rootDir, host);
    const filePath = join(hostDir, relative);

    // join() normalises again: catches anything strip above missed
    return filePath === hostDir || filePath.startsWith(hostDir + sep) ? filePath : null;
}
