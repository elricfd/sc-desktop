import {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    BrowserView,
    Tray,
    dialog,
    nativeImage,
    shell,
    components,
    type IpcMainEvent,
    type WebContents,
} from 'electron';
import { ElectronBlocker, fullLists } from '@ghostery/adblocker-electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import fetch from 'cross-fetch';
import { setupDarwinMenu } from './macos/menu';
import { NotificationManager } from './notifications/notificationManager';
import { SettingsManager } from './settings/settingsManager';
import { DownloadManager } from './downloads/downloadManager';
import { ProxyService } from './services/proxyService';
import { PresenceService } from './services/presenceService';
import { LastFmService } from './services/lastFmService';
import { TranslationService } from './services/translationService';
import { ThumbarService } from './services/thumbarService';
import { WebhookService } from './services/webhookService';
import { ThemeService } from './services/themeService';
import { ShortcutService } from './services/shortcutService';
import { PluginService } from './services/pluginService';
import { audioMonitorScript } from './services/audioMonitorService';
import { expandShortLinksInMessages } from './services/shortLinkService';
import { stageMacUpdate } from './services/macUpdateService';
import { showHomepageConfirmDialog, updateDialogBounds } from './settings/confirmPopup';
import type { TrackInfo } from './types';
import { validateTrackUpdatePayload } from './validation';
import { isSecretKey, migrateSecrets, writeSecret } from './utils/secretStore';
import { applyNavigationPolicy } from './utils/navigationPolicy';
import { handleAppScheme, registerAppScheme } from './utils/appProtocol';
import { isTrustedSender, markTrustedSender, trustedHandle, trustedOn } from './utils/ipcGuard';
import { installStoreReadCache } from './utils/storeCache';
import { deriveBrowserUserAgent } from './utils/userAgent';
import { ejectDmg, findInstallerDmg } from './utils/installerDmg';
import { DEFAULT_FOLDER, DEFAULT_TEMPLATE } from './utils/ytdlp';
import { readSuggestions, suggestScript } from './utils/searchSuggest';
import { presentAsChrome } from './utils/chromeIdentity';
import {
    EMPTY_PAGE_INFO,
    displayUrl,
    moveItem,
    parsePageInfo,
    resolveUrlInput,
    tabIcon,
    tabTitle,
    type PageInfo,
} from './utils/tabs';
import path = require('path');
import { platform } from 'os';

const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const windowStateManager = require('electron-window-state');

export const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../assets');
console.log(`Resources path: ${RESOURCES_PATH}`);

const store = new Store({
    defaults: {
        adBlocker: false,
        proxyEnabled: false,
        proxyHost: '',
        proxyPort: '',
        proxyData: { user: '', password: '' },
        lastFmEnabled: false,
        lastFmApiKey: '',
        lastFmSecret: '',
        lastFmSessionKey: '',
        webhookEnabled: false,
        webhookUrl: '',
        webhookTriggerPercentage: 50,
        displayWhenIdling: false,
        displaySCSmallIcon: false,
        discordRichPresence: true,
        displayButtons: false,
        statusDisplayType: 1,
        theme: 'dark',
        minimizeToTray: false,
        navigationControlsEnabled: false,
        trackParserEnabled: true,
        richPresencePreviewEnabled: false,
        autoUpdaterEnabled: true,
        hidePromotions: true,
        hideEventsNearYou: true,
        hideArtistUpsells: true,
        // downloads button shows only while downloading; this keeps it always
        downloadsButtonAlways: false,
        downloadUseAccount: true,
        // empty: system Downloads folder
        downloadFolder: '',
        downloadTemplate: DEFAULT_TEMPLATE,
        // empty: albums and playlists get no folder
        downloadPlaylistFolder: DEFAULT_FOLDER,
        // empty: look up on PATH
        ytDlpPath: '',
        // DRM tracks come from elsewhere: Deezer if deemix set, else YouTube
        downloadDrmFallback: true,
        deemixPath: '',
        accounts: [{ id: 'default', name: 'Main Account' }],
        currentAccountId: 'default',
    },
    clearInvalidConfig: true,
    encryptionKey: 'soundcloud-rpc-config',
});

// else every get() re-reads and re-decrypts whole config
installStoreReadCache(store);

let isDarkTheme = store.get('theme') !== 'light';

let mainWindow: BrowserWindow;
let notificationManager: NotificationManager;
let settingsManager: SettingsManager;
let downloadManager: DownloadManager;
let proxyService: ProxyService;
let presenceService: PresenceService;
let lastFmService: LastFmService;
let webhookService: WebhookService;
let translationService: TranslationService;
let thumbarService: ThumbarService;
let themeService: ThemeService;
let shortcutService: ShortcutService;
let pluginService: PluginService;
let tray: Tray | null = null;
let isQuitting = false;
const devMode = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';

// no native back/forward UI anywhere: nav buttons default on, once, so opt-outs stick
// old installs with persisted false get it too; flag keeps macOS-era name for Macs
if (!store.get('macNavControlsDefaulted', false)) {
    store.set({ navigationControlsEnabled: true, macNavControlsDefaulted: true });
}

// real engine UA minus Electron tokens; see utils/userAgent.ts
app.userAgentFallback = deriveBrowserUserAgent(app.userAgentFallback, app.getName());

function applyMacMemoryOptimizations(): void {
    if (!isMac) return;

    const existingDisableFeatures = app.commandLine.getSwitchValue('disable-features');
    const features = new Set(
        existingDisableFeatures
            .split(',')
            .map((feature) => feature.trim())
            .filter(Boolean),
    );
    features.add('BackForwardCache');

    app.commandLine.appendSwitch('disable-features', Array.from(features).join(','));
}

applyMacMemoryOptimizations();

// privileged schemes: declare before app ready
registerAppScheme();
const HEADER_HEIGHT = 32;
// header view reach: past title bar while search suggestions are open
let headerHeight = HEADER_HEIGHT;

