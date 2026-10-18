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
            // Live TV has no artwork of its own; it gets a designed tile instead (see streamix.css)
            if (card.getAttribute('data-collectiontype') === 'livetv') {
                card.classList.add('streamixLiveTvTile');
                return;
            }
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

    // Show, season and collection pages put "Next Up", "Seasons", the episode list and a collection's
    // titles in the narrow column beside the poster, while cast and "More like this" span the page.
    // Move them down into the full-width area so every row starts at the same edge and has room.
    const alignDetailRows = () => {
        if (!isTv) return;
        const page = document.querySelector('.mainAnimatedPage.itemDetailPage:not(.hide)');
        if (!page) return;
        const primary = page.querySelector('.detailPagePrimaryContainer');
        const secondary = page.querySelector('.detailPageSecondaryContainer');
        if (primary && secondary) {
            const rows = [...primary.querySelectorAll('.detailVerticalSection, .collectionItems')];
            rows.reverse().forEach((row) => {
                row.classList.add('streamixMovedRow');
                secondary.insertBefore(row, secondary.firstChild);
            });
        }
        // Hide rows that ended up empty, and show them again if they fill in later
        page.querySelectorAll('.detailVerticalSection').forEach((row) => {
            const list = row.querySelector('.itemsContainer, .childrenItemsContainer, #childrenContent');
            const empty = !!list && !list.querySelector('.card, .listItem, button');
            row.classList.toggle('streamixEmptyRow', empty && !row.classList.contains('hide'));
        });
    };

    // Backdrops belong to pages with posters (home, libraries, search results), not settings or details
    const updateBrowseState = () => {
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        const detail = !!page && page.classList.contains('itemDetailPage');
        const liveTv = !!page && page.classList.contains('liveTvPage');
        const browsing = !!page && !detail && !liveTv && !!page.querySelector('.card[data-id]');
        root.classList.toggle('streamix-browse', browsing);
        root.classList.toggle('streamix-detail', detail);
        root.classList.toggle('streamix-livetv', liveTv);
        if (browsing || detail) backdrop.refresh();
        if (detail) {
            skipTextLinks();
            alignDetailRows();
            // The page fills in after it's shown
            setTimeout(skipTextLinks, 400);
            setTimeout(skipTextLinks, 1500);
            [400, 1200, 2500].forEach((delay) => setTimeout(alignDetailRows, delay));
            // Detail pages: that title's artwork, full-bleed, like Apple TV
            const id = new URLSearchParams((window.location.hash.split('?')[1]) || '').get('id');
            if (id) backdrop.item(id);
        }
    };

    // Coming back from the player, settings or downloads: put remote focus on Play/Resume, the item
    // that was picked (say, the channel that was on), or the first item, so the next key press does
    // something visible
    let lastPicked = null;
    window.addEventListener('focus', () => setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        if (!page) return;
        const picked = lastPicked && lastPicked.isConnected && page.contains(lastPicked)
            && lastPicked.offsetParent !== null ? lastPicked : null;
        const target = page.querySelector('.btnPlay:not(.hide), .btnResume:not(.hide)') || picked
            || page.querySelector('.card[data-id], .emby-button:not(.hide), a.listItem-border');
        if (target) target.focus();
    }, 120));

    // Channel cards keep blank lines for a channel number and the programme on now; without guide
    // data they're empty, so mark them and let the CSS fold them away. IPTV lists also tag names with
    // the stream's resolution ("Kantipur TV (1080p)"), which only crowds the name.
    const QUALITY_TAG = /\s*\((?:\d{3,4}[pi]|4K|UHD)\)/i;
    const tidyChannelCards = () => {
        document.querySelectorAll('.card[data-type="TvChannel"]:not([data-streamix-tidy])').forEach((card) => {
            card.setAttribute('data-streamix-tidy', '1');
            card.querySelectorAll('.cardFooter .cardText').forEach((line) => {
                if (!line.textContent.trim()) line.classList.add('streamixEmpty');
            });
            const name = card.querySelector('.cardText-first bdi');
            if (name && QUALITY_TAG.test(name.textContent)) {
                name.textContent = name.textContent.replace(QUALITY_TAG, '').trim();
            }
        });
    };

    document.addEventListener('focusin', (e) => {
        if (root.classList.contains('streamix-detail')) skipTextLinks();
        if (root.classList.contains('streamix-livetv')) tidyChannelCards();
        // Live TV: OK on a channel (a card or a row in the guide) starts watching it, like a TV,
        // instead of opening its info page
        const channel = isTv && e.target.closest && e.target.closest('[data-type="TvChannel"][data-action="link"]');
        if (channel) {
            channel.setAttribute('data-action', 'play');
            // Guide rows leave this out, and the player won't take an item without it
            if (!channel.hasAttribute('data-mediatype')) channel.setAttribute('data-mediatype', 'Video');
        }
        const picked = e.target.closest && e.target.closest('.card[data-id], .guide-channelHeaderCell');
        if (picked) lastPicked = picked;
        const card = e.target.closest && e.target.closest('.card[data-id]');
        if (!card) return;
        // Checked here too: the page-shown event can fire before this script is listening
        updateBrowseState();
        retileLibraries();
        if (root.classList.contains('streamix-browse')) backdrop.focus(card);
    });

    // Text fields: on a TV, landing on one pops the on-screen keyboard up, even when you were only moving
    // past it (settings pages are full of them). Keep fields read-only until OK is pressed on them, the way
    // the TV's own settings work. The search box is left alone: there you always want to type.
    const TYPEABLE = 'input:not([type]), input[type=text], input[type=number], input[type=password], '
        + 'input[type=email], input[type=url], input[type=tel], textarea';
    let unlocking = null;
    if (isTv) {
        document.addEventListener('focusin', (e) => {
            const field = e.target;
            if (!field.matches || !field.matches(TYPEABLE) || field === unlocking) return;
            if (field.closest('.searchFields, .searchfields-txtSearch') || field.type === 'search') return;
            if (field.readOnly && !field.hasAttribute('data-streamix-lock')) return; // read-only by design
            field.readOnly = true;
            field.setAttribute('data-streamix-lock', '1');
        }, true);
        document.addEventListener('keydown', (e) => {
            const field = document.activeElement;
            if (e.key !== 'Enter' || !field || !field.hasAttribute('data-streamix-lock') || !field.readOnly) return;
            e.preventDefault();
            e.stopPropagation();
            field.readOnly = false;
            // Re-focusing an editable field from a key press brings the keyboard up
            unlocking = field;
            field.blur();
            field.focus();
            unlocking = null;
        }, true);
    }

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

    // Libraries open on "Suggestions"; when that's empty, show the full list (Shows / Movies) instead.
    // Live TV opens on "Programs", which is empty without guide data; show the channels then.
    const skipEmptySuggestions = () => {
        if (!isTv) return;
        const page = document.querySelector('.mainAnimatedPage.withTabs:not(.hide)');
        if (!page) return;
        const tabs = document.querySelectorAll('.skinHeader .headerTabs .emby-tab-button');
        if (page.classList.contains('liveTvPage')) {
            const programs = page.querySelector('.pageTabContent.is-active[data-index="0"]');
            if (!programs || programs.querySelector('.card')) return;
            const channelsTab = [...tabs].find((tab) => tab.getAttribute('data-index') === '2');
            if (!channelsTab) return;
            channelsTab.click();
            setTimeout(tidyChannelCards, 400);
            // Land on the first channel once the grid is in
            let tries = 0;
            const focusFirstChannel = setInterval(() => {
                const first = page.querySelector('.pageTabContent.is-active .card[data-id]');
                if (first || ++tries > 20) clearInterval(focusFirstChannel);
                if (first) first.focus();
            }, 150);
            return;
        }
        const suggestions = page.querySelector('#suggestionsTab.is-active');
        if (!suggestions || suggestions.querySelector('.card')) return;
        const firstTab = tabs[0];
        if (firstTab && !firstTab.classList.contains('emby-tab-button-active')) firstTab.click();
    };

    // A newly shown page starts with focus on its content, not left behind in the top bar or on the
    // sort / filter buttons above a grid (where Jellyfin's autofocus tends to put it)
    let movedSinceShown = false;
    document.addEventListener('keydown', (e) => {
        if (e.key && e.key.startsWith('Arrow')) movedSinceShown = true;
    }, true);
    const focusContent = () => {
        if (!isTv) return;
        const active = document.activeElement;
        const inTopBar = active && active.closest && active.closest('.skinHeader');
        const onToolbar = !movedSinceShown && active && active.closest
            && active.closest('.alphaPicker, .pageTabContent > .flex:first-child, .libraryPage > .flex:first-child');
        if (!inTopBar && !onToolbar && active && active !== document.body) return;
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        // On pages with tabs, the visible tab: hidden tabs keep their cards in the page
        const scope = page && (page.querySelector('.pageTabContent.is-active') || page);
        const visible = (el) => el.offsetParent !== null;
        const target = scope && ([...scope.querySelectorAll('.btnPlay:not(.hide), .btnResume:not(.hide)')].find(visible)
            || [...scope.querySelectorAll('.card[data-id], a.listItem-border:not(.hide)')].find(visible));
        if (target) target.focus();
    };

    document.addEventListener('viewshow', () => {
        movedSinceShown = false;
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
