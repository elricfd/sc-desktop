import { describe, expect, it } from 'vitest';
import {
    authConfig,
    buildArgs,
    DEFAULT_FOLDER,
    DEFAULT_TEMPLATE,
    findYtDlp,
    hasFfmpeg,
    isSet,
    parseLine,
    parsePlaylist,
    playlistArgs,
    skipReason,
} from './utils/ytdlp';

const options = { folder: '/music', template: DEFAULT_TEMPLATE };

describe('buildArgs', () => {
    it('never converts: the audio is saved in the format SoundCloud serves', () => {
        const args = buildArgs('https://soundcloud.com/a/b', options);
        expect(args).not.toContain('-x');
        expect(args).not.toContain('--audio-format');
    });

    it('asks for the uploader’s original file first, and never settles for a preview', () => {
        const args = buildArgs('https://soundcloud.com/a/b', options);
        expect(args[args.indexOf('-f') + 1]).toBe('download/bestaudio[format_id!*=preview]');
    });

    it('puts the URL last, behind --, so it can never be read as an option', () => {
        expect(buildArgs('--exec=evil', options).slice(-2)).toEqual(['--', '--exec=evil']);
    });

    it('asks only for the playlist positions it is given, and for everything when given none', () => {
        const args = buildArgs('https://soundcloud.com/a/sets/b', { ...options, items: [25, 49] });
        expect(args[args.indexOf('--playlist-items') + 1]).toBe('25,49');
        expect(buildArgs('https://soundcloud.com/a/sets/b', { ...options, items: [] })).not.toContain(
            '--playlist-items',
        );
    });

    it('embeds the cover and tags only when asked to, and reports each file before doing so', () => {
        const args = buildArgs('https://soundcloud.com/a/b', { ...options, tags: true });
        expect(args).toEqual(expect.arrayContaining(['--embed-thumbnail', '--embed-metadata']));
        expect(args[args.indexOf('--print') + 1]).toMatch(/^post_process:SCRPC_FILE /);
        expect(buildArgs('https://soundcloud.com/a/b', options)).not.toContain('--embed-thumbnail');
    });

    it('puts an album or playlist in its folder, with the release year on offer as a field', () => {
        const args = buildArgs('https://soundcloud.com/a/sets/b', {
            ...options,
            playlistFolder: ` ${DEFAULT_FOLDER} (%(playlist_release_year)s) `,
            year: 2015,
        });
        expect(args[args.indexOf('-o') + 1]).toBe(`${DEFAULT_FOLDER} (%(playlist_release_year)s)/${DEFAULT_TEMPLATE}`);
        expect(args[args.indexOf('--parse-metadata') + 1]).toBe('2015:%(playlist_release_year)s');

        const plain = buildArgs('https://soundcloud.com/a/sets/b', { ...options, playlistFolder: ' ', year: null });
        expect(plain[plain.indexOf('-o') + 1]).toBe(DEFAULT_TEMPLATE);
        expect(plain).not.toContain('--parse-metadata');
    });

    it('uses the default file name when the template is blank', () => {
        const args = buildArgs('https://soundcloud.com/a/b', { ...options, template: '  ' });
        expect(args[args.indexOf('-o') + 1]).toBe(DEFAULT_TEMPLATE);
        expect(args[args.indexOf('-P') + 1]).toBe('/music');
    });
});

describe('authConfig', () => {
    it('signs yt-dlp in with the session token, read from stdin and kept off the command line', () => {
        expect(authConfig('2-290000-123456-AbCdEf')).toBe('--username oauth\n--password 2-290000-123456-AbCdEf\n');

        const args = buildArgs('https://soundcloud.com/a/b', { ...options, auth: true });
        expect(args.slice(0, 2)).toEqual(['--config-locations', '-']);
        expect(args.join(' ')).not.toContain('password');
        expect(buildArgs('https://soundcloud.com/a/b', options)).not.toContain('--config-locations');
    });

    it('refuses a token that could carry extra options', () => {
        expect(authConfig('')).toBeNull();
        expect(authConfig('abc --exec evil')).toBeNull();
        expect(authConfig('abc\n--exec evil')).toBeNull();
        expect(authConfig('"abc"')).toBeNull();
    });
});