// MAS sandbox already enforces single instance
if (!process.mas && !app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

let displayWhenIdling = store.get('displayWhenIdling') as boolean;
let displaySCSmallIcon = store.get('displaySCSmallIcon') as boolean;

let updaterStarted = false;

function setupUpdater() {
    if (!store.get('autoUpdaterEnabled', true)) {
        console.log('Auto-updater disabled by user setting');
        return;
    }

    // linux: AppImage replaces itself; .deb install asks for password as app quits
    // build marks packages with package-type file; hand-unpacked builds can't self-update
    const isPackage = existsSync(path.join(process.resourcesPath, 'package-type'));
    if (process.platform === 'linux' && !process.env.APPIMAGE && !isPackage) {
        console.log('Neither an AppImage nor a package, skipping auto-updater');
        return;
    }

    // toggling setting re-enters here: attach listeners once
    if (!updaterStarted) {
        updaterStarted = true;

        // macOS: electron-updater only checks; builds lack Developer ID, so macUpdateService downloads and installs
        const ownInstall = process.platform === 'darwin';
        autoUpdater.autoDownload = !ownInstall;
        autoUpdater.autoInstallOnAppQuit = !ownInstall;

        autoUpdater.on('update-available', (info: { version?: unknown; files?: unknown }) => {
            queueToastNotification('Update Available');
            if (!ownInstall) return;
            stageMacUpdate(info.version, info.files)
                .then((staged) => staged && queueToastNotification('Update Completed'))
                .catch((error) => console.error('Failed to fetch the update:', error));
        });

        autoUpdater.on('update-downloaded', () => {
            queueToastNotification('Update Completed');
        });
    }

    // offline or release not yet published: next start asks again
    autoUpdater.checkForUpdates().catch((error: unknown) => console.error('Failed to check for updates:', error));
}

// after drag-install: dmg stays mounted, installer sits in Downloads; offer to tidy both
async function offerInstallerCleanup() {
    if (process.platform !== 'darwin' || !app.isPackaged) return;

    try {
        const installer = await findInstallerDmg(process.execPath);
        // asked once per image: "Keep" must not nag every launch
        if (!installer || store.get('installerDmgKept') === installer.imagePath) return;

        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            message: translationService.translate('installerCleanupTitle'),
            detail: translationService
                .translate('installerCleanupDetail')
                .replace('{file}', path.basename(installer.imagePath)),
            buttons: [
                translationService.translate('installerCleanupConfirm'),
                translationService.translate('installerCleanupKeep'),
            ],
            defaultId: 0,
            cancelId: 1,
        });
        if (response !== 0) {
            store.set('installerDmgKept', installer.imagePath);
            return;
        }

        await ejectDmg(installer.mountPoint);
        await shell.trashItem(installer.imagePath);
    } catch (error) {
        console.error('Installer cleanup failed:', error);
    }
}

// appimages install no desktop file: wayland can't match window to icon, shows generic cog
// writes one to ~/.local/share on first run
function installDesktopFile() {
    if (process.platform !== 'linux' || !process.env.APPIMAGE) return;

    try {
        const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
        const desktopFilePath = path.join(dataHome, 'applications', 'soundcloud-rpc.desktop');
        const iconFilePath = path.join(dataHome, 'icons', 'hicolor', '1024x1024', 'apps', 'soundcloud-rpc.png');

        if (!existsSync(iconFilePath)) {
            mkdirSync(path.dirname(iconFilePath), { recursive: true });
            copyFileSync(path.join(RESOURCES_PATH, 'icons', 'soundcloud.png'), iconFilePath);
        }

        const entry = [
            '[Desktop Entry]',
            'Name=SoundCloud',
            'Comment=SoundCloud client with Discord Rich Presence',
            `Exec="${process.env.APPIMAGE}" %U`,
            'Icon=soundcloud-rpc',
            'Type=Application',
            'Categories=AudioVideo;Audio;Music;',
            'StartupWMClass=soundcloud-rpc',
            'Terminal=false',
            '',
        ].join('\n');

        // rewrite if missing or appimage moved
        const existing = existsSync(desktopFilePath) ? readFileSync(desktopFilePath, 'utf8') : '';
        if (existing !== entry) {
            mkdirSync(path.dirname(desktopFilePath), { recursive: true });
            writeFileSync(desktopFilePath, entry);
            console.log(`Desktop file written to ${desktopFilePath}`);
        }
    } catch (error) {
        console.error('Failed to write desktop file:', error);
    }
}

function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
}

function setupTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }

    const iconPath = path.join(
        RESOURCES_PATH,
        'icons',
        process.platform === 'win32' ? 'soundcloud-win.ico' : 'soundcloud.png',
    );
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
    tray.setToolTip('SoundCloud');

    const contextMenu = Menu.buildFromTemplate([
        { label: 'SoundCloud', click: showMainWindow },
        {
            label: 'Settings',
            click: () => {
                if (settingsManager && mainWindow && !mainWindow.isDestroyed()) {
                    settingsManager.toggle();
                }
            },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        showMainWindow();
        // views kept bounds from when window was hidden
        adjustContentViews();
    });
}

// app language follows soundcloud.com's page language
async function getLanguage() {
    if (!contentView) return;
    const lang = await contentView.webContents.executeJavaScript(`document.documentElement.lang || 'en'`);
    translationService.setLanguage(lang);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createBrowserWindow(windowState: any): BrowserWindow {
    return new BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        title: 'SoundCloud',
        icon: path.join(RESOURCES_PATH, 'icons', 'soundcloud.png'),
        frame: isMac,
        titleBarStyle: isMac ? 'hidden' : undefined,
        trafficLightPosition: isMac ? { x: 10, y: 10 } : undefined,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            javascript: true,
            images: true,
            plugins: true,
            experimentalFeatures: false,
            devTools: devMode,
            backgroundThrottling: false,
            ...(isMac ? { spellcheck: false } : {}),
        },
        backgroundColor: isDarkTheme ? '#121212' : '#ffffff',
    });
}

let lastTrackInfo: TrackInfo = {
    title: '',
    author: '',
    artwork: '',
    elapsed: '',
    duration: '',
    isPlaying: false,
    isLiked: false,
    url: '',
};

function isTrustedSoundCloudSender(event: IpcMainEvent): boolean {
    if (!tabOfSender(event)) return false;

    const frameUrl = event.senderFrame?.url || event.sender.getURL();
    return isSoundCloudUrl(frameUrl);
}

function isSoundCloudUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        return (
            url.protocol === 'https:' && (url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com'))
        );
    } catch {
        return false;
    }
}

function contentViewIsOnSoundCloud(): boolean {
    if (!contentView || contentView.webContents.isDestroyed()) return false;
    return isSoundCloudUrl(contentView.webContents.getURL());
}

const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function isValidSettingValue(value: unknown, depth = 0): boolean {
    if (depth > 4) return false;
    if (value === null) return true;

    switch (typeof value) {
        case 'string':
            return value.length <= 4096;
        case 'number':
            return Number.isFinite(value);
        case 'boolean':
            return true;
        case 'object':
            break;
        default:
            return false;
    }

    if (Array.isArray(value)) {
        return value.length <= 128 && value.every((entry) => isValidSettingValue(entry, depth + 1));
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) return false;
    return entries.every(([key, entry]) => SETTING_KEY_PATTERN.test(key) && isValidSettingValue(entry, depth + 1));
}

// `setting-changed` writes straight into config: keys must be plain identifiers (no dot-prop, no __proto__)
// value loosely typed: handler reads it per key
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isValidSettingPayload(data: unknown): data is { key: string; value: any } {
    if (typeof data !== 'object' || data === null) return false;

    const { key, value } = data as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || !SETTING_KEY_PATTERN.test(key)) return false;

    return isValidSettingValue(value);
}

let contentViewAdjustScheduled = false;

function scheduleContentViewAdjust(): void {
    if (contentViewAdjustScheduled) return;
    contentViewAdjustScheduled = true;

    setImmediate(() => {
        contentViewAdjustScheduled = false;
        adjustContentViews();
    });
}

function applyThemeChange(isDark: boolean): void {
    isDarkTheme = isDark;
    store.set('theme', isDark ? 'dark' : 'light');

    pluginService?.notifyThemeChange(isDarkTheme);

    headerContents()?.send('theme-changed', isDarkTheme);
    settingsManager?.getView()?.webContents.send('theme-changed', isDarkTheme);

    applyThemeToContent(isDarkTheme);
}

