import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';

export const DEFAULT_TEMPLATE = '%(uploader)s - %(title)s.%(ext)s';
// `playlist_release_year` is not a yt-dlp field: buildArgs hands it in
export const DEFAULT_FOLDER = '%(playlist_uploader)s - %(playlist_title)s';

const PROGRESS_PREFIX = 'SCRPC_PROGRESS ';
const FILE_PREFIX = 'SCRPC_FILE ';
const PLAYLIST_PREFIX = 'SCRPC_PLAYLIST ';
const TRACK_PREFIX = 'SCRPC_TRACK ';

// One JSON object per progress tick. `|null` because a missing field would otherwise print as a
// bare NA, and `j` escapes titles to ASCII, so the line survives any console encoding.
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
    /** read the account options built by `authConfig` from stdin */
    auth?: boolean;
    /** fetch only these positions of a playlist: the ones a first pass left without a file */
    items?: number[];
    /** write the cover and tags into each file; yt-dlp needs ffmpeg for it, see `hasFfmpeg` */
    tags?: boolean;
    /** folder template for an album or playlist, put in front of `template`; blank for no folder */
    playlistFolder?: string;
    /** the album's or playlist's release year, from `playlistArgs` */
    year?: number | null;
}

/** Albums and playlists, which both live under /sets/. */
export function isSet(url: string): boolean {
    try {
        return new URL(url).pathname.includes('/sets/');
    } catch {
        return false;
    }
}

export interface PlaylistInfo {
    year: number | null;
    /** where the cover was written, or null when the album or playlist has none */
    cover: string | null;
}

/**
 * A quick first run for an album or playlist, for two things the download itself cannot give:
 * its release year, which yt-dlp tells none of its tracks, and its cover, which yt-dlp does not
 * write in a run that embeds the tracks' covers. The cover lands in `folder` as `cover` plus its
 * extension; `parsePlaylist` reads the answer.
 */
export function playlistArgs(url: string, options: { auth?: boolean; folder: string; cover: string }): string[] {
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        // the tracks are only listed, not looked up
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
        // one entry per size of the cover, with a path only for the one that was written
        const covers: unknown[] = Array.isArray(raw.cover) ? raw.cover : [];
        const cover = covers.find((path): path is string => typeof path === 'string') ?? null;
        return { year: numberOrNull(raw.year), cover };
    } catch {
        return null;
    }
}

/**
 * yt-dlp options that sign it in to SoundCloud as the app's logged-in account, which is what makes
 * Go+ streams and uploader-enabled original files available. Written to yt-dlp's stdin instead of
 * its command line, where any local process could read the token.
 *
 * The token comes from a cookie, i.e. from the web, and this text is parsed as options: anything
 * but a plain token is refused, or a crafted cookie could smuggle in `--exec`.
 */
export function authConfig(token: string): string | null {
    return /^[A-Za-z0-9_-]{1,256}$/.test(token) ? `--username oauth\n--password ${token}\n` : null;
}

// The uploader's original file when they offer one (SoundCloud only hands it to a signed-in account),
// otherwise the best full stream. Previews are excluded: a Go+ track this account cannot play would
// otherwise "succeed" as its 30-second sample.
const FORMAT = 'download/bestaudio[format_id!*=preview]';

