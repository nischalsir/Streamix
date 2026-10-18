const features = [
    "castmenuhashchange",
    "clientsettings",
    "displaylanguage",
    "downloadmanagement",
    "exit",
    "externallinks",
    "filedownload",
    "fileinput",
    "htmlaudioautoplay",
    "htmlvideoautoplay",
    "multiserver",
    "physicalvolumecontrol",
    "remotecontrol",
    "subtitleappearancesettings",
    "subtitleburnsettings"
];

const plugins = [
    'NavigationPlugin',
    'ExoPlayerPlugin',
    'ExternalPlayerPlugin',
    'MediaSegmentsPlugin'
];

// Add plugin loaders
for (const plugin of plugins) {
    window[plugin] = async () => {
        const pluginDefinition = await import(`/native/${plugin}.js`);
        return pluginDefinition[plugin];
    };
}

const { deviceId, deviceName, appName, appVersion } = JSON.parse(window.NativeInterface.getDeviceInformation());
const codecCaps = JSON.parse(window.NativeInterface.getCodecCapabilities());
const isTv = !!(window.NativeInterface.isTv && window.NativeInterface.isTv());

// A TV has no use for downloading media to itself; dropping these hides every download button and menu
if (isTv) {
    for (const feature of ['downloadmanagement', 'filedownload']) {
        features.splice(features.indexOf(feature), 1);
    }
}

