import { app, BrowserView, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type ElectronStore from 'electron-store';
import { spawn, type ChildProcess } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, delimiter, dirname, extname, join, relative } from 'path';
import { createInterface } from 'readline';
import type { ThemeColors } from '../utils/colorExtractor';
import { applyNavigationPolicy } from '../utils/navigationPolicy';
import { appUrl, cspMetaTag, provideDocument } from '../utils/appProtocol';
import { markTrustedSender, trustedHandle, trustedOn } from '../utils/ipcGuard';
import {
    authConfig,
    buildArgs,
    DEFAULT_FOLDER,
    DEFAULT_TEMPLATE,
    deezerSearchUrl,
    drmId,
    findYtDlp,
    hasFfmpeg,
    isSet,
    lookupArgs,
    parseLine,
    parsePlaylist,
    parseTrack,
    pickDeezer,
    playlistArgs,
    searchArgs,
    searchDirs,
    skipReason,
    type PlaylistInfo,
    type TrackInfo,
} from '../utils/ytdlp';

const isMac = process.platform === 'darwin';
const HEADER_HEIGHT = 32;
const MAX_CONCURRENT = 2;
// finished downloads kept across restarts
const MAX_HISTORY = 50;

interface DownloadItem {
    id: number;
    url: string;
    /** track being fetched; changes through playlists */
    title: string;
    status: 'queued' | 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
    downloaded: number | null;
    total: number | null;
    speed: number | null;
    eta: number | null;
    index: number | null;
    count: number | null;
    /** finished file count, total size, last file path */
    files: number;
    size: number;
    file: string;
    /** one `skipReason` per track yt-dlp had to leave out */
    skipped: string[];
    /** DRM-protected skipped tracks by name, looked up once done */
    drm: string[];
    /** how many of `files` are YouTube copies of DRM tracks */
    lowQuality: number;
    error: string;
}

export function downloadFolder(store: ElectronStore): string {
    return (store.get('downloadFolder') as string) || app.getPath('downloads');
}

export class DownloadManager {
    private view: BrowserView | null = null;
    private parentWindow: BrowserWindow;
    private store: ElectronStore;
    private onChange: (active: number, items: DownloadItem[]) => void;
    private themeColors: ThemeColors | null = null;
    private devMode = process.argv.includes('--dev');
    // newest first, as popup lists them
    private items: DownloadItem[] = [];
    private processes = new Map<number, ChildProcess>();
    // yt-dlp sign-in per queued download; not in `items`, which goes to popup renderer
    private auth = new Map<number, string>();
    private nextId = 1;
    private pushTimer: NodeJS.Timeout | null = null;

    /** `onChange` gets active count and list, for views beside popup */
    constructor(
        parentWindow: BrowserWindow,
        store: ElectronStore,
        onChange: (active: number, items: DownloadItem[]) => void,
    ) {
        this.parentWindow = parentWindow;
        this.store = store;
        this.onChange = onChange;

        // earlier downloads, as `save` left them
        const history: unknown = store.get('downloadHistory', []);
        if (Array.isArray(history)) this.items = history as DownloadItem[];
        this.nextId = Math.max(0, ...this.items.map((item) => item.id)) + 1;

        this.parentWindow.on('resize', () => this.updateBounds());
        this.setupIpcHandlers();
    }

    /** session's SoundCloud oauth token; empty to download anonymously */
    public start(url: string, token = ''): void {
        const auth = authConfig(token);
        if (auth) this.auth.set(this.nextId, auth);

        let title = url;
        try {
            title = decodeURIComponent(new URL(url).pathname).slice(1) || url;
        } catch {
            // URL stands in until yt-dlp names it
        }

        this.items.unshift({
            id: this.nextId++,
            url,
            title,
            status: 'queued',
            downloaded: null,
            total: null,
            speed: null,
            eta: null,
            index: null,
            count: null,
            files: 0,
            size: 0,
            file: '',
            skipped: [],
            drm: [],
            lowQuality: 0,
            error: '',
        });
        this.show();
        this.runQueued();
    }

    // finished items kept for next start; running ones would never finish
    private save(): void {
        const finished = this.items.filter((item) => !this.processes.has(item.id) && item.status !== 'queued');
        this.store.set('downloadHistory', finished.slice(0, MAX_HISTORY));
    }