// Saved as SoundCloud serves it. There is deliberately no conversion option: re-encoding a lossy
// stream to FLAC or WAV only produces a bigger file that claims to be lossless. The cover and tags
// go into the container around the audio, which is copied as it is.
export function buildArgs(url: string, options: DownloadOptions): string[] {
    const file = options.template.trim() || DEFAULT_TEMPLATE;
    const folder = options.playlistFolder?.trim();
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        ...(options.items?.length ? ['--playlist-items', options.items.join(',')] : []),
        ...(options.tags ? ['--embed-thumbnail', '--embed-metadata'] : []),
        // gives every track a field of that name, for the folder template to use
        ...(options.year ? ['--parse-metadata', `${options.year}:%(playlist_release_year)s`] : []),
        '--newline',
        // --print implies --quiet, which would drop the progress lines
        '--progress',
        '--progress-template',
        PROGRESS_TEMPLATE,
        '--print',
        // Printed before the cover and tags are written, so a file that cannot take them (a WAV has no
        // place for a cover) still counts as saved. The position comes with the file because a file
        // that was already there reports no progress.
        `post_process:${FILE_PREFIX}{"file":%(filepath)j,"index":%(playlist_index|null)j,"count":%(n_entries|null)j}`,
        '-f',
        FORMAT,
        '-P',
        options.folder,
        '-o',
        folder ? `${folder}/${file}` : file,
        // everything after this is a URL, never an option
        '--',
        url,
    ];
}

/**
 * Why yt-dlp left a track out, for the popup, or null for any other line. Read off the failure itself:
 * asking SoundCloud about every track up front would double the requests. yt-dlp skips such a track
 * and carries on with the rest of an album or playlist.
 */
export function skipReason(line: string): string | null {
    if (!line.startsWith('ERROR:')) return null;
    if (/DRM protected/i.test(line)) return 'DRM-protected';
    // only previews were left for FORMAT to refuse
    if (/Requested format is not available/i.test(line)) return 'Go+ only';
    if (/HTTP Error 40[13]/.test(line)) return 'not authorized';
    return null;
}

/** The id of the track a DRM failure is about, which is all that line says of it. */
export function drmId(line: string): string | null {
    return /^ERROR: \[soundcloud\] (\d+): .*DRM protected/i.exec(line)?.[1] ?? null;
}

/**
 * A run that downloads nothing and only names the tracks with these ids, for the popup's list of
 * DRM-protected ones. `--ignore-no-formats-error` is what lets yt-dlp get as far as their titles;
 * `parseTrack` reads the answer.
 */
export function lookupArgs(ids: string[], options: { auth?: boolean } = {}): string[] {
    return [
        ...(options.auth ? ['--config-locations', '-'] : []),
        '--ignore-no-formats-error',
        '--print',
        `pre_process:${TRACK_PREFIX}{"id":%(id)j,"uploader":%(uploader|null)j,"title":%(title|null)j}`,
        '--',
        ...ids.map((id) => `https://api.soundcloud.com/tracks/${id}`),
    ];
}

export function parseTrack(line: string): { id: string; name: string } | null {
    if (!line.startsWith(TRACK_PREFIX)) return null;
    try {
        const raw = JSON.parse(line.slice(TRACK_PREFIX.length)) as Record<string, unknown>;
        const name = [raw.uploader, raw.title].filter((part) => part && typeof part === 'string').join(' - ');
        return typeof raw.id === 'string' && name ? { id: raw.id, name } : null;
    } catch {
        return null;
    }
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
                    // yt-dlp reports no ETA for the HLS streams SoundCloud mostly serves, so work it out
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
        // a line that was cut short, or NaN in a field
    }
    return null;
}

// A packaged GUI app gets a bare PATH on macOS and Linux, so the usual install locations are added.
// The same list is handed to yt-dlp as its PATH, so it can find ffmpeg, which it uses to stitch HLS streams.
export function searchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    return [
        ...(env.PATH ?? '').split(delimiter),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local', 'bin'),
    ].filter(Boolean);
}

const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** `customPath` wins outright when set, so a typo there is reported instead of silently ignored. */
export function findYtDlp(customPath: string, dirs = searchDirs()): string | null {
    const candidates = customPath.trim() ? [customPath.trim()] : dirs.map((dir) => join(dir, executable('yt-dlp')));
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Whether yt-dlp can write covers and tags. Without ffmpeg it fails at that step on every track and
 * leaves each cover behind as a loose image, so the app only asks for them when ffmpeg is there.
 */
export function hasFfmpeg(dirs = searchDirs()): boolean {
    return dirs.some((dir) => existsSync(join(dir, executable('ffmpeg'))));
}
