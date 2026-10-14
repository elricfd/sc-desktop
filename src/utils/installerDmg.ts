import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export interface MountedImage {
    imagePath: string;
    mountPoints: string[];
}

// hdiutil info: one block per image, split on '=' lines:
// "image-path : /x/y.dmg", then "/dev/diskNsM<TAB>type<TAB>/Volumes/Name" rows
export function parseMountedImages(hdiutilInfo: string): MountedImage[] {
    return hdiutilInfo
        .split(/^=+$/m)
        .map((block) => ({
            imagePath: /^image-path\s*:\s*(.+)$/m.exec(block)?.[1].trim() ?? '',
            mountPoints: [...block.matchAll(/^\/dev\/\S+\t[^\t]*\t(\/.+)$/gm)].map((match) => match[1].trim()),
        }))
        .filter((image) => image.imagePath && image.mountPoints.length > 0);
}

// disk image app was dragged out of, if still mounted
export async function findInstallerDmg(execPath: string): Promise<{ imagePath: string; mountPoint: string } | null> {
    // run straight from image: nothing installed, can't eject under us
    if (process.platform !== 'darwin' || execPath.startsWith('/Volumes/')) return null;

    const bundleName = basename(resolve(execPath, '../../..'));
    const { stdout } = await run('hdiutil', ['info']);
    for (const { imagePath, mountPoints } of parseMountedImages(stdout)) {
        const mountPoint = mountPoints.find((point) => existsSync(join(point, bundleName)));
        if (mountPoint && imagePath.toLowerCase().endsWith('.dmg')) return { imagePath, mountPoint };
    }
    return null;
}

export async function ejectDmg(mountPoint: string): Promise<void> {
    await run('hdiutil', ['detach', mountPoint]);
}