// Streamix: TV performance layer + login backdrop, applied on top of the server's custom CSS
(() => {
    const root = document.documentElement;
    root.classList.add('streamix');
    if (isTv) root.classList.add('streamix-tv');

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // Relative, so it also works when the server lives under a base path (e.g. /jellyfin/web/)
    link.href = 'native/streamix.css';
    document.head.appendChild(link);

    // Login, server selection and password pages get the server's splash-screen artwork behind them
    const STANDALONE_PAGES = '#loginPage:not(.hide), #selectServerPage:not(.hide), #forgotPasswordPage:not(.hide), '
        + '#forgotPasswordPinPage:not(.hide), .standalonePage:not(.hide)';
    const updateLoginState = () => {
        const route = (window.location.hash || window.location.pathname).toLowerCase();
        const onLoginRoute = /login|selectserver|forgotpassword|addserver/.test(route);
        root.classList.toggle('streamix-login', onLoginRoute || !!document.querySelector(STANDALONE_PAGES));
    };

    // Clean artwork for libraries. Jellyfin generates library images with the library's name drawn
    // on them; Streamix uses a backdrop picked from inside the library instead, kept for the session.
    const LIBRARY_TYPES = /^(CollectionFolder|UserView)$/;
    const libraryPicks = new Map();
    const pickFromLibrary = (libraryId) => {
        if (!libraryPicks.has(libraryId)) {
            const api = window.ApiClient;
            const request = api.getItems(api.getCurrentUserId(), {
                ParentId: libraryId,
                Recursive: true,
                IncludeItemTypes: 'Movie,Series,MusicArtist,MusicAlbum,BoxSet,Video',
                ImageTypes: 'Backdrop',
                SortBy: 'Random',
                Limit: 1,
                EnableTotalRecordCount: false,
                Fields: 'BackdropImageTags'
            }).then((result) => {
                const item = result && result.Items && result.Items[0];
                return item && item.BackdropImageTags && item.BackdropImageTags.length
                    ? { id: item.Id, tag: item.BackdropImageTags[0] }
                    : null;
            }).catch(() => null);
            libraryPicks.set(libraryId, request);
        }
        return libraryPicks.get(libraryId);
    };
    const libraryArtUrl = (pick, maxWidth) => window.ApiClient.getImageUrl(pick.id, {
        type: 'Backdrop', index: 0, tag: pick.tag, maxWidth, quality: 80
    });

    const retileLibraries = () => {
        if (!window.ApiClient || !window.ApiClient.getItems) return;
        const cards = document.querySelectorAll(
            '.card[data-type="CollectionFolder"]:not([data-streamix-art]), .card[data-type="UserView"]:not([data-streamix-art])'
        );
        cards.forEach((card) => {
            card.setAttribute('data-streamix-art', '1');
            pickFromLibrary(card.getAttribute('data-id')).then((pick) => {
                if (!pick) return;
                const url = libraryArtUrl(pick, 720);
                const img = new Image();
                img.decoding = 'async';
                img.src = url;
                return img.decode().then(() => {
                    const tile = card.querySelector('.cardImageContainer');
                    if (!tile) return;
                    // data-src too, so the lazy loader can't put the old image back
                    tile.setAttribute('data-src', url);
                    tile.style.backgroundImage = `url("${url}")`;
                });
            }).catch(() => {});
        });
    };

    // Apple TV style backdrops: while browsing, the focused title's artwork fills the background.
    // Waits for focus to settle, decodes off the main thread, then cross-fades two layers on the GPU.
    const backdrop = (() => {
        const SETTLE_MS = 350;
        const cache = new Map();
        let root = null;
        let layers = [];
        let front = 0;
        let shownUrl = null;
        let timer = null;
        let requested = null;

        const ensureRoot = () => {
            const container = document.querySelector('.backgroundContainer');
            if (!container) return null;
            if (root && root.parentElement === container) return root;
            root = document.createElement('div');
            root.id = 'streamixBackdrop';
            layers = [document.createElement('div'), document.createElement('div')];
            layers.forEach((layer) => {
                layer.className = 'sbLayer';
                root.appendChild(layer);
            });
            const scrim = document.createElement('div');
            scrim.className = 'sbScrim';
            root.appendChild(scrim);
            container.appendChild(root);
            shownUrl = null;
            return root;
        };

        const urlFor = async (id, type) => {
            if (!id) return null;
            if (cache.has(id)) return cache.get(id);
            const api = window.ApiClient;
            if (!api || !api.getItem) return null;
            let url = null;
            try {
                if (LIBRARY_TYPES.test(type || '')) {
                    // Libraries: the server's generated art has the library name drawn on it
                    const pick = await pickFromLibrary(id);
                    url = pick && libraryArtUrl(pick, 1280);
                    cache.set(id, url);
                    return url;
                }
                const item = await api.getItem(api.getCurrentUserId(), id);
                const opts = { type: 'Backdrop', maxWidth: 1280, quality: 72 };
                if (item.BackdropImageTags && item.BackdropImageTags.length) {
                    url = api.getImageUrl(item.Id, { ...opts, index: 0, tag: item.BackdropImageTags[0] });
                } else if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
                    url = api.getImageUrl(item.ParentBackdropItemId, { ...opts, index: 0, tag: item.ParentBackdropImageTags[0] });
                } else if (item.IsFolder) {
                    const pick = await pickFromLibrary(item.Id);
                    url = pick && libraryArtUrl(pick, 1280);
                }
            } catch (e) {
                url = null;
            }
            cache.set(id, url);
            return url;
        };

        const show = async (url) => {
            if (!url || url === shownUrl || !ensureRoot()) return;
            requested = url;
            const img = new Image();
            img.decoding = 'async';
            img.alt = '';
            img.src = url;
            try {
                await img.decode();
            } catch (e) {
                return;
            }
            if (requested !== url) return; // focus moved on while this was loading
            const back = 1 - front;
            layers[back].replaceChildren(img);
            layers[back].classList.add('active');
            layers[front].classList.remove('active');
            const old = layers[front];
            setTimeout(() => {
                if (!old.classList.contains('active')) old.replaceChildren();
            }, 900);
            front = back;
            shownUrl = url;
        };

        return {
            focus(card) {
                clearTimeout(timer);
                timer = setTimeout(async () => show(await urlFor(card.getAttribute('data-id'), card.getAttribute('data-type'))), SETTLE_MS);
            },
            async item(id) {
                clearTimeout(timer);
                show(await urlFor(id, null));
            },
            refresh() {
                ensureRoot();
            }
        };
    })();

    // Movie / show pages: the remote should move between things you can act on (Play, the other buttons,
    // track pickers, cast, "More like this"), not stop on every keyword, genre, studio and name link.
    // Jellyfin's focus navigation skips tabindex="-1".
    const skipTextLinks = () => {
        if (!isTv) return;
        const page = document.querySelector('.mainAnimatedPage.itemDetailPage:not(.hide)');
        if (!page) return;
        page.querySelectorAll('a.button-link:not([tabindex])').forEach((link) => link.setAttribute('tabindex', '-1'));
    };

    // Backdrops belong to pages with posters (home, libraries, search results), not settings or details
    const updateBrowseState = () => {
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        const detail = !!page && page.classList.contains('itemDetailPage');
        const browsing = !!page && !detail && !!page.querySelector('.card[data-id]');
        root.classList.toggle('streamix-browse', browsing);
        root.classList.toggle('streamix-detail', detail);
        if (browsing || detail) backdrop.refresh();
        if (detail) {
            skipTextLinks();
            // The page fills in after it's shown
            setTimeout(skipTextLinks, 400);
            setTimeout(skipTextLinks, 1500);
            // Detail pages: that title's artwork, full-bleed, like Apple TV
            const id = new URLSearchParams((window.location.hash.split('?')[1]) || '').get('id');
            if (id) backdrop.item(id);
        }
    };

    // Coming back from the player, settings or downloads: put remote focus on Play/Resume or the
    // first item, so the next key press does something visible
    window.addEventListener('focus', () => setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        const target = page && (page.querySelector('.btnPlay:not(.hide), .btnResume:not(.hide)')
            || page.querySelector('.card[data-id], .emby-button:not(.hide), a.listItem-border'));
        if (target) target.focus();
    }, 120));

    document.addEventListener('focusin', (e) => {
        if (root.classList.contains('streamix-detail')) skipTextLinks();
        const card = e.target.closest && e.target.closest('.card[data-id]');
        if (!card) return;
        // Checked here too: the page-shown event can fire before this script is listening
        updateBrowseState();
        retileLibraries();
        if (root.classList.contains('streamix-browse')) backdrop.focus(card);
    });

    // Tell the app when the first page is on screen, so the splash can fade into it
    let readyReported = false;
    const reportReady = () => {
        if (readyReported) return;
        readyReported = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            setTimeout(() => window.NativeInterface.onWebAppReady && window.NativeInterface.onWebAppReady(), 150);
        }));
    };

    // Settings menu on TV: plain names for the entries that stay (the technical ones are hidden in CSS)
    const relabelSettingsMenu = () => {
        if (!isTv) return;
        const page = document.querySelector('.mainAnimatedPage.userPreferencesPage:not(.hide)');
        if (!page) return;
        const relabel = (selector, text) => {
            const label = page.querySelector(selector + ' .listItemBodyText');
            if (label && label.textContent !== text) label.textContent = text;
        };
        relabel('.lnkDisplayPreferences', 'Display & language');
        relabel('.lnkHomePreferences', 'Home screen');
        relabel('.lnkPlaybackPreferences', 'Audio & playback');
        relabel('.clientSettings', 'Streamix Settings');
        relabel('.selectServer', 'Switch Server');
    };

    const updatePageState = () => {
        updateLoginState();
        updateBrowseState();
        retileLibraries();
        relabelSettingsMenu();
        setTimeout(relabelSettingsMenu, 300);
    };

    // Libraries open on "Suggestions"; when that's empty, show the full list (Shows / Movies) instead
    const skipEmptySuggestions = () => {
        if (!isTv) return;
        const page = document.querySelector('.mainAnimatedPage.withTabs:not(.hide)');
        const suggestions = page && page.querySelector('#suggestionsTab.is-active');
        if (!suggestions || suggestions.querySelector('.card')) return;
        const firstTab = document.querySelector('.skinHeader .headerTabs .emby-tab-button');
        if (firstTab && !firstTab.classList.contains('emby-tab-button-active')) firstTab.click();
    };

    // A newly shown page starts with focus on its content, not left behind in the top bar
    const focusContent = () => {
        if (!isTv) return;
        const active = document.activeElement;
        const inTopBar = active && active.closest && active.closest('.skinHeader');
        if (!inTopBar && active && active !== document.body) return;
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        const target = page && (page.querySelector('.btnPlay:not(.hide), .btnResume:not(.hide)')
            || page.querySelector('.card[data-id], a.listItem-border:not(.hide)'));
        if (target && target.offsetParent !== null) target.focus();
    };

    document.addEventListener('viewshow', () => {
        updatePageState();
        reportReady();
        setTimeout(focusContent, 350);
        setTimeout(focusContent, 1200);
        setTimeout(skipEmptySuggestions, 1800);
        setTimeout(focusContent, 2300);
        // Home sections render after the page is shown
        setTimeout(retileLibraries, 800);
        setTimeout(retileLibraries, 2500);
    });
    window.addEventListener('hashchange', () => setTimeout(updatePageState, 50));
    window.addEventListener('popstate', () => setTimeout(updatePageState, 50));

    // Fallback for pages that don't fire viewshow
    let checks = 0;
    const poll = setInterval(() => {
        checks++;
        updatePageState();
        if (document.querySelector('.mainAnimatedPage:not(.hide), .page:not(.hide), #reactRoot .MuiAppBar-root')) reportReady();
        if (readyReported || checks > 60) clearInterval(poll);
    }, 200);
})();