// hidden or minimized window reports bounds views can't lay out against
function adjustContentViews() {
    if (!mainWindow || !contentView || !headerView) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;

    const { width, height } = mainWindow.getContentBounds();

    headerView.setBounds({
        x: 0,
        y: 0,
        width,
        height: headerHeight,
    });

    contentView.setBounds({
        x: 0,
        y: HEADER_HEIGHT,
        width,
        height: height - HEADER_HEIGHT,
    });

    updateDialogBounds(mainWindow);
}

function navigateHistory(direction: 'back' | 'forward') {
    const history = contentView?.webContents.navigationHistory;
    if (!history) return;
    if (direction === 'back' && history.canGoBack()) history.goBack();
    else if (direction === 'forward' && history.canGoForward()) history.goForward();
}

function reloadContent(): void {
    if (!contentView) return;
    headerContents()?.send('refresh-state-changed', true);
    contentView.webContents.reload();
}

function setupWindowControls() {
    if (!mainWindow) return;

    ipcMain.on('minimize-window', () => {
        if (store.get('minimizeToTray', true)) mainWindow.hide();
        else mainWindow.minimize();
    });

    const toggleMaximize = () => {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    };
    ipcMain.on('maximize-window', toggleMaximize);
    ipcMain.on('title-bar-double-click', toggleMaximize);

    const onMaximizeChange = (maximized: boolean) => () => {
        adjustContentViews();
        headerContents()?.send('window-maximized-changed', maximized);
    };
    mainWindow.on('maximize', onMaximizeChange(true));
    mainWindow.on('unmaximize', onMaximizeChange(false));

    // macOS fullscreen hides traffic lights: header drops their gap
    mainWindow.on('enter-full-screen', () => headerContents()?.send('fullscreen-changed', true));
    mainWindow.on('leave-full-screen', () => headerContents()?.send('fullscreen-changed', false));

    // fires continuously during edge drag: one layout pass per tick is enough
    mainWindow.on('resize', scheduleContentViewAdjust);

    ipcMain.on('close-window', () => {
        if (store.get('minimizeToTray', true)) mainWindow.hide();
        else mainWindow.close();
    });

    // nav: header buttons, 2-finger swipes forwarded by preload.ts
    ipcMain.on('navigate-back', () => navigateHistory('back'));
    ipcMain.on('navigate-forward', () => navigateHistory('forward'));

    // 3-finger swipe, or 2-finger with macOS "Swipe between pages" set to swipe
    // chromium swipeWithEvent: left = Back, right = Forward
    mainWindow.on('swipe', (_event, direction) => {
        if (direction === 'left') navigateHistory('back');
        else if (direction === 'right') navigateHistory('forward');
    });

    ipcMain.on('refresh-page', reloadContent);

    ipcMain.on('cancel-refresh', () => {
        if (!contentView) return;
        contentView.webContents.stop();
        headerContents()?.send('refresh-state-changed', false);
    });

    ipcMain.on('toggle-theme', () => applyThemeChange(!isDarkTheme));

    ipcMain.on(
        'tab-new',
        trustedOn(() => void openTab(), 'tab-new'),
    );
    ipcMain.on(
        'tab-select',
        trustedOn((_event, id: unknown) => {
            const tab = tabs.find((t) => t.id === id);
            if (tab) activateTab(tab);
        }, 'tab-select'),
    );
    ipcMain.on(
        'tab-close',
        trustedOn((_event, id: unknown) => closeTab(id), 'tab-close'),
    );
    ipcMain.on(
        'tab-move',
        trustedOn((_event, id: unknown, toIndex: unknown) => {
            const from = tabs.findIndex((tab) => tab.id === id);
            if (typeof toIndex !== 'number') return;
            // in place: `tabs` shared, only order changes
            tabs.splice(0, tabs.length, ...moveItem(tabs, from, toIndex));
            sendTabState();
        }, 'tab-move'),
    );
    ipcMain.on(
        'navigate-url',
        trustedOn((_event, input: unknown) => navigateActiveTab(input), 'navigate-url'),
    );
    // SoundCloud's own search suggestions, asked from page in front
    ipcMain.handle(
        'search-suggest',
        trustedHandle(async (_event, query: unknown) => {
            const page = contentView?.webContents;
            if (typeof query !== 'string' || !query.trim() || query.length > 200) return [];
            if (!page || page.isDestroyed() || !isSoundCloudUrl(page.getURL())) return [];
            return readSuggestions(await page.mainFrame.executeJavaScript(suggestScript(query)).catch(() => null));
        }, 'search-suggest'),
    );
    // suggestions hang below title bar, only part header view covers
    // while open, header view stretches down over page, on top of it
    ipcMain.on(
        'header-height',
        trustedOn((_event, height: unknown) => {
            headerHeight = typeof height === 'number' && height > HEADER_HEIGHT ? Math.min(height, 480) : HEADER_HEIGHT;
            if (headerHeight > HEADER_HEIGHT && headerView) mainWindow.setTopBrowserView(headerView);
            adjustContentViews();
        }, 'header-height'),
    );
    ipcMain.handle('get-tab-state', () => tabState());
    ipcMain.handle('is-maximized', () => mainWindow.isMaximized());
    ipcMain.handle('is-fullscreen', () => mainWindow.isFullScreen());
    ipcMain.handle('get-minimize-to-tray', () => store.get('minimizeToTray', true));
    ipcMain.handle('get-navigation-controls-enabled', () => store.get('navigationControlsEnabled', false));
    ipcMain.handle('get-download-button-enabled', () => store.get('downloadsButtonAlways', false));

    adjustContentViews();
}

let headerView: BrowserView | null;
// active tab's view; page actions (zoom, reload, back/forward, theme) go through this
// so it follows whichever tab is in front
let contentView: BrowserView;

const HOME_URL = 'https://soundcloud.com/discover';

interface Account {
    id: string;
    name: string;
}

interface Tab {
    id: number;
    view: BrowserView;
    info: PageInfo;
}

const tabs: Tab[] = [];
let nextTabId = 1;
// tab whose player drives presence, scrobbling and thumbar
let audioTabId: number | undefined;

function tabOfSender(event: IpcMainEvent): Tab | undefined {
    return tabs.find((tab) => tab.view.webContents.id === event.sender.id);
}

function tabState() {
    const url = contentView?.webContents.getURL() ?? '';
    return {
        tabs: tabs.map((tab) => ({
            id: tab.id,
            title: tabTitle(tab.view.webContents.getURL(), tab.info),
            icon: tabIcon(tab.info),
        })),
        activeId: tabs.find((tab) => tab.view === contentView)?.id,
        url,
        display: displayUrl(url),
        // shown on SoundCloud pages and when cover fails to load
        fallbackIcon: soundCloudIcon(),
    };
}

let soundCloudIconUrl = '';
function soundCloudIcon(): string {
    soundCloudIconUrl ||= nativeImage
        .createFromPath(path.join(RESOURCES_PATH, 'icons', 'soundcloud.png'))
        .resize({ width: 32, height: 32 })
        .toDataURL();
    return soundCloudIconUrl;
}