describe('parseLine', () => {
    it('reads a progress line, with the size estimate standing in for a missing total', () => {
        const line =
            'SCRPC_PROGRESS {"status":"downloading","downloaded":1024,"total":null,"estimate":4096.5,' +
            '"speed":512.25,"eta":6,"title":"Caf\\u00e9 \\"live\\"","index":2,"count":12}';
        expect(parseLine(line)).toEqual({
            progress: {
                status: 'downloading',
                downloaded: 1024,
                total: 4096.5,
                speed: 512.25,
                eta: 6,
                title: 'Café "live"',
                index: 2,
                count: 12,
            },
        });
    });

    it('estimates the time left when yt-dlp gives none', () => {
        const line = (speed: string) =>
            `SCRPC_PROGRESS {"status":"downloading","downloaded":1000,"total":5000,"speed":${speed},"eta":null}`;
        expect(parseLine(line('2000'))).toMatchObject({ progress: { eta: 2 } });
        expect(parseLine(line('0'))).toMatchObject({ progress: { eta: null } });
    });

    it('reads the path of a finished file, and where in its playlist it sits', () => {
        expect(parseLine('SCRPC_FILE {"file":"/music/A - B.mp3","index":25,"count":49}')).toEqual({
            file: '/music/A - B.mp3',
            index: 25,
            count: 49,
        });
        expect(parseLine('SCRPC_FILE {"file":"/music/A - B.mp3","index":null,"count":null}')).toEqual({
            file: '/music/A - B.mp3',
            index: null,
            count: null,
        });
    });

    it('ignores everything else, including lines it cannot parse', () => {
        expect(parseLine('[soundcloud] a/b: Downloading info JSON')).toBeNull();
        expect(parseLine('SCRPC_PROGRESS {"status":"downloading","speed":NaN}')).toBeNull();
        expect(parseLine('SCRPC_FILE 42')).toBeNull();
        expect(parseLine('SCRPC_FILE null')).toBeNull();
    });
});

describe('albums and playlists', () => {
    it('tells them from tracks by their address', () => {
        expect(isSet('https://soundcloud.com/a/sets/b')).toBe(true);
        expect(isSet('https://soundcloud.com/a/b')).toBe(false);
        // a track opened from a playlist is still a track
        expect(isSet('https://soundcloud.com/a/b?in=a/sets/c')).toBe(false);
        expect(isSet('not a url')).toBe(false);
    });

    it('asks for the year and cover without looking up the tracks, the URL last behind --', () => {
        const args = playlistArgs('--exec=evil', { auth: true, folder: '/tmp', cover: 'cover-1' });
        expect(args.slice(0, 2)).toEqual(['--config-locations', '-']);
        expect(args).toContain('--flat-playlist');
        expect(args[args.indexOf('-o') + 1]).toBe('pl_thumbnail:cover-1');
        expect(args.slice(-2)).toEqual(['--', '--exec=evil']);
    });

    it('reads the year and the one cover that was written', () => {
        expect(parsePlaylist('SCRPC_PLAYLIST {"year":2015,"cover":[null,"/tmp/cover-1.jpg"]}')).toEqual({
            year: 2015,
            cover: '/tmp/cover-1.jpg',
        });
        expect(parsePlaylist('SCRPC_PLAYLIST {"year":null,"cover":null}')).toEqual({ year: null, cover: null });
        expect(parsePlaylist('SCRPC_PLAYLIST null')).toBeNull();
        expect(parsePlaylist('SCRPC_FILE {"file":"/music/A - B.mp3"}')).toBeNull();
    });
});

describe('skipReason', () => {
    it('names why a track was left out, from the lines yt-dlp really prints', () => {
        expect(skipReason('ERROR: [soundcloud] 2119862316: This video is DRM protected')).toBe('DRM-protected');
        expect(
            skipReason(
                'ERROR: [soundcloud] 293: Requested format is not available. Use --list-formats for a list of available formats',
            ),
        ).toBe('Go+ only');
        expect(
            skipReason('ERROR: [soundcloud] a/b: Unable to download JSON metadata: HTTP Error 401: Unauthorized'),
        ).toBe('not authorized');
    });

    it('leaves every other line alone', () => {
        expect(skipReason('ERROR: [soundcloud] Unable to download JSON metadata: HTTP Error 404')).toBeNull();
        expect(skipReason('WARNING: [soundcloud] 2119862316: hls_mp3 format not found')).toBeNull();
        expect(skipReason('WARNING: [soundcloud] 1: This video is DRM protected')).toBeNull();
    });
});

describe('findYtDlp', () => {
    it('does not fall back to PATH when a custom path is set but wrong', () => {
        expect(findYtDlp('/nonexistent/yt-dlp', ['/bin', '/usr/bin'])).toBeNull();
    });

    it('uses a custom path that exists', () => {
        expect(findYtDlp(process.execPath, [])).toBe(process.execPath);
    });
});

describe('hasFfmpeg', () => {
    it('is false when ffmpeg is in none of the folders', () => {
        expect(hasFfmpeg([])).toBe(false);
        expect(hasFfmpeg(['/nonexistent'])).toBe(false);
    });
});