window.NativeShell = {
    enableFullscreen() {
        window.NativeInterface.enableFullscreen();
    },

    disableFullscreen() {
        window.NativeInterface.disableFullscreen();
    },

    openUrl(url, target) {
        window.NativeInterface.openUrl(url);
    },

    updateMediaSession(mediaInfo) {
        window.NativeInterface.updateMediaSession(JSON.stringify(mediaInfo));
    },

    hideMediaSession() {
        window.NativeInterface.hideMediaSession();
    },

    updateVolumeLevel(value) {
        window.NativeInterface.updateVolumeLevel(value);
    },

    downloadFile(downloadInfo) {
        window.NativeInterface.downloadFiles(JSON.stringify([downloadInfo]));
    },

    downloadFiles(downloadInfo) {
        window.NativeInterface.downloadFiles(JSON.stringify(downloadInfo));
    },

    openDownloadManager() {
        window.NativeInterface.openDownloadManager();
    },

    openClientSettings() {
        window.NativeInterface.openClientSettings();
    },

    selectServer() {
        window.NativeInterface.openServerSelection();
    },

    getPlugins() {
        return plugins;
    },

    async execCast(action, args, callback) {
        this.castCallbacks = this.castCallbacks || {};
        this.castCallbacks[action] = callback;
        window.NativeInterface.execCast(action, JSON.stringify(args));
    },

    async castCallback(action, keep, err, result) {
        const callbacks = this.castCallbacks || {};
        const callback = callbacks[action];
        callback && callback(err || null, result);
        if (!keep) {
            delete callbacks[action];
        }
    }
};

function getDeviceProfile(profileBuilder, item) {
    return profileBuilder();
}

window.NativeShell.AppHost = {
    init() {},
    getDefaultLayout() {
        return isTv ? "tv" : "mobile";
    },
    supports(command) {
        command = command.toLowerCase();
        if (command === "chromecast") {
            return window.NativeInterface.hasChromecast();
        }
        return features.includes(command);
    },
    getDeviceProfile,
    deviceName() {
        return deviceName;
    },
    deviceId() {
        return deviceId;
    },
    appName() {
        return appName;
    },
    appVersion() {
        return appVersion;
    },
    exit() {
        window.NativeInterface.exitApp();
    }
};