// shutdown: header webContents torn down before tabs', which still emit load/nav events
// touching header then throws and takes quit down with it
function headerContents(): WebContents | null {
    const webContents = headerView?.webContents;
    return webContents && !webContents.isDestroyed() ? webContents : null;
}

function sendTabState(): void {
    if (isQuitting) return;
    headerContents()?.send('tabs-changed', tabState());
}

function updateNavigationState(): void {
    if (isQuitting || !contentView?.webContents) return;
    headerContents()?.send('navigation-state-changed', {
        canGoBack: contentView.webContents.navigationHistory.canGoBack(),
        canGoForward: contentView.webContents.navigationHistory.canGoForward(),
    });
}

function createTab(): Tab {
    // extra accounts: own persistent session
    const currentAccountId = store.get('currentAccountId', 'default');
    const sessionPartition = currentAccountId === 'default' ? undefined : `persist:sc_${currentAccountId}`;

    const view = new BrowserView({
        webPreferences: {
            ...(sessionPartition ? { partition: sessionPartition } : {}),
            nodeIntegration: false,
            contextIsolation: true,
            // soundcloud.com plus third-party ad and embed iframes
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            devTools: devMode,
            preload: path.join(__dirname, 'preload.js'),
            ...(isMac ? { spellcheck: false } : {}),
        },
    });
    const tab: Tab = { id: nextTabId++, view, info: EMPTY_PAGE_INFO };
    tabs.push(tab);

    applyNavigationPolicy(view.webContents, {
        allowPopups: true,
        onNewTab: (url, background) => void openTab(url, !background),
    });
    shortcutService.attachToWebContents(view.webContents);
    return tab;
}

// only active tab view attached to window; others run detached
function activateTab(tab: Tab): void {
    if (contentView && contentView !== tab.view) mainWindow.removeBrowserView(contentView);
    contentView = tab.view;
    mainWindow.addBrowserView(tab.view);

    // later-added view stacks over settings, toasts, dialogs: re-raise those
    for (const view of mainWindow.getBrowserViews()) {
        if (view !== tab.view && view !== headerView) mainWindow.setTopBrowserView(view);
    }

    const { width, height } = mainWindow.getContentBounds();
    tab.view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: height - HEADER_HEIGHT });
    tab.view.setAutoResize({ width: true, height: true });

    pluginService?.setContentView(tab.view);
    tab.view.webContents.focus();

    sendTabState();
    updateNavigationState();
    headerContents()?.send('refresh-state-changed', tab.view.webContents.isLoading());
}

async function startTab(tab: Tab, url: string): Promise<void> {
    const { webContents } = tab.view;

    // before first soundcloud request: never sees Chromium-only brand
    const header = headerContents();
    if (header) {
        await presentAsChrome(webContents, header, app.userAgentFallback).catch((error) =>
            console.error('Failed to set Chrome client hints:', error),
        );
        await expandShortLinksInMessages(webContents).catch((error) =>
            console.error('Failed to set up short link expansion:', error),
        );
    }
    if (!tabs.includes(tab) || isQuitting) return; // closed during setup

    // after presentAsChrome: its about:blank load must not run page handlers
    wireTab(tab);
    webContents.loadURL(url);
}

async function openTab(url = HOME_URL, activate = true): Promise<void> {
    const tab = createTab();
    if (activate) activateTab(tab);
    else sendTabState();
    await startTab(tab, url);
}

function closeTab(id: unknown): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    // last tab is window: closing it closes, or hides on macOS/tray
    if (tabs.length === 1) {
        mainWindow.close();
        return;
    }

    const [tab] = tabs.splice(index, 1);
    if (tab.view === contentView) activateTab(tabs[Math.min(index, tabs.length - 1)]);
    else sendTabState();

    if (audioTabId === tab.id) {
        audioTabId = undefined;
        lastTrackInfo = { ...lastTrackInfo, isPlaying: false };
        void presenceService?.updatePresence(lastTrackInfo);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tab.view.webContents as any).destroy();
}

function cycleTab(step: number): void {
    const index = tabs.findIndex((tab) => tab.view === contentView);
    if (index !== -1) activateTab(tabs[(index + step + tabs.length) % tabs.length]);
}

function navigateActiveTab(input: unknown): void {
    const url = typeof input === 'string' ? resolveUrlInput(input) : null;
    if (!url || !contentView) return;

    const { webContents } = contentView;
    const target = new URL(url);
    if (contentViewIsOnSoundCloud() && target.origin === new URL(webContents.getURL()).origin) {
        // hand path to SoundCloud's router: real load would stop playback
        const path = JSON.stringify(target.pathname + target.search + target.hash);
        webContents
            .executeJavaScript(`history.pushState(null, '', ${path}); dispatchEvent(new PopStateEvent('popstate'));`)
            .catch(() => webContents.loadURL(url));
    } else {
        webContents.loadURL(url);
    }
    webContents.focus();
}

// per-tab page lifecycle: header state, crash recovery, theme and monitor injection
function wireTab(tab: Tab): void {
    const { webContents } = tab.view;
    const isActive = () => tab.view === contentView;

    const sendLoading = (loading: boolean) => {
        if (isActive() && !isQuitting) headerContents()?.send('refresh-state-changed', loading);
    };
    const onNavigated = () => {
        sendTabState();
        if (isActive()) updateNavigationState();
    };

    webContents.on('did-navigate', onNavigated);
    webContents.on('did-navigate-in-page', () => {
        onNavigated();
        if (isActive()) void refreshCurrentAccountName();
    });

    webContents.on('did-start-loading', () => sendLoading(true));
    webContents.on('did-stop-loading', () => {
        sendLoading(false);
        onNavigated();
    });
    webContents.on('did-fail-load', () => {
        sendLoading(false);
        onNavigated();
    });

    let rendererCrashes = 0;
    webContents.on('render-process-gone', (_event, details) => {
        console.error(`Content renderer gone (${details.reason}, exitCode ${details.exitCode})`);
        if (details.reason === 'clean-exit' || isQuitting) return;

        rendererCrashes += 1;
        if (rendererCrashes > 3) {
            queueToastNotification('SoundCloud keeps crashing — restart the app');
            return;
        }

        queueToastNotification('SoundCloud crashed — reloading');
        webContents.reloadIgnoringCache();
    });

    // theme and promo hiding on dom-ready, not did-finish-load: load waits on every subresource
    // and never fires when interrupted, leaving upsells visible
    webContents.on('dom-ready', () => applyThemeToContent(isDarkTheme, tab.view));

    let isInitialLoad = true;
    webContents.on('did-finish-load', async () => {
        // clean load resets crash budget: later unrelated crashes still retry
        rendererCrashes = 0;

        if (isInitialLoad) {
            // drop about:blank entry presentAsChrome left, or Back lands on it
            webContents.navigationHistory.clear();
            isInitialLoad = false;
        }

        if (isActive()) {
            await lastFmService.authenticate();

            await getLanguage();
            settingsManager.updateTranslations(translationService);
            updateNavigationState();
            headerContents()?.send('navigation-controls-toggle', store.get('navigationControlsEnabled', false));

            void refreshCurrentAccountName();
        }

        // load wipes everything injected into page
        try {
            if (!isSoundCloudUrl(webContents.getURL())) return;

            await webContents.executeJavaScript(audioMonitorScript);
            pluginService?.injectAllContentScripts(tab.view);
            await presenceService?.updatePresence(lastTrackInfo);
        } catch (error) {
            console.error('Failed to reinitialize after page load:', error);
        }
    });
}

