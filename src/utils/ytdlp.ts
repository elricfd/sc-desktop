import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';

export const DEFAULT_TEMPLATE = '%(uploader)s - %(title)s.%(ext)s';
// `playlist_release_year` not yt-dlp field: buildArgs passes it in
export const DEFAULT_FOLDER = '%(playlist_uploader)s - %(playlist_title)s';

const PROGRESS_PREFIX = 'SCRPC_PROGRESS ';
const FILE_PREFIX = 'SCRPC_FILE ';
const PLAYLIST_PREFIX = 'SCRPC_PLAYLIST ';
const TRACK_PREFIX = 'SCRPC_TRACK ';

// JSON per progress tick; `|null` so missing fields print as null, not bare NA; `j` keeps titles ASCII
const PROGRESS_FIELDS = {
    status: 'progress.status',
    downloaded: 'progress.downloaded_bytes',
    total: 'progress.total_bytes',
    estimate: 'progress.total_bytes_estimate',
    speed: 'progress.speed',
    eta: 'progress.eta',
    title: 'info.title',
    index: 'info.playlist_index',
    count: 'info.n_entries',
};
const PROGRESS_TEMPLATE =
    `download:${PROGRESS_PREFIX}{` +
    Object.entries(PROGRESS_FIELDS)
        .map(([key, field]) => `"${key}":%(${field}|null)j`)
        .join(',') +
    '}';

export interface DownloadOptions {
    folder: string;
    template: string;
    /** account options from `authConfig`, read from stdin */
    auth?: boolean;
    /** playlist positions to fetch: those left without file by first pass */
    items?: number[];
    /** embed cover and tags; needs ffmpeg, see `hasFfmpeg` */
    tags?: boolean;
    /** folder template for albums and playlists, before `template`; blank for none */
    playlistFolder?: string;
    /** release year, from `playlistArgs` */
    year?: number | null;
    /** replaces FORMAT, for non-SoundCloud downloads */
    format?: string;
}

/** albums and playlists, both under /sets/ */
export function isSet(url: string): boolean {
    try {
        return new URL(url).pathname.includes('/sets/');
    } catch {
        return false;
    }
}

export interface PlaylistInfo {
    year: number | null;
    /** cover path, or null if none */
    cover: string | null;
}

/** quick first run for albums and playlists, for year and cover, which full runs cannot give
 * (no year per track, no cover once tracks embed theirs); cover goes to `folder`, see `parsePlaylist` */
export function playlistArgs(url: string, options: { auth?: boolean; folder: string; cover: string }): string[] {
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        // list only, no lookup
        '--flat-playlist',
        '--write-thumbnail',
        '-P',
        options.folder,
        '-o',
        `pl_thumbnail:${options.cover}`,
        '--print',
        `playlist:${PLAYLIST_PREFIX}{"year":%(release_year|null)j,"cover":%(thumbnails.:.filepath|null)j}`,
        '--',
        url,
    ];
}

export function parsePlaylist(line: string): PlaylistInfo | null {
    if (!line.startsWith(PLAYLIST_PREFIX)) return null;
    try {
        const raw = JSON.parse(line.slice(PLAYLIST_PREFIX.length)) as Record<string, unknown>;
        // one entry per cover size, path only for written one
        const covers: unknown[] = Array.isArray(raw.cover) ? raw.cover : [];
        const cover = covers.find((path): path is string => typeof path === 'string') ?? null;
        return { year: numberOrNull(raw.year), cover };
    } catch {
        return null;
    }
}

/** yt-dlp sign-in options for app account: Go+ streams, uploader originals; on stdin, off command line
 * cookie token is parsed as options: plain tokens only, else `--exec` can be injected */
export function authConfig(token: string): string | null {
    return /^[A-Za-z0-9_-]{1,256}$/.test(token) ? `--username oauth\n--password ${token}\n` : null;
}

// uploader's original when offered (signed-in only), else best full stream; previews excluded,
// since unplayable Go+ track would "succeed" as its 30s sample
const FORMAT = 'download/bestaudio[format_id!*=preview]';

// saved as served, no conversion: re-encoding lossy to FLAC/WAV only bloats it and claims lossless
// cover and tags go into container; audio copied as is
export function buildArgs(url: string, options: DownloadOptions): string[] {
    const file = options.template.trim() || DEFAULT_TEMPLATE;
    const folder = options.playlistFolder?.trim();
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        ...(options.items?.length ? ['--playlist-items', options.items.join(',')] : []),
        ...(options.tags ? ['--embed-thumbnail', '--embed-metadata'] : []),
        // per-track field for folder template to use
        ...(options.year ? ['--parse-metadata', `${options.year}:%(playlist_release_year)s`] : []),
        '--newline',
        // --print implies --quiet, which drops progress lines
        '--progress',
        '--progress-template',
        PROGRESS_TEMPLATE,
        '--print',
        // printed before cover and tags are written, so files that cannot take them (WAV) still count as saved;
        // position rides along: files already present report no progress
        `post_process:${FILE_PREFIX}{"file":%(filepath)j,"index":%(playlist_index|null)j,"count":%(n_entries|null)j}`,
        '-f',
        options.format ?? FORMAT,
        '-P',
        options.folder,
        '-o',
        folder ? `${folder}/${file}` : file,
        // rest is URLs, never options
        '--',
        url,
    ];
}

/** skip reason for popup, or null for other lines; read off failure, no up-front lookup
 * (per-track lookups would double requests) */
export function skipReason(line: string): string | null {
    if (!line.startsWith('ERROR:')) return null;
    if (/DRM protected/i.test(line)) return 'DRM-protected';
    // only previews left, which FORMAT refuses
    if (/Requested format is not available/i.test(line)) return 'Go+ only';
    if (/HTTP Error 40[13]/.test(line)) return 'not authorized';
    return null;
}

