// Electron's UA minus app-name and Electron/<ver> tokens; Chrome version cut to MAJOR.0.0.0 as Chrome sends it.
// platform and major stay genuine so client hints agree with UA
export function deriveBrowserUserAgent(electronUserAgent: string, appName: string): string {
    const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return electronUserAgent
        .replace(new RegExp(`\\s?${escaped}/\\S+`), '')
        .replace(/\s?Electron\/\S+/, '')
        .replace(/(Chrome\/\d+)\.\S+/, '$1.0.0.0')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export interface UaBrand {
    brand: string;
    version: string;
}

// client-hint brands Chrome build reports; same algorithm as Chromium's GenerateBrandVersionList
// (grease, version, order seeded by major); Electron omits "Google Chrome" entry
export function chromeBrandList(chromiumVersion: string, full: boolean): UaBrand[] {
    const major = parseInt(chromiumVersion, 10);
    const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
    const version = full ? chromiumVersion : String(major);
    const grease = {
        brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`,
        version: ['8', '99', '24'][major % 3] + (full ? '.0.0.0' : ''),
    };

    const order = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ][major % 6];
    const list: UaBrand[] = [];
    list[order[0]] = grease;
    list[order[1]] = { brand: 'Chromium', version };
    list[order[2]] = { brand: 'Google Chrome', version };
    return list;
}