async function init() {
    // serves settings, notification, confirm docs: must be in place before those views load
    handleAppScheme();

    // castlabs: Widevine CDM must be ready before any protected-media window exists
    // deferring breaks Go+ playback: keep despite slower first paint
    try {
        await components.whenReady();
        console.log('Components ready:', components.status());
    } catch (error) {
        console.error('Failed to initialize components:', error);
    }

    // safeStorage: unavailable before app ready
    migrateSecrets(store);

    setupUpdater();
    installDesktopFile();
    if (store.get('minimizeToTray', false)) {
        setupTray();
    }

    if (isMac) setupDarwinMenu(() => contentView?.webContents.reload());
    else Menu.setApplicationMenu(null);

    const windowState = windowStateManager({ defaultWidth: 1280, defaultHeight: 800 });
    mainWindow = createBrowserWindow(windowState);

    windowState.manage(mainWindow);

    // macOS: app lives with window hidden; elsewhere needs tray
    mainWindow.on('close', (event) => {
        if (isQuitting) return;

        if (isMac || store.get('minimizeToTray', true)) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('minimize', () => {
        if (store.get('minimizeToTray', true)) mainWindow.hide();
    });

    headerView = new BrowserView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            preload: path.join(__dirname, 'header', 'headerPreload.js'),
            devTools: devMode,
            ...(isMac ? { spellcheck: false } : {}),
        },
    });

    mainWindow.addBrowserView(headerView);
    headerView.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: HEADER_HEIGHT });
    headerView.setAutoResize({ width: true, height: false });
    // transparent below title bar: header-height can reach over page
    headerView.setBackgroundColor('#00000000');
    applyNavigationPolicy(headerView.webContents);
    markTrustedSender(headerView.webContents);
    headerView.webContents.loadFile(path.join(__dirname, 'header', 'header.html'));

    // tabs attach shortcut listeners: service must exist before first tab
    shortcutService = new ShortcutService(mainWindow);
    shortcutService.attachToWebContents(headerView.webContents);

    const firstTab = createTab();
    activateTab(firstTab);

    translationService = new TranslationService();
    void offerInstallerCleanup();
    themeService = new ThemeService(store);
    pluginService = new PluginService(store);
    pluginService.setContentView(contentView);
    // theme file changed on disk
    themeService.onCustomThemeUpdated(() => applyThemeToContent(isDarkTheme));
    notificationManager = new NotificationManager(mainWindow);
    settingsManager = new SettingsManager(mainWindow, store, translationService);
    downloadManager = new DownloadManager(mainWindow, store, (active, items) => {
        if (isQuitting) return;
        headerContents()?.send('downloads-active', active);
        // downloads list atop settings panel
        const settings = settingsManager.getView()?.webContents;
        if (settings && !settings.isDestroyed()) settings.send('downloads-changed', items);
    });
    proxyService = new ProxyService(() => contentView?.webContents.session ?? null, store, queueToastNotification);
    presenceService = new PresenceService(store, translationService);
    lastFmService = new LastFmService(() => contentView, store);
    webhookService = new WebhookService(store);
    if (platform() === 'win32') thumbarService = new ThumbarService(translationService);

    setupMemoryPressureHandler();

    ipcMain.on(
        'toggle-settings',
        trustedOn(() => {
            settingsManager.toggle();
            applyThemeToContent(isDarkTheme);
        }),
    );

    ipcMain.handle(
        'confirm-open-homepage',
        trustedHandle(async (_event, url: string) => {
            if (!url || typeof url !== 'string') return false;
            const normalizedUrl = url.trim();
            if (!/^https?:\/\//i.test(normalizedUrl)) return false;

            const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
            if (confirmed) {
                await shell.openExternal(normalizedUrl);
            }

            return confirmed;
        }),
    );

    ipcMain.on(
        'show-plugin-homepage-dialog',
        trustedOn(async (_event, url: string) => {
            if (!url || typeof url !== 'string') return;
            const normalizedUrl = url.trim();
            if (!/^https?:\/\//i.test(normalizedUrl)) return;

            const confirmed = await showHomepageConfirmDialog(mainWindow, normalizedUrl);
            if (confirmed) {
                await shell.openExternal(normalizedUrl);
            }
        }),
    );

    ipcMain.handle(
        'open-external-url',
        trustedHandle(async (_event, url: string) => {
            if (!url || typeof url !== 'string') return '';
            const normalizedUrl = url.trim();

            try {
                const parsed = new URL(normalizedUrl);
                if (parsed.protocol !== 'https:') return '';
                await shell.openExternal(parsed.toString());
                return '';
            } catch {
                return '';
            }
        }),
    );

    ipcMain.handle(
        'open-path',
        trustedHandle(async (_event, targetPath: string) => {
            if (!targetPath || typeof targetPath !== 'string') return 'Invalid path';
            const allowedPaths = [themeService.getThemesPath(), pluginService.getPluginsPath()].map((allowedPath) =>
                path.resolve(allowedPath),
            );
            const normalizedPath = path.resolve(targetPath);
            if (!allowedPaths.includes(normalizedPath)) return 'Blocked path';

            return shell.openPath(targetPath);
        }),
    );

    setupWindowControls();

    initializeShortcuts();

    setupThemeHandlers();
    setupTranslationHandlers();
    setupAudioHandler();

    // rich presence preview in settings
    ipcMain.handle('get-current-track', () => lastTrackInfo);

    await proxyService.apply();

    await setupAdBlocker();

    await startTab(firstTab, HOME_URL);

    ipcMain.on('soundcloud:page-info', (event, payload: unknown) => {
        const tab = tabOfSender(event);
        const info = parsePageInfo(payload);
        if (!tab || !info || !isTrustedSoundCloudSender(event)) return;

        tab.info = info;
        sendTabState();
    });

    // from download button preload.ts adds under tracks, albums, playlists
    ipcMain.on('soundcloud:download', async (event, rawUrl: unknown) => {
        if (!isTrustedSoundCloudSender(event) || typeof rawUrl !== 'string' || !isSoundCloudUrl(rawUrl)) return;

        const url = new URL(rawUrl);
        // "?in=<playlist>" only records where track was opened from
        url.searchParams.delete('in');

        // logged-in download gets Go+ streams and originals: oauth_token from session
        // signed out: no token
        const [cookie] = store.get('downloadUseAccount', true)
            ? await event.sender.session.cookies
                  .get({ url: 'https://soundcloud.com', name: 'oauth_token' })
                  .catch(() => [])
            : [];
        downloadManager.start(url.toString(), cookie?.value);
    });

    ipcMain.on('setting-changed', async (event, data) => {
        // settings hold yt-dlp/deemix paths that get executed: only own views may write
        if (!isTrustedSender(event)) return;

        if (!isValidSettingPayload(data)) {
            console.warn('Rejected invalid setting-changed payload');
            return;
        }

        const key = proxyService.transformKey(data.key);

        // credentials stored as ciphertext, not plain in config
        if (isSecretKey(key)) {
            writeSecret(store, key, data.value);
        } else {
            store.set(key, data.value);
        }

        if (key === 'displayWhenIdling') {
            displayWhenIdling = data.value;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displaySCSmallIcon') {
            displaySCSmallIcon = data.value;
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon);
        } else if (key === 'displayButtons') {
            presenceService.updateDisplaySettings(displayWhenIdling, displaySCSmallIcon, data.value);
        } else if (key === 'statusDisplayType') {
            presenceService.setStatusDisplayType(data.value as number);
        } else if (key === 'minimizeToTray') {
            if (data.value === false && tray) {
                tray.destroy();
                tray = null;
            } else if (data.value === true && !tray) {
                setupTray();
            }
        } else if (key === 'theme') {
            applyThemeChange(data.value === 'dark');
        } else if (key === 'webhookEnabled') {
            webhookService.setEnabled(data.value);
        } else if (key === 'webhookUrl') {
            webhookService.setWebhookUrl(data.value);
        } else if (key === 'webhookTriggerPercentage') {
            webhookService.setTriggerPercentage(data.value);
        } else if (key === 'navigationControlsEnabled') {
            headerContents()?.send('navigation-controls-toggle', data.value);
        } else if (key === 'downloadsButtonAlways') {
            headerContents()?.send('download-button-toggle', data.value);
        } else if (key === 'autoUpdaterEnabled') {
            if (data.value) setupUpdater();
        } else if (key === 'customTheme') {
            if (data.value === 'none') {
                themeService.removeCustomTheme();
            } else {
                themeService.applyCustomTheme(data.value);
            }
            applyThemeToContent(isDarkTheme);
        } else if (key === 'hidePromotions' || key === 'hideEventsNearYou' || key === 'hideArtistUpsells') {
            applyThemeToContent(isDarkTheme);
        }
    });

    ipcMain.handle('get-accounts', () => {
        return {
            accounts: store.get('accounts', [{ id: 'default', name: 'Main Account' }]),
            currentAccountId: store.get('currentAccountId', 'default'),
        };
    });

    ipcMain.on(
        'switch-account',
        trustedOn((_, accountId) => {
            store.set('currentAccountId', accountId);
            app.relaunch();
            app.quit();
        }),
    );

    ipcMain.on(
        'add-account',
        trustedOn(() => {
            const newId = `acc_${Date.now()}`;
            const accounts = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
            accounts.push({ id: newId, name: 'New Account' });
            store.set('accounts', accounts);
            store.set('currentAccountId', newId);
            app.relaunch();
            app.quit();
        }),
    );

    ipcMain.on(
        'logout-account',
        trustedOn(async () => {
            const currentId = store.get('currentAccountId', 'default');

            await contentView?.webContents.session.clearStorageData();

            // extra account: removed; main account: just signed out
            if (currentId !== 'default') {
                const accounts: Account[] = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);

                store.set(
                    'accounts',
                    accounts.filter((account) => account.id !== currentId),
                );
                store.set('currentAccountId', 'default');

                app.relaunch();
                app.quit();
            } else {
                for (const tab of tabs) tab.view.webContents.reload();
            }
        }),
    );

    ipcMain.on(
        'apply-changes',
        trustedOn(async () => {
            if (store.get('proxyEnabled')) {
                await proxyService.apply();
            }

            if (store.get('lastFmEnabled')) {
                await lastFmService.authenticate();
            }

            if (store.get('adBlocker')) {
                mainWindow.webContents.reload();
            }

            if (store.get('discordRichPresence')) {
                await presenceService.updatePresence(lastTrackInfo);
            } else {
                presenceService.clearActivity();
            }
        }),
    );
}

