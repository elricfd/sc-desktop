import { app, BrowserView, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type ElectronStore from 'electron-store';
import { spawn, type ChildProcess } from 'child_process';
import { copyFileSync, rmSync, statSync } from 'fs';
import { delimiter, dirname, extname, join, relative } from 'path';
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
    drmId,
    findYtDlp,
    hasFfmpeg,
    isSet,
    lookupArgs,
    parseLine,
    parsePlaylist,
    parseTrack,
    playlistArgs,
    searchDirs,
    skipReason,
    type PlaylistInfo,
} from '../utils/ytdlp';

const isMac = process.platform === 'darwin';
const HEADER_HEIGHT = 32;
const MAX_CONCURRENT = 2;

interface DownloadItem {
    id: number;
    url: string;
    /** the track being fetched right now; for a playlist this changes as it goes */
    title: string;
    status: 'queued' | 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
    downloaded: number | null;
    total: number | null;
    speed: number | null;
    eta: number | null;
    index: number | null;
    count: number | null;
    /** finished files so far, their combined size, and the last one's path */
    files: number;
    size: number;
    file: string;
    /** one `skipReason` per track yt-dlp had to leave out */
    skipped: string[];
    /** the DRM-protected ones among them by name, looked up once the download is over */
    drm: string[];
    error: string;
}

export function downloadFolder(store: ElectronStore): string {
    return (store.get('downloadFolder') as string) || app.getPath('downloads');
}

export class DownloadManager {
    private view: BrowserView | null = null;
    private parentWindow: BrowserWindow;
    private store: ElectronStore;
    private onActiveChange: (active: number) => void;
    private themeColors: ThemeColors | null = null;
    private devMode = process.argv.includes('--dev');
    // newest first, which is the order the popup lists them in
    private items: DownloadItem[] = [];
    private processes = new Map<number, ChildProcess>();
    // yt-dlp sign-in options per queued download; kept out of `items`, which the popup's renderer receives
    private auth = new Map<number, string>();
    private nextId = 1;
    private pushTimer: NodeJS.Timeout | null = null;

    constructor(parentWindow: BrowserWindow, store: ElectronStore, onActiveChange: (active: number) => void) {
        this.parentWindow = parentWindow;
        this.store = store;
        this.onActiveChange = onActiveChange;

        this.parentWindow.on('resize', () => this.updateBounds());
        this.setupIpcHandlers();
    }

    /** `token` is the session's SoundCloud oauth token, or empty to download anonymously. */
    public start(url: string, token = ''): void {
        const auth = authConfig(token);
        if (auth) this.auth.set(this.nextId, auth);

        let title = url;
        try {
            title = decodeURIComponent(new URL(url).pathname).slice(1) || url;
        } catch {
            // the address stands in until yt-dlp reports the real title
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
            error: '',
        });
        this.show();
        this.runQueued();
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

        // on Windows yt-dlp also finds an ffmpeg that sits next to it
        const tags = hasFfmpeg([...searchDirs(), dirname(binary)]);

        const folder = downloadFolder(this.store);
        const playlistFolder = isSet(item.url)
            ? (this.store.get('downloadPlaylistFolder', DEFAULT_FOLDER) as string).trim()
            : '';
        // what the first run of an album or playlist finds out, see `playlistArgs`
        let playlist: PlaylistInfo = { year: null, cover: null };

        // the files so far, the playlist positions they are for, and how many positions there are
        const files = new Set<string>();
        const saved = new Set<number>();
        let count: number | null = null;
        let retried = false;
        // the ids of the tracks skipped as DRM-protected
        const drm = new Set<string>();

        // 'error' (could not start) and 'close' can both fire; whichever comes first settles it
        const settle = (child: ChildProcess, error: string) => {
            if (this.processes.get(item.id) !== child) return;
            this.processes.delete(item.id);
            if (item.status !== 'cancelled') {
                item.status = error ? 'error' : 'done';
                item.error = error;
            }
            // measured at the end: a file is reported before its cover and tags are added to it
            item.size = 0;
            for (const file of files) {
                try {
                    item.size += statSync(file).size;
                } catch {
                    // moved or deleted already; the size is only for display
                }
            }
            // The cover goes next to the tracks, unless they went straight into the download folder,
            // where the next album's cover would take its place.
            const [first] = files;
            try {
                if (playlist.cover && first && relative(folder, dirname(first))) {
                    copyFileSync(playlist.cover, join(dirname(first), `cover${extname(playlist.cover)}`));
                }
                if (playlist.cover) rmSync(playlist.cover, { force: true });
            } catch {
                // the tracks are saved, and each carries its own cover
            }
            this.runQueued();
        };