/** track id from DRM error line; line gives nothing else */
export function drmId(line: string): string | null {
    return /^ERROR: \[soundcloud\] (\d+): .*DRM protected/i.exec(line)?.[1] ?? null;
}

/** DRM-protected track as SoundCloud describes it: `name` for popup list, rest to find it elsewhere */
export interface TrackInfo {
    id: string;
    name: string;
    artist: string;
    title: string;
    duration: number | null;
}

/** describe-only run (no download) for these track ids: DRM list, and lookups elsewhere
 * `--ignore-no-formats-error` lets yt-dlp reach their titles, see `parseTrack` */
export function lookupArgs(ids: string[], options: { auth?: boolean } = {}): string[] {
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        '--ignore-no-formats-error',
        '--print',
        `pre_process:${TRACK_PREFIX}{"id":%(id)j,"uploader":%(uploader|null)j,"artist":%(artists.0|null)j,` +
            `"title":%(title|null)j,"duration":%(duration|null)j}`,
        '--',
        ...ids.map((id) => `https://api.soundcloud.com/tracks/${id}`),
    ];
}

export function parseTrack(line: string): TrackInfo | null {
    if (!line.startsWith(TRACK_PREFIX)) return null;
    try {
        const raw = JSON.parse(line.slice(TRACK_PREFIX.length)) as Record<string, unknown>;
        const name = [raw.uploader, raw.title].filter((part) => part && typeof part === 'string').join(' - ');
        if (typeof raw.id !== 'string' || !name) return null;
        return {
            id: raw.id,
            name,
            // credited artist, not label's own account
            artist: stringOrNull(raw.artist) ?? stringOrNull(raw.uploader) ?? '',
            title: stringOrNull(raw.title) ?? '',
            duration: numberOrNull(raw.duration),
        };
    } catch {
        return null;
    }
}

const query = (track: TrackInfo) => `${track.artist} ${track.title}`.trim();

/** YouTube copy for DRM-protected tracks; lower quality, m4a so cover and tags fit */
export function searchArgs(track: TrackInfo, options: { folder: string; tags?: boolean }): string[] {
    // SoundCloud's name, as hit titles are guesses; literal template text: no separators or bare %
    const name = [track.artist, track.title]
        .filter(Boolean)
        .join(' - ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/%/g, '%%');
    return buildArgs(`ytsearch1:${query(track)}`, {
        ...options,
        template: `${name}.%(ext)s`,
        format: 'bestaudio[ext=m4a]/bestaudio',
    });
}

export const deezerSearchUrl = (track: TrackInfo) =>
    `https://api.deezer.com/search?${new URLSearchParams({ q: query(track), limit: '5' })}`;

/** Deezer track address for deemix, from `deezerSearchUrl` answer: first hit of matching length
 * (search always finds something); only plain track links pass, since it goes to external program */
export function pickDeezer(body: unknown, duration: number | null): string | null {
    const hits: unknown = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(hits)) return null;
    const hit = hits.find(
        (entry) =>
            /^https:\/\/www\.deezer\.com\/track\/\d+$/.test(entry?.link) &&
            (duration === null || Math.abs(entry.duration - duration) <= 5),
    );
    return hit?.link ?? null;
}

export interface DownloadProgress {
    status: string | null;
    downloaded: number | null;
    total: number | null;
    speed: number | null;
    eta: number | null;
    title: string | null;
    index: number | null;
    count: number | null;
}

export type YtDlpLine =
    | { progress: DownloadProgress }
    | { file: string; index: number | null; count: number | null }
    | null;

const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

export function parseLine(line: string): YtDlpLine {
    try {
        if (line.startsWith(FILE_PREFIX)) {
            const raw = JSON.parse(line.slice(FILE_PREFIX.length)) as Record<string, unknown>;
            return typeof raw.file === 'string'
                ? { file: raw.file, index: numberOrNull(raw.index), count: numberOrNull(raw.count) }
                : null;
        }
        if (line.startsWith(PROGRESS_PREFIX)) {
            const raw = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Record<string, unknown>;
            const downloaded = numberOrNull(raw.downloaded);
            const total = numberOrNull(raw.total) ?? numberOrNull(raw.estimate);
            const speed = numberOrNull(raw.speed);
            return {
                progress: {
                    status: stringOrNull(raw.status),
                    downloaded,
                    total,
                    speed,
                    // no ETA from yt-dlp for SoundCloud's HLS streams: compute it
                    eta:
                        numberOrNull(raw.eta) ??
                        (downloaded !== null && total && speed ? Math.max(0, total - downloaded) / speed : null),
                    title: stringOrNull(raw.title),
                    index: numberOrNull(raw.index),
                    count: numberOrNull(raw.count),
                },
            };
        }
    } catch {
        // cut-short line, or NaN in field
    }
    return null;
}

// packaged GUI apps get bare PATH on macOS/Linux: add usual install dirs
// same list is yt-dlp's PATH, so it finds ffmpeg for HLS streams
export function searchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    return [
        ...(env.PATH ?? '').split(delimiter),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local', 'bin'),
    ].filter(Boolean);
}

const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** `customPath` wins outright when set, so typos get reported instead of silently ignored */
export function findYtDlp(customPath: string, dirs = searchDirs()): string | null {
    const candidates = customPath.trim() ? [customPath.trim()] : dirs.map((dir) => join(dir, executable('yt-dlp')));
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** whether yt-dlp can write covers and tags; without ffmpeg each track fails and leaves loose
 * cover images, so tags are only asked for when ffmpeg is present */
export function hasFfmpeg(dirs = searchDirs()): boolean {
    return dirs.some((dir) => existsSync(join(dir, executable('ffmpeg'))));
}