async function refreshCurrentAccountName(): Promise<void> {
    if (!contentView || contentView.webContents.isDestroyed()) return;
    if (!contentViewIsOnSoundCloud()) return;

    try {
        const username = await contentView.webContents.executeJavaScript(`
            (() => {
                try {
                    const profileBtn = document.querySelector('.header__userNav [data-menu-name="profile"]');
                    if (profileBtn && profileBtn.href) {
                        const parts = profileBtn.href.split('/');
                        return parts[parts.length - 1];
                    }

                    const userBtn = document.querySelector('.header__userNavUsernameButton');
                    if (userBtn && userBtn.href) {
                        const parts = userBtn.href.split('/');
                        return parts[parts.length - 1];
                    }

                    return null;
                } catch (err) {
                    return null;
                }
            })()
        `);

        if (!username || typeof username !== 'string' || username.trim() === '') return;

        const accounts: Account[] = store.get('accounts', [{ id: 'default', name: 'Main Account' }]);
        const currentId = store.get('currentAccountId', 'default');
        const account = accounts.find((entry) => entry.id === currentId);

        if (account && account.name !== username) {
            account.name = username;
            store.set('accounts', [...accounts]);

            settingsManager?.getView()?.webContents.send('accounts-updated');
        }
    } catch {
        // page navigating: next navigation retries
    }
}

async function setupAdBlocker(): Promise<void> {
    if (!contentView || !store.get('adBlocker')) return;

    try {
        const blocker = await ElectronBlocker.fromLists(
            fetch,
            fullLists,
            { enableCompression: true },
            {
                path: path.join(app.getPath('userData'), 'adblocker-engine.bin'),
                read: async (...args) => readFileSync(...args),
                write: async (...args) => writeFileSync(...args),
            },
        );
        blocker.enableBlockingInSession(contentView.webContents.session);
    } catch (error) {
        console.error('Failed to initialize adblocker:', error);
    }
}

function setupMemoryPressureHandler() {
    if (!isMac) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.on('memory-pressure' as any, async (_event: unknown, details: unknown) => {
        const level = typeof details === 'string' ? details : 'unknown';
        console.warn(`Memory pressure detected (${level}). Clearing caches and history.`);

        if (!contentView) return;
        contentView.webContents.clearHistory();
        const session = contentView.webContents.session;

        try {
            await session.clearCache();
        } catch (error) {
            console.warn('Failed to clear HTTP cache:', error);
        }

        try {
            await session.clearStorageData({ storages: ['cachestorage'] });
        } catch (error) {
            console.warn('Failed to clear Cache Storage:', error);
        }
    });
}

function setupThemeHandlers() {
    headerContents()?.send('theme-changed', isDarkTheme);
    settingsManager?.getView()?.webContents.send('theme-changed', isDarkTheme);
    applyThemeToContent(isDarkTheme);
}

// per webContents, not target: each tab is 'content' view with own stylesheet key
const insertedThemeCssKeys = new WeakMap<WebContents, string>();
const themeCssQueues = new WeakMap<WebContents, Promise<void>>();