        const start = (args: string[]) => {
            const child = spawn(binary, args, {
                env: { ...process.env, PATH: searchDirs().join(delimiter) },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            // a write to a yt-dlp that failed to start must not take the app down; 'error' below reports it
            child.stdin.on('error', () => {});
            child.stdin.end(auth ?? '');
            this.processes.set(item.id, child);
            item.status = 'downloading';
            child.on('error', (error) => settle(child, error.message));
            return child;
        };

        // The DRM-protected tracks are named for the popup's list before the download is settled.
        // ponytail: yt-dlp looks them up one by one, about a second each; ask SoundCloud for all the ids at once if that drags
        const finish = (child: ChildProcess, error: string) => {
            if (!drm.size || item.status === 'cancelled') return settle(child, error);
            const names = new Map<string, string>();
            const lookup = start(lookupArgs([...drm], { auth: !!auth }));
            item.status = 'processing';
            this.changed();
            createInterface({ input: lookup.stdout }).on('line', (line) => {
                const track = parseTrack(line);
                if (track) names.set(track.id, track.name);
            });
            // nothing reads it, and a full pipe would stall yt-dlp
            lookup.stderr.resume();
            lookup.on('close', () => {
                item.drm = [...drm].map((id) => names.get(id) ?? `Track ${id}`);
                settle(lookup, error);
            });
        };

        // `items` limits a second pass to the playlist positions the first left without a file
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
                    // a set, because a second pass over a single track reports its file again
                    files.add(parsed.file);
                    item.files = files.size;
                    if (parsed.index) saved.add(parsed.index);
                    // a second pass counts only the tracks it was asked for
                    if (!retried) count = parsed.count ?? count;
                } else {
                    const { status, title, ...progress } = parsed.progress;
                    if (retried) progress.count = item.count;
                    else count = progress.count ?? count;
                    Object.assign(item, progress);
                    if (title) item.title = title;
                    // yt-dlp reports 'finished' once the bytes are in; conversion and tagging follow
                    item.status = status === 'finished' ? 'processing' : 'downloading';
                }
                this.changed();
            });

            // one ERROR line per track yt-dlp gave up on; it carries on with the rest of an album or playlist
            createInterface({ input: child.stderr }).on('line', (line) => {
                // a file that could not take its cover or tags is saved all the same
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

                // A failure with no reason `skipReason` knows to be final is often SoundCloud timing out,
                // so those tracks get one more go, along with everything else still missing.
                // ponytail: one immediate retry; add a pause or more attempts if timeouts still get through
                const missing = Array.from({ length: count ?? 0 }, (_, i) => i + 1).filter((i) => !saved.has(i));
                if (item.error && !retried && item.status !== 'cancelled' && (missing.length || !count)) {
                    retried = true;
                    item.skipped = [];
                    item.error = '';
                    drm.clear();
                    return pass(missing);
                }

                // tracks yt-dlp could not have are skipped, not failed: the rest of an album or playlist still counts
                if (item.files) return finish(child, '');
                if (item.error) return finish(child, item.error);
                if (!item.skipped.length) return settle(child, `yt-dlp exited with code ${code}`);
                const reasons = [...new Set(item.skipped)].join(', ');
                finish(
                    child,
                    item.skipped.length > 1
                        ? `None of the ${item.skipped.length} tracks can be downloaded (${reasons})`
                        : `This track can't be downloaded (${reasons})`,
                );
            });
        };

        if (!playlistFolder) return pass();

        // An album or playlist that gets a folder starts with a quick run for its year and cover.
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
            // without the year the folder could get the wrong name, so this is not carried on from
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
        // ponytail: yt-dlp leaves its .part file behind; delete it here if the leftovers bother anyone
        this.processes.get(item.id)?.kill();
        this.changed();
    }

    /** Stops every running download; yt-dlp would otherwise outlive the app. */
    public cancelAll(): void {
        for (const child of this.processes.values()) child.kill();
    }

    // yt-dlp reports progress many times a second per download; the popup gets the whole list at most 5x a second
    private changed(): void {
        if (this.pushTimer) return;
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            if (this.view && !this.view.webContents.isDestroyed()) {
                this.view.webContents.send('downloads-changed', this.items);
            }
            this.onActiveChange(this.processes.size);
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

    // Torn down rather than parked off-screen, like the toast: the popup is rebuilt from `items` on
    // every open, which is also how it picks up a theme change.
    private hide(): void {
        if (!this.view) return;
        const view = this.view;
        this.view = null;
        try {
            this.parentWindow.removeBrowserView(view);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (view.webContents as any).destroy();
        } catch {
            // the window is already gone
        }
    }

    // hangs off the header's download button, at the top right
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
                this.changed();
            }, 'downloads-clear'),
        );
        // the renderer names a download, never a path
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
            /* without this a row with no button puts the detail beside the title and squeezes it to nothing */
            .row > :not(button) {
                grid-column: 1;
            }
            .row button {
                grid-row: span 3;
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