    private runQueued(): void {
        // oldest first
        for (const item of [...this.items].reverse()) {
            if (this.processes.size >= MAX_CONCURRENT) break;
            if (item.status === 'queued') this.run(item);
        }
        this.changed();
    }

    private run(item: DownloadItem): void {
        const auth = this.auth.get(item.id);
        this.auth.delete(item.id);

        const binary = findYtDlp(this.store.get('ytDlpPath', '') as string);
        if (!binary) {
            item.status = 'error';
            item.error =
                'yt-dlp was not found. Install it (brew, winget or pip install yt-dlp) or set its path in Settings.';
            return;
        }

        // on Windows yt-dlp also finds ffmpeg next to it
        const tags = hasFfmpeg([...searchDirs(), dirname(binary)]);

        const folder = downloadFolder(this.store);
        const playlistFolder = isSet(item.url)
            ? (this.store.get('downloadPlaylistFolder', DEFAULT_FOLDER) as string).trim()
            : '';
        // album/playlist first run's findings, see `playlistArgs`
        let playlist: PlaylistInfo = { year: null, cover: null };

        // files so far, their playlist positions, total position count
        const files = new Set<string>();
        const saved = new Set<number>();
        let count: number | null = null;
        let retried = false;
        // ids of tracks skipped as DRM-protected
        const drm = new Set<string>();

        // 'error' (could not start) and 'close' can both fire; whichever comes first settles it
        const settle = (child: ChildProcess, error: string) => {
            if (this.processes.get(item.id) !== child) return;
            this.processes.delete(item.id);
            if (item.status !== 'cancelled') {
                item.status = error ? 'error' : 'done';
                item.error = error;
            }
            // measured at end, since files are reported before cover/tags are added
            item.size = 0;
            for (const file of files) {
                try {
                    item.size += statSync(file).size;
                } catch {
                    // moved or deleted already; size is display-only
                }
            }
            // cover goes beside tracks, unless in download folder, where next album's would replace it
            const [first] = files;
            try {
                if (playlist.cover && first && relative(folder, dirname(first))) {
                    copyFileSync(playlist.cover, join(dirname(first), `cover${extname(playlist.cover)}`));
                }
                if (playlist.cover) rmSync(playlist.cover, { force: true });
            } catch {
                // tracks saved already, each carries its own cover
            }
            this.save();
            this.runQueued();
        };

        const launch = (program: string, args: string[], input = '') => {
            const child = spawn(program, args, {
                env: { ...process.env, PATH: searchDirs().join(delimiter) },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            // write to unstarted program must not crash app; 'error' reports it
            child.stdin.on('error', () => {});
            child.stdin.end(input);
            this.processes.set(item.id, child);
            return child;
        };

        const start = (args: string[]) => {
            const child = launch(binary, args, auth ?? '');
            item.status = 'downloading';
            child.on('error', (error) => settle(child, error.message));
            return child;
        };

        // What is left to say once nothing more will be tried.
        const conclude = (child: ChildProcess, code: number | null) => {
            // unavailable tracks are skipped, not failed; rest of album/playlist still counts
            if (item.files) return settle(child, '');
            if (item.error) return settle(child, item.error);
            if (!item.skipped.length) return settle(child, `yt-dlp exited with code ${code}`);
            const reasons = [...new Set(item.skipped)].join(', ');
            settle(
                child,
                item.skipped.length > 1
                    ? `None of the ${item.skipped.length} tracks can be downloaded (${reasons})`
                    : `This track can't be downloaded (${reasons})`,
            );
        };

        // DRM tracks, before settling: look up, then fetch from Deezer (deemix, if set) or YouTube (lower quality)
        // ones neither has stay skipped, named in popup list
        const finish = async (child: ChildProcess, code: number | null) => {
            const cancelled = () => item.status === 'cancelled';
            // one step; failed step is no download failure, so it only ever resolves
            const step = (program: string, args: string[], onLine: (line: string) => void, input = '') =>
                new Promise<void>((resolve) => {
                    const next = launch(program, args, input);
                    child = next;
                    createInterface({ input: next.stdout }).on('line', onLine);
                    // nothing reads it; full pipe would stall program
                    next.stderr.resume();
                    next.on('error', () => resolve());
                    next.on('close', () => resolve());
                });

            // Deezer copy via deemix: names files itself, so downloads to own folder; any file there is track
            // no stdin: asks for login, must never get SoundCloud token
            const fromDeezer = async (program: string, track: TrackInfo, target: string) => {
                const temp = mkdtempSync(join(app.getPath('temp'), 'sc-desktop-deemix-'));
                try {
                    const found = await fetch(deezerSearchUrl(track));
                    const url = pickDeezer(await found.json(), track.duration);
                    if (!url || cancelled()) return '';
                    await step(program, ['-p', temp, url], () => {});
                    const name = readdirSync(temp, { recursive: true, encoding: 'utf8' }).find((entry) =>
                        /\.(mp3|flac)$/i.test(entry),
                    );
                    if (!name || cancelled()) return '';
                    const file = join(target, basename(name));
                    mkdirSync(target, { recursive: true });
                    copyFileSync(join(temp, name), file);
                    return file;
                } finally {
                    rmSync(temp, { recursive: true, force: true });
                }
            };

            const tracks = new Map<string, TrackInfo>();
            try {
                item.status = 'processing';
                this.changed();
                await step(
                    binary,
                    lookupArgs([...drm], { auth: !!auth }),
                    (line) => {
                        const track = parseTrack(line);
                        if (track) tracks.set(track.id, track);
                    },
                    auth ?? '',
                );

                // next to tracks that did download
                const [first] = files;
                const target = first ? dirname(first) : folder;
                const deemix = (this.store.get('deemixPath', '') as string).trim();
                const elsewhere = this.store.get('downloadDrmFallback', true);

                for (const id of [...drm]) {
                    const track = tracks.get(id);
                    // no title, nothing to search for
                    if (!elsewhere || !track?.title || cancelled()) continue;
                    Object.assign(item, {
                        status: 'downloading',
                        downloaded: null,
                        total: null,
                        speed: null,
                        eta: null,
                    });
                    item.title = track.title;
                    this.changed();

                    // Deezer no-answer or failed copy: fall through to YouTube
                    let file = deemix ? await fromDeezer(deemix, track, target).catch(() => '') : '';

                    if (!file && !cancelled()) {
                        await step(binary, searchArgs(track, { folder: target, tags }), (line) => {
                            const parsed = parseLine(line);
                            if (!parsed || cancelled()) return;
                            if ('file' in parsed) file = parsed.file;
                            else {
                                const { downloaded, total, speed, eta, status } = parsed.progress;
                                Object.assign(item, { downloaded, total, speed, eta });
                                item.status = status === 'finished' ? 'processing' : 'downloading';
                            }
                            this.changed();
                        });
                        if (file) item.lowQuality++;
                    }

                    if (!file) continue;
                    files.add(file);
                    item.file = file;
                    item.files = files.size;
                    item.skipped.splice(item.skipped.indexOf('DRM-protected'), 1);
                    drm.delete(id);
                }
            } catch {
                // on any error, tracks not fetched stay as skipped
            }
            item.drm = [...drm].map((id) => tracks.get(id)?.name ?? `Track ${id}`);
            conclude(child, code);
        };

        // `items` limits second pass to positions first pass left without file
        const pass = (items?: number[]) => {
            const child = start(
                buildArgs(item.url, {
                    folder,
                    template: this.store.get('downloadTemplate', DEFAULT_TEMPLATE) as string,
                    playlistFolder,
                    year: playlist.year,
                    auth: !!auth,
                    items,
                    tags,
                }),
            );

            createInterface({ input: child.stdout }).on('line', (line) => {
                const parsed = parseLine(line);
                if (!parsed || item.status === 'cancelled') return;

                if ('file' in parsed) {
                    item.file = parsed.file;
                    // set: second pass over one track reports file again
                    files.add(parsed.file);
                    item.files = files.size;
                    if (parsed.index) saved.add(parsed.index);
                    // second pass counts only tracks it asked for
                    if (!retried) count = parsed.count ?? count;
                } else {
                    const { status, title, ...progress } = parsed.progress;
                    if (retried) progress.count = item.count;
                    else count = progress.count ?? count;
                    Object.assign(item, progress);
                    if (title) item.title = title;
                    // 'finished' comes once bytes are in; conversion and tagging follow
                    item.status = status === 'finished' ? 'processing' : 'downloading';
                }
                this.changed();
            });

            // one ERROR line per track given up on; yt-dlp carries on with rest
            createInterface({ input: child.stderr }).on('line', (line) => {
                // file that can't take cover or tags is still saved
                if (!line.startsWith('ERROR:') || line.startsWith('ERROR: Postprocessing:')) return;
                const reason = skipReason(line);
                item.skipped.push(reason ?? 'failed');
                const id = drmId(line);
                if (id) drm.add(id);
                if (!reason) item.error = line.slice('ERROR:'.length).trim();
            });

            child.on('close', (code) => {
                if (this.processes.get(item.id) !== child) return;
                if (code === 0) return settle(child, '');

                // no-reason failure is often SoundCloud timeout: retry those and anything still missing
                const missing = Array.from({ length: count ?? 0 }, (_, i) => i + 1).filter((i) => !saved.has(i));
                if (item.error && !retried && item.status !== 'cancelled' && (missing.length || !count)) {
                    retried = true;
                    item.skipped = [];
                    item.error = '';
                    drm.clear();
                    return pass(missing);
                }

                if (drm.size && item.status !== 'cancelled') return void finish(child, code);
                conclude(child, code);
            });
        };

        if (!playlistFolder) return pass();

        // album/playlist with folder: quick run first, for year and cover
        const child = start(
            playlistArgs(item.url, {
                auth: !!auth,
                folder: app.getPath('temp'),
                cover: `sc-desktop-cover-${process.pid}-${item.id}`,
            }),
        );
        let error = '';
        createInterface({ input: child.stdout }).on('line', (line) => {
            playlist = parsePlaylist(line) ?? playlist;
        });
        createInterface({ input: child.stderr }).on('line', (line) => {
            if (line.startsWith('ERROR:')) error = line.slice('ERROR:'.length).trim();
        });
        child.on('close', (code) => {
            if (this.processes.get(item.id) !== child) return;
            // no year means wrong folder name, so don't go on
            if (code !== 0 || item.status === 'cancelled') {
                return settle(child, error || `yt-dlp exited with code ${code}`);
            }
            pass();
        });
    }

    private cancel(id: unknown): void {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || !['queued', 'downloading', 'processing'].includes(item.status)) return;

        item.status = 'cancelled';
        this.auth.delete(item.id);
        this.processes.get(item.id)?.kill();
        this.changed();
    }

    /** stops running downloads; yt-dlp would outlive app */
    public cancelAll(): void {
        // cancel, don't just kill: falling-back download would go on to next program
        for (const id of [...this.processes.keys()]) this.cancel(id);
    }

    // progress arrives many times per second; list pushed to popup max 5x/s
    private changed(): void {
        if (this.pushTimer) return;
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            if (this.view && !this.view.webContents.isDestroyed()) {
                this.view.webContents.send('downloads-changed', this.items);
            }
            this.onChange(this.processes.size, this.items);
        }, 200);
    }

    public setThemeColors(colors: ThemeColors | null): void {
        this.themeColors = colors;
    }

    public toggle(): void {
        if (this.view) this.hide();
        else this.show();
    }

    private show(): void {
        if (this.view) return;

        this.view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                preload: join(__dirname, 'downloadsPreload.js'),
                devTools: this.devMode,
                ...(isMac ? { spellcheck: false } : {}),
            },
        });
        applyNavigationPolicy(this.view.webContents);
        markTrustedSender(this.view.webContents);

        this.parentWindow.addBrowserView(this.view);
        this.updateBounds();

        provideDocument('downloads', () => this.getHtml());
        this.view.webContents.loadURL(appUrl('downloads'));
    }

    // torn down, not parked off-screen like toast: popup rebuilt from `items` on each open
    // which also picks up theme changes
    private hide(): void {
        if (!this.view) return;
        const view = this.view;
        this.view = null;
        try {
            this.parentWindow.removeBrowserView(view);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (view.webContents as any).destroy();
        } catch {
            // window already gone
        }
    }

    // hangs off header's download button, top right
    private updateBounds(): void {
        if (!this.view) return;
        const { width, height } = this.parentWindow.getContentBounds();
        const viewWidth = Math.min(380, width - 16);

        this.view.setBounds({
            x: width - viewWidth - 8,
            y: HEADER_HEIGHT + 4,
            width: viewWidth,
            height: Math.max(120, Math.min(420, height - HEADER_HEIGHT - 16)),
        });
    }

    private setupIpcHandlers(): void {
        ipcMain.handle(
            'get-downloads',
            trustedHandle(() => this.items, 'get-downloads'),
        );
        ipcMain.on(
            'toggle-downloads',
            trustedOn(() => this.toggle(), 'toggle-downloads'),
        );
        ipcMain.on(
            'downloads-cancel',
            trustedOn((_event, id: unknown) => this.cancel(id), 'downloads-cancel'),
        );
        ipcMain.on(
            'downloads-clear',
            trustedOn(() => {
                this.items = this.items.filter((item) => this.processes.has(item.id) || item.status === 'queued');
                this.save();
                this.changed();
            }, 'downloads-clear'),
        );
        // renderer names download, never path
        ipcMain.on(
            'downloads-show',
            trustedOn((_event, id: unknown) => {
                const file = this.items.find((item) => item.id === id)?.file;
                if (file) shell.showItemInFolder(file);
            }, 'downloads-show'),
        );
        ipcMain.on(
            'downloads-open-folder',
            trustedOn(() => void shell.openPath(downloadFolder(this.store)), 'downloads-open-folder'),
        );
        ipcMain.handle(
            'choose-download-folder',
            trustedHandle(async () => {
                const result = await dialog.showOpenDialog(this.parentWindow, {
                    defaultPath: downloadFolder(this.store),
                    properties: ['openDirectory', 'createDirectory'],
                });
                if (!result.canceled && result.filePaths[0]) this.store.set('downloadFolder', result.filePaths[0]);
                return downloadFolder(this.store);
            }, 'choose-download-folder'),
        );
    }

    private getHtml(): string {
        const isDark = this.store.get('theme', 'dark') !== 'light';
        const background = this.themeColors?.surface || (isDark ? '#303030' : '#ffffff');
        const text = this.themeColors?.text || (isDark ? '#ffffff' : '#333333');
        const line = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';

        return `${cspMetaTag()}
        <style>
            * {
                box-sizing: border-box;
                margin: 0;
            }
            html, body {
                height: 100%;
                background: transparent;
            }
            body {
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: ${text};
                background: ${background};
                border: 1px solid ${line};
                border-radius: 10px;
                overflow: hidden;
                user-select: none;
                -webkit-font-smoothing: antialiased;
            }
            header {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 8px 8px 8px 12px;
                border-bottom: 1px solid ${line};
            }
            h1 {
                flex: 1;
                font-size: 14px;
                font-weight: 600;
            }
            button {
                border: none;
                border-radius: 4px;
                padding: 4px 8px;
                background: transparent;
                color: inherit;
                font: inherit;
                opacity: 0.7;
                cursor: pointer;
            }
            button:hover {
                opacity: 1;
                background: ${line};
            }
            #list {
                flex: 1;
                overflow-y: auto;
            }
            #empty {
                padding: 32px 12px;
                text-align: center;
                opacity: 0.6;
            }
            .row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 4px 8px;
                align-items: center;
                padding: 10px 8px 10px 12px;
                border-bottom: 1px solid ${line};
            }
            .title {
                font-weight: 600;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
            /* else rows with no button put detail beside title and squeeze it */
            .row > :not(button) {
                grid-column: 1;
            }
            .row button {
                grid-column: 2;
                grid-row: 1 / span 3;
            }
            progress {
                width: 100%;
                height: 4px;
                appearance: none;
            }
            progress::-webkit-progress-bar {
                border-radius: 2px;
                background: ${line};
            }
            progress::-webkit-progress-value {
                border-radius: 2px;
                background: #ff5500;
            }
            .detail {
                font-size: 12px;
                opacity: 0.7;
                font-variant-numeric: tabular-nums;
            }
            .row.error .detail {
                color: #ff5500;
                opacity: 1;
                user-select: text;
            }
            #drm {
                border-top: 1px solid ${line};
            }
            summary {
                padding: 8px 12px;
                font-weight: 600;
                cursor: pointer;
            }
            #drm-list {
                max-height: 140px;
                padding: 0 12px 8px;
                overflow-y: auto;
                font-size: 12px;
                line-height: 1.6;
                white-space: pre-line;
                user-select: text;
            }
        </style>
        <header>
            <h1>Downloads</h1>
            <button id="open-folder" type="button">Open folder</button>
            <button id="clear" type="button">Clear</button>
            <button id="close" type="button" title="Close" aria-label="Close">&#x2715;</button>
        </header>
        <div id="empty">No downloads yet. Use the download button under a track, album or playlist.</div>
        <div id="list"></div>
        <details id="drm" hidden>
            <summary></summary>
            <div id="drm-list"></div>
        </details>
        <script src="/downloadsPanel.js"></script>`;
    }
}