// runs per view must not overlap: they insert two stylesheets but keep one key
// other outlives later theme changes until reload
function applyCustomThemeCss(
    target: 'content' | 'header' | 'settings',
    webContents: WebContents | null | undefined,
    css: string,
): Promise<void> {
    if (!webContents || webContents.isDestroyed()) return Promise.resolve();

    const run = (themeCssQueues.get(webContents) ?? Promise.resolve()).then(() =>
        replaceCustomThemeCss(target, webContents, css),
    );
    themeCssQueues.set(webContents, run);
    return run;
}

async function replaceCustomThemeCss(
    target: 'content' | 'header' | 'settings',
    webContents: WebContents,
    css: string,
): Promise<void> {
    if (webContents.isDestroyed()) return;

    const previousKey = insertedThemeCssKeys.get(webContents);
    if (previousKey) {
        insertedThemeCssKeys.delete(webContents);
        try {
            await webContents.removeInsertedCSS(previousKey);
        } catch {
            // view navigated since insert: old stylesheet already gone
        }
    }

    if (!css.trim()) return;

    try {
        insertedThemeCssKeys.set(webContents, await webContents.insertCSS(css));
    } catch (error) {
        console.error(`Failed to apply custom theme CSS to ${target} view:`, error);
    }
}

function applyThemeToContent(isDark: boolean, only?: BrowserView) {
    if (!contentView) return;

    const customThemeCSS = themeService.getCurrentCustomThemeCSS();
    const themeColors = themeService.getCurrentThemeColors();

    notificationManager?.setThemeColors(themeColors);
    settingsManager?.setThemeColors(themeColors);
    downloadManager?.setThemeColors(themeColors);
    headerContents()?.send('theme-colors-changed', themeColors);

    const hidePromotions = store.get('hidePromotions', true);
    const hideEventsNearYou = store.get('hideEventsNearYou', true);
    const hideArtistUpsells = store.get('hideArtistUpsells', true);

    // /* @target all|content|header|settings */ ... /* @end */
    const sections = (function splitSections(css: string | null) {
        const res = { all: '', content: '', header: '', settings: '' } as Record<string, string>;
        if (!css) return res;
        const regex =
            /\/\*\s*@target\s+(all|content|header|settings)\s*\*\/[\s\S]*?(?=(\/\*\s*@target\s+(?:all|content|header|settings)\s*\*\/)|$)/gi;
        let match: RegExpExecArray | null;
        let any = false;
        while ((match = regex.exec(css)) !== null) {
            any = true;
            const block = match[0];
            const targetMatch = /@target\s+(all|content|header|settings)/i.exec(block);
            const target = (targetMatch?.[1] || '').toLowerCase();
            const body = block.replace(/^[\s\S]*?\*\//, '').trim();
            res[target] += (res[target] ? '\n' : '') + body;
        }
        // no markers: whole theme is content view
        if (!any) res.content = css;
        return res;
    })(customThemeCSS);

    // macOS overlay scrollbars hide when idle; ::-webkit-scrollbar rules make them permanent: win/linux only
    const scrollbarCss = isMac
        ? ''
        : `
              ::-webkit-scrollbar-button {
                  display: none;
              }

              ::-webkit-scrollbar {
                  width: 10px;
                  height: 10px;
                  background-color: transparent;
              }

              ::-webkit-scrollbar-track {
                  background-color: transparent;
              }

              ::-webkit-scrollbar-thumb {
                  background-color: ${isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)'};
                  border-radius: 4px;
                  border: 2px solid transparent;
                  background-clip: content-box;
                  transition: background-color 0.3s;
              }

              ::-webkit-scrollbar-thumb:hover {
                  background-color: ${isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)'};
              }

              ::-webkit-scrollbar-corner {
                  background-color: transparent;
              }
          `;

    const themeScript = `
        (function() {
            try {
                document.documentElement.classList.toggle('theme-light', !${isDark});
                document.documentElement.classList.toggle('theme-dark', ${isDark});
                document.body.classList.toggle('theme-light', !${isDark});
                document.body.classList.toggle('theme-dark', ${isDark});
                
                if (${isDark}) {
                    document.documentElement.style.setProperty('--background-base', '#121212');
                    document.documentElement.style.setProperty('--background-surface', '#212121');
                    document.documentElement.style.setProperty('--text-base', '#ffffff');
                } else {
                    document.documentElement.style.setProperty('--background-base', '#ffffff');
                    document.documentElement.style.setProperty('--background-surface', '#f2f2f2');
                    document.documentElement.style.setProperty('--text-base', '#333333');
                }
                
                const style = document.createElement('style');
                style.id = 'custom-scrollbar-style';
                style.textContent = \`
                    ${scrollbarCss}
                    
                    ${hidePromotions ? '.banner.m-promotion, .sidebarModule.mobileApps { display: none !important; }' : ''}

                    /* footer: keep language selector; separators are bare text nodes, collapse via font-size */
                    ${hidePromotions ? '.l-footer { font-size: 0 !important; line-height: 0 !important; } .l-footer > a { display: none !important; } .l-footer .footer__localeSelector { font-size: 14px !important; line-height: 20px !important; margin-top: 0 !important; }' : ''}
                    
                    ${hideEventsNearYou ? '.velvetCakeModule { display: none !important; }' : ''}

                    /* search lives in title bar (header.html) */
                    .header__search { display: none !important; }

                    /* "..." menu minus company links; first list is only those */
                    .moreMenu .headerMenu__list:has(a[href$="/company/home"]), .moreMenu li:has(> a:is([href="/download"], [href$="/company/newsroom"], [href$="/jobs"], [href*="developers.soundcloud.com"], [href*="store.soundcloud.com"])) { display: none !important; }
                    
					${hideArtistUpsells ? '.header__upsellWrapper, .creatorSubscriptionsButton.header__creatorUpsell, .artistConnectItem.m-upsellNextPro, .dropdownMenu [href*="checkout.soundcloud.com"], .dropdownMenu *:has(> svg.profileMenu__icon path[fill="#F50"]), .spotlight:has(.spotlight__upsellBanner), .spotlight__upsellBanner, .spotlight__upsellCTA, .sidebarContent:has(.velvetCakeIframe), .artistConnectContainer .tileGallery__sliderPeekForward, .artistConnectContainer .tileGallery__sliderPeekBackward, .MuiBox-root:has(a[href*="getstarted/fan-support"]) { display: none !important; }' : ''}
                \`;
                
                const existingStyle = document.getElementById('custom-scrollbar-style');
                if (existingStyle) {
                    existingStyle.remove();
                }
                document.head.appendChild(style);

                // same-origin iframe upsells: out of stylesheet reach
                if (window._artistUpsellInterval) {
                    clearInterval(window._artistUpsellInterval);
                    window._artistUpsellInterval = null;
                }
                if (${hideArtistUpsells}) window._artistUpsellInterval = setInterval(() => {
                    document.querySelectorAll('iframe[title="Artist tools"], iframe[title="Sidebar modules"]').forEach(iframe => {
                        try {
                            const doc = iframe.contentDocument || iframe.contentWindow?.document;
                            const container = iframe.closest('.webiEmbeddedModuleContainer');
                            
                            if (container && doc) {
                                // fan-support waitlist card
                                if (!doc.getElementById('custom-iframe-style')) {
                                    const iframeStyle = doc.createElement('style');
                                    iframeStyle.id = 'custom-iframe-style';
                                    iframeStyle.textContent = '.MuiBox-root:has(a[href*="getstarted/fan-support"]) { display: none !important; }';
                                    doc.head.appendChild(iframeStyle);
                                }

                                // paywall-only module: hide whole container
                                const paywalled = doc.querySelector('svg[aria-label="Paywalled feature"]');
                                container.style.display = paywalled ? 'none' : '';
                            }
                        } catch(e) {
                            // iframe not loaded yet: next pass retries
                        }
                    });
                }, 1000);

                // reject optional OneTrust categories (targeting, functional, performance): default on
                // OneTrust loads late, so wait; remembers choice in own cookie
                if (!window._cookieRejectInterval) {
                    let tries = 0;
                    window._cookieRejectInterval = setInterval(() => {
                        const ready = window.OneTrust && typeof window.OnetrustActiveGroups === 'string';
                        if (!ready && ++tries < 60) return;
                        clearInterval(window._cookieRejectInterval);
                        window._cookieRejectInterval = null;
                        if (ready && /C000[2-4]/.test(window.OnetrustActiveGroups)) window.OneTrust.RejectAll();
                    }, 500);
                }
            } catch(e) {
                console.error('Error applying theme:', e);
            }
        })();
    `;

    const targets = (only ? [only] : tabs.map((tab) => tab.view)).filter((view) => !view.webContents.isDestroyed());
    for (const view of targets) {
        // mainFrame, not webContents: latter queues until did-stop-loading
        view.webContents.mainFrame.executeJavaScript(themeScript).catch(console.error);
    }

    // custom theme sections go in as stylesheets, never script source
    const joinSection = (section: string) => sections.all + (sections.all && section ? '\n' : '') + section || '';

    for (const view of targets) {
        void applyCustomThemeCss('content', view.webContents, joinSection(sections.content));
    }
    void applyCustomThemeCss('header', headerView?.webContents, joinSection(sections.header));
    void applyCustomThemeCss('settings', settingsManager?.getView()?.webContents, joinSection(sections.settings));
}

function initializeShortcuts() {
    if (!mainWindow || !contentView || !settingsManager) return;

    shortcutService.register('openSettings', 'F1', 'Open Settings', () => settingsManager.toggle());

    if (devMode) {
        shortcutService.register('devTools', 'F12', 'Open Developer Tools', () => {
            if (contentView) contentView.webContents.openDevTools();
        });
    }

    shortcutService.register('zoomIn', 'CommandOrControl+=', 'Zoom In', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.min(zoomLevel + 1, 9));
    });

    shortcutService.register('zoomOut', 'CommandOrControl+-', 'Zoom Out', () => {
        if (!contentView) return;
        const zoomLevel = contentView.webContents.getZoomLevel();
        contentView.webContents.setZoomLevel(Math.max(zoomLevel - 1, -9));
    });

    shortcutService.register('zoomReset', 'CommandOrControl+0', 'Reset Zoom', () => {
        if (contentView) contentView.webContents.setZoomLevel(0);
    });

    const back = () => navigateHistory('back');
    const forward = () => navigateHistory('forward');
    shortcutService.register('goBack', 'CommandOrControl+B', 'Go Back', back);
    shortcutService.register('goBackAlt', 'CommandOrControl+P', 'Go Back (Alternative)', back);
    shortcutService.register('goForward', 'CommandOrControl+F', 'Go Forward', forward);
    shortcutService.register('goForwardAlt', 'CommandOrControl+N', 'Go Forward (Alternative)', forward);
    shortcutService.register('refresh', 'CommandOrControl+R', 'Refresh Page', reloadContent);

    shortcutService.register('newTab', 'CommandOrControl+T', 'New Tab', () => void openTab());
    shortcutService.register('closeTab', 'CommandOrControl+W', 'Close Tab', () => {
        closeTab(tabs.find((tab) => tab.view === contentView)?.id);
    });
    shortcutService.register('nextTab', 'Control+Tab', 'Next Tab', () => cycleTab(1));
    shortcutService.register('previousTab', 'Control+Shift+Tab', 'Previous Tab', () => cycleTab(-1));
    shortcutService.register('focusUrlBar', 'CommandOrControl+L', 'Focus URL Bar', () => {
        const header = headerContents();
        header?.focus();
        header?.send('focus-url-bar');
    });

    console.log(`Initialized ${shortcutService.count} keyboard shortcuts`);
}

app.on('ready', init);

app.on('window-all-closed', () => {
    if (!isMac) app.quit();
});

// dock icon clicked; macOS window is only hidden, never destroyed mid-session
app.on('activate', showMainWindow);

app.on('before-quit', () => {
    isQuitting = true;
    downloadManager?.cancelAll();
    shortcutService?.destroy();
    tray?.destroy();
    tray = null;
});

app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;

    const { username, password } = proxyService?.handleAuth() ?? { username: '', password: '' };
    if (!username && !password) return;

    event.preventDefault();
    callback(username, password);
});

app.on('second-instance', showMainWindow);

export function queueToastNotification(message: string) {
    if (mainWindow && notificationManager) {
        notificationManager.show(message);
    }
}

function setupTranslationHandlers() {
    // settings panel looks up strings by data-i18n keys
    ipcMain.handle('get-translations', () => translationService.all());
}

function setupAudioHandler() {
    ipcMain.on('soundcloud:track-update', async (event, payload: unknown) => {
        if (!isTrustedSoundCloudSender(event)) {
            console.warn('Rejected track update from untrusted sender');
            return;
        }

        const update = validateTrackUpdatePayload(payload);
        if (!update) {
            console.warn('Rejected invalid track update payload');
            return;
        }

        const { data: result, reason } = update;

        // every tab runs monitor: paused tab must not overwrite playing one
        const senderTab = tabOfSender(event);
        if (result.isPlaying) audioTabId = senderTab?.id;
        else if (audioTabId !== undefined && audioTabId !== senderTab?.id) return;

        if (devMode) console.debug(`Track update received: ${reason}`);

        lastTrackInfo = result;
        pluginService?.notifyTrackChange(result as unknown as Record<string, unknown>);

        if (result.title && result.author && result.duration) {
            await Promise.all([
                lastFmService.updateTrackInfo(
                    {
                        title: result.title,
                        author: result.author,
                        duration: result.duration,
                        elapsed: result.elapsed,
                    },
                    result.isPlaying,
                ),
                webhookService.updateTrackInfo(
                    {
                        title: result.title,
                        author: result.author,
                        duration: result.duration,
                        url: result.url,
                        artwork: result.artwork,
                        elapsed: result.elapsed,
                    },
                    result.isPlaying,
                ),
                presenceService.updatePresence(result),
            ]);
        } else {
            await presenceService.updatePresence(result);
        }

        if (settingsManager?.isPanelVisible()) {
            settingsManager.getView()?.webContents.send('presence-preview-update', result);
        }

        thumbarService?.updateThumbarButtons(
            mainWindow,
            result.isPlaying,
            result.isLiked,
            senderTab?.view ?? contentView,
        );
    });
}
