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
    root.classList.add(isTv ? 'streamix-tv' : 'streamix-mobile');

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

    // Live TV opens on Programs, which is empty without a TV guide. Without one, the home screen's Live TV
    // tile goes straight to the channels instead (asked once in a while, not on every visit).
    let liveTvHasGuide = null;
    let liveTvGuideCheckedAt = 0;
    const checkLiveTvGuide = () => {
        const api = window.ApiClient;
        if (!api || !api.getLiveTvRecommendedPrograms || Date.now() - liveTvGuideCheckedAt < 10 * 60 * 1000) return;
        liveTvGuideCheckedAt = Date.now();
        api.getLiveTvRecommendedPrograms({ userId: api.getCurrentUserId(), IsAiring: true, Limit: 1 })
            .then((result) => {
                liveTvHasGuide = !!(result && result.Items && result.Items.length);
            })
            .catch(() => {});
    };
    document.addEventListener('click', (e) => {
        const tile = e.target.closest && e.target.closest('.card[data-collectiontype="livetv"]');
        if (!tile || liveTvHasGuide) return;
        e.preventDefault();
        e.stopPropagation();
        const serverId = tile.getAttribute('data-serverid');
        window.location.hash = '#/livetv?collectionType=livetv&tab=2' + (serverId ? '&serverId=' + serverId : '');
    }, true);


    let artPending = 0;
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
                checkLiveTvGuide();
                return;
            }
            artPending++;
            pickFromLibrary(card.getAttribute('data-id')).then((pick) => {
                if (!pick) return;
                const url = libraryArtUrl(pick, 720);
                const img = new Image();
                img.decoding = 'async';
                img.src = url;
                return img.decode().then(() => {
                    const tile = card.querySelector('.cardImageContainer');
                    if (!tile) return;
                    // On a layer of its own: Jellyfin's image loader may still be fetching the old picture
                    // for the tile itself, and would put it back when it finishes
                    let art = tile.querySelector(':scope > .streamixLibraryArt');
                    if (!art) {
                        art = document.createElement('div');
                        art.className = 'streamixLibraryArt';
                        tile.prepend(art);
                    }
                    art.style.backgroundImage = `url("${url}")`;
                });
            }).catch(() => {}).finally(() => {
                artPending--;
            });
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
        let settled = false;

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
            if (!url || url === shownUrl || !ensureRoot()) {
                settled = true;
                return;
            }
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
            settled = true;
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
            },
            settled() {
                return settled;
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
        // Phones get Jellyfin's newer Live TV page, which has no class of its own
        const liveTv = !!page && (page.classList.contains('liveTvPage') || (!isTv && /^#\/livetv/i.test(window.location.hash)));
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
            // Edits the text in place: on phones the card belongs to React, which keeps hold of its text nodes
            const name = card.querySelector('.cardText-first bdi, .cardText-first a');
            const walker = name && document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
            for (let node = walker && walker.nextNode(); node; node = walker.nextNode()) {
                if (QUALITY_TAG.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(QUALITY_TAG, '').trim();
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

    // Tell the app when the first page is on screen, so the splash can fade into it. On the home screen
    // that waits until the screen is complete - rows filled, pictures on screen loaded, library art swapped
    // and the backdrop in - so it doesn't visibly put itself together after the splash has gone.
    const SETTLE_MAX_MS = 5000;
    // Returns what the first screen is still waiting for, or '' once it's complete
    const firstScreenPending = () => {
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        if (!page) return 'page';
        const onScreen = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
                && r.right > 0 && r.left < window.innerWidth;
        };
        const sections = page.querySelector('.homeSectionsContainer');
        if (sections) {
            const rows = [...sections.querySelectorAll(':scope > .verticalSection:not(.hide)')].filter(onScreen);
            if (!rows.length || rows.some((row) => !row.querySelector('.card'))) return 'rows';
        }
        const images = [...page.querySelectorAll('.cardImageContainer')].filter(onScreen);
        if (images.some((el) => el.classList.contains('lazy') && !el.style.backgroundImage)) return 'images';
        // Jellyfin's newer cards (phones) use img tags, with a blurred preview until the picture is in
        if ([...page.querySelectorAll('.cardImageContainer img')].filter(onScreen).some((img) => !img.complete)) return 'images';
        if (artPending > 0) return 'library art';
        if (phone.pending()) return 'hero';
        if (root.classList.contains('streamix-browse') && !backdrop.settled()) return 'backdrop';
        return '';
    };

    let readyReported = false;
    const reportReady = () => {
        if (readyReported) return;
        readyReported = true;
        const started = Date.now();
        const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => {
            setTimeout(() => window.NativeInterface.onWebAppReady && window.NativeInterface.onWebAppReady(), 150);
        }));
        const check = () => {
            const pending = firstScreenPending();
            const waited = Date.now() - started;
            if (!pending || waited > SETTLE_MAX_MS) {
                // Kept for troubleshooting from DevTools
                window.streamixSplash = { waitedMs: waited, stillPending: pending };
                finish();
            } else {
                setTimeout(check, 100);
            }
        };
        // Rows render a moment after the page is shown
        setTimeout(check, 300);
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

    // ---------------------------------------------------------------------------------------------
    // Phone layout: a tab bar, a hero on the home screen and touch-friendly Live TV (see streamix.css)
    // ---------------------------------------------------------------------------------------------
    const phone = (() => {
        if (isTv) return { update() {}, pending: () => false };

        // Material icons (Apache 2.0)
        const ICONS = {
            home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
            movies: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
            tvshows: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
            livetv: 'M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z',
            music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
            library: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
            search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
            play: 'M8 5v14l11-7z',
            info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z'
        };
        const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.library}"/></svg>`;
        const escapeHtml = (text) => String(text == null ? '' : text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        const api = () => window.ApiClient;
        const signedIn = () => !!(api() && api().getCurrentUserId && api().getCurrentUserId());

        // Tab bar: Home, up to three libraries (movies, shows and Live TV first) and Search
        const LIBRARY_ROUTES = { movies: 'movies', tvshows: 'tv', music: 'music' };
        const LIBRARY_ORDER = ['movies', 'tvshows', 'livetv', 'music', 'boxsets', 'homevideos', 'musicvideos'];
        let bar = null;
        let tabs = [];
        let tabsUser = null;
        let activeKey = 'home';

        const routeFor = (tab) => {
            if (tab.key === 'home') return '#/home';
            if (tab.key === 'search') return '#/search';
            // Straight to the channels when there's no guide (see the Live TV tile above)
            if (tab.type === 'livetv') return '#/livetv?collectionType=livetv' + (liveTvHasGuide ? '' : '&tab=2');
            const route = LIBRARY_ROUTES[tab.type] || 'list';
            return `#/${route}?topParentId=${tab.id}` + (tab.type ? `&collectionType=${tab.type}` : '');
        };

        const pickTabs = (views) => {
            const libraries = [];
            for (const type of LIBRARY_ORDER) {
                const view = views.find((v) => v.type === type && !libraries.includes(v));
                if (view) libraries.push(view);
                if (libraries.length === 3) break;
            }
            return [
                { key: 'home', name: 'Home', icon: 'home' },
                ...libraries.map((v) => ({ key: v.id, id: v.id, type: v.type, name: v.name, icon: ICONS[v.type] ? v.type : 'library' })),
                { key: 'search', name: 'Search', icon: 'search' }
            ];
        };

        // Which tab the page belongs to; null keeps the current one (a title opened from a library stays under it)
        const keyForRoute = () => {
            const hash = window.location.hash || '';
            const path = hash.split('?')[0].toLowerCase();
            if (path === '' || path === '#/' || path.startsWith('#/home')) return 'home';
            if (path.startsWith('#/search')) return 'search';
            if (path.startsWith('#/livetv')) {
                const liveTab = tabs.find((t) => t.type === 'livetv');
                return liveTab ? liveTab.key : null;
            }
            const params = new URLSearchParams(hash.split('?')[1] || '');
            const parent = params.get('topParentId') || params.get('parentId');
            const tab = parent && tabs.find((t) => t.id === parent);
            return tab ? tab.key : null;
        };

        const markActive = () => {
            if (!bar) return;
            bar.querySelectorAll('a[data-tab]').forEach((link) => {
                link.classList.toggle('active', link.getAttribute('data-tab') === activeKey);
            });
            // Live TV's address depends on whether there's a guide, which is only known after a while
            const live = tabs.find((t) => t.type === 'livetv');
            const liveLink = live && bar.querySelector(`a[data-tab="${live.key}"]`);
            if (liveLink) liveLink.setAttribute('href', routeFor(live));
        };

        const renderTabs = () => {
            if (!bar) {
                bar = document.createElement('nav');
                bar.className = 'streamixTabBar';
                bar.addEventListener('click', (e) => {
                    const link = e.target.closest('a[data-tab]');
                    if (!link) return;
                    e.preventDefault();
                    const tab = tabs.find((t) => t.key === link.getAttribute('data-tab'));
                    if (!tab) return;
                    // Tapping the tab you're on takes you back to its top, like iOS
                    if (tab.key === activeKey && keyForRoute() === tab.key) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                        return;
                    }
                    activeKey = tab.key;
                    markActive();
                    window.location.hash = routeFor(tab);
                });
                document.body.appendChild(bar);
            }
            bar.innerHTML = tabs.map((tab) => `<a href="${routeFor(tab)}" data-tab="${escapeHtml(tab.key)}">`
                + `${icon(tab.icon)}<span>${escapeHtml(tab.name)}</span></a>`).join('');
            markActive();
        };

        const loadTabs = () => {
            const userId = api().getCurrentUserId();
            if (tabsUser === userId) return;
            tabsUser = userId;
            const cacheKey = 'streamix-tabs-' + userId;
            // Last session's libraries first, so the bar is there straight away
            try {
                const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
                if (cached) {
                    tabs = pickTabs(cached);
                    renderTabs();
                }
            } catch (e) { /* no storage */ }
            api().getUserViews({}, userId).then((result) => {
                const views = ((result && result.Items) || []).map((v) => ({ id: v.Id, type: v.CollectionType || '', name: v.Name }));
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(views));
                } catch (e) { /* no storage */ }
                tabs = pickTabs(views);
                renderTabs();
            }).catch(() => {
                if (!tabs.length) {
                    tabs = pickTabs([]);
                    renderTabs();
                }
            });
            checkLiveTvGuide();
        };

        // The bar steps aside on sign-in pages, the admin dashboard and while typing (it would ride the keyboard)
        let typing = false;
        const updateBar = () => {
            const route = (window.location.hash || '').toLowerCase();
            const show = signedIn() && !root.classList.contains('streamix-login') && !typing
                && !/^#\/(dashboard|configurationpage|video|wizard)/.test(route);
            root.classList.toggle('streamix-tabbar', show);
            if (!show) return;
            loadTabs();
            const key = keyForRoute();
            if (key) activeKey = key;
            markActive();
        };
        const TYPEABLE_FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, [contenteditable="true"]';
        const checkTyping = () => {
            const active = document.activeElement;
            const nowTyping = !!(active && active.matches && active.matches(TYPEABLE_FIELD));
            if (nowTyping === typing) return;
            typing = nowTyping;
            updateBar();
        };
        document.addEventListener('focusin', checkTyping);
        document.addEventListener('focusout', () => setTimeout(checkTyping, 50));

        // Live TV: tapping a channel starts watching it, like the TV's OK button, instead of opening its
        // info page. Phones show channels on Jellyfin's newer cards (a link with a play button in the corner);
        // the older cards carry data-action="link".
        document.addEventListener('click', (e) => {
            if (!e.target.closest) return;
            const card = e.target.closest('.card[data-type="TvChannel"]');
            const play = card && card.querySelector('button[data-action="play"]');
            if (play && !e.target.closest('button') && e.target.closest('a[href*="details"]')) {
                e.preventDefault();
                e.stopPropagation();
                play.click();
                return;
            }
            const target = e.target.closest('[data-action]');
            if (!target || !target.matches('[data-type="TvChannel"][data-action="link"]')) return;
            target.setAttribute('data-action', 'play');
            if (!target.hasAttribute('data-mediatype')) target.setAttribute('data-mediatype', 'Video');
        }, true);

        // Channel names lose their "(720p)" tags as the grid fills in or turns a page
        let tidyQueued = false;
        new MutationObserver(() => {
            if (tidyQueued || !root.classList.contains('streamix-livetv')) return;
            tidyQueued = true;
            requestAnimationFrame(() => {
                tidyQueued = false;
                tidyChannelCards();
            });
        }).observe(document.body, { childList: true, subtree: true });

        // Home hero: what you were watching, then the newest films and shows, as full-bleed artwork you can
        // swipe through. The buttons are Jellyfin item actions, so Play and Details work like a poster's.
        const HERO_SLIDES = 6;
        // Often enough that Resume shows where you left off after watching something
        const HERO_REFRESH_MS = 2 * 60 * 1000;
        const HERO_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,RunTimeTicks,UserData,SeriesName,'
            + 'ParentIndexNumber,IndexNumber,ParentBackdropItemId,ParentBackdropImageTags,ParentLogoItemId,ParentLogoImageTag';
        let hero = null;
        let heroUser = null;
        let heroLoadedAt = 0;
        let heroSignature = '';

        const backdropOf = (item) => {
            const opts = { type: 'Backdrop', index: 0, maxWidth: 1280, quality: 80 };
            if (item.BackdropImageTags && item.BackdropImageTags.length) {
                return api().getImageUrl(item.Id, { ...opts, tag: item.BackdropImageTags[0] });
            }
            if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
                return api().getImageUrl(item.ParentBackdropItemId, { ...opts, tag: item.ParentBackdropImageTags[0] });
            }
            return null;
        };
        const logoOf = (item) => {
            const opts = { type: 'Logo', maxWidth: 600, quality: 90 };
            if (item.ImageTags && item.ImageTags.Logo) return api().getImageUrl(item.Id, { ...opts, tag: item.ImageTags.Logo });
            if (item.ParentLogoItemId && item.ParentLogoImageTag) {
                return api().getImageUrl(item.ParentLogoItemId, { ...opts, tag: item.ParentLogoImageTag });
            }
            return null;
        };
        const timeLeft = (item) => {
            const position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
            if (!item.RunTimeTicks || !position) return null;
            const minutes = Math.max(1, Math.round((item.RunTimeTicks - position) / 600000000));
            return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
        };

        const slideHtml = (item) => {
            const position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
            const isEpisode = item.Type === 'Episode';
            const title = isEpisode ? item.SeriesName : item.Name;
            const logo = logoOf(item);
            const meta = isEpisode
                ? [item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber} · E${item.IndexNumber}` : null, item.Name]
                : [item.Type === 'Series' ? 'Series' : 'Film', item.ProductionYear, (item.Genres || []).slice(0, 2).join(', '), item.OfficialRating];
            const attrs = `data-id="${item.Id}" data-serverid="${item.ServerId}" data-type="${item.Type}" `
                + `data-mediatype="${item.MediaType || ''}" data-isfolder="${!!item.IsFolder}"`;
            const left = timeLeft(item);
            const percent = left ? Math.min(100, (position / item.RunTimeTicks) * 100) : 0;
            const heading = logo
                ? `<img class="sxHeroLogo" src="${logo}" alt="${escapeHtml(title)}" decoding="async">`
                : `<h2 class="sxHeroTitle">${escapeHtml(title)}</h2>`;
            const progress = left
                ? `<div class="sxHeroProgress"><span class="sxHeroBar"><span style="width:${percent.toFixed(1)}%"></span></span>${escapeHtml(left)}</div>`
                : '';
            return `<div class="sxHeroSlide">
                <img class="sxHeroArt" src="${backdropOf(item)}" alt="" decoding="async">
                <div class="sxHeroInfo">
                    ${heading}
                    <div class="sxHeroMeta">${meta.filter(Boolean).map(escapeHtml).join(' · ')}</div>
                    ${progress}
                    <div class="sxHeroButtons">
                        <button type="button" class="sxHeroPlay itemAction" data-action="${left ? 'resume' : 'play'}" ${attrs} data-positionticks="${position}">${icon('play')}<span>${left ? 'Resume' : 'Play'}</span></button>
                        <button type="button" class="sxHeroMore itemAction" data-action="link" ${attrs} aria-label="Details">${icon('info')}</button>
                    </div>
                </div>
            </div>`;
        };

        const loadHero = async () => {
            const userId = api().getCurrentUserId();
            const [resume, latest] = await Promise.all([
                api().getResumableItems(userId, {
                    Limit: 3, MediaTypes: 'Video', Recursive: true, Fields: HERO_FIELDS, EnableImageTypes: 'Backdrop,Logo,Primary'
                }).catch(() => null),
                api().getItems(userId, {
                    IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending',
                    Limit: 12, ImageTypes: 'Backdrop', Fields: HERO_FIELDS, EnableImageTypes: 'Backdrop,Logo,Primary'
                }).catch(() => null)
            ]);
            const picked = [];
            const seen = new Set();
            for (const item of [...((resume && resume.Items) || []), ...((latest && latest.Items) || [])]) {
                const key = item.SeriesId || item.Id;
                if (seen.has(key) || !backdropOf(item)) continue;
                seen.add(key);
                picked.push(item);
                if (picked.length === HERO_SLIDES) break;
            }
            return picked;
        };

        const updateDots = () => {
            const track = hero && hero.querySelector('.sxHeroTrack');
            if (!track) return;
            const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
            hero.querySelectorAll('.sxHeroDots span').forEach((dot, i) => dot.classList.toggle('active', i === index));
        };

        // The home tab (not Favorites) of the home page on screen, if that's where we are
        const homeTab = () => {
            const tab = document.querySelector('.mainAnimatedPage.homePage:not(.hide) .pageTabContent.is-active');
            return tab && tab.querySelector('.homeSectionsContainer') ? tab : null;
        };

        // One hero element for every visit: an items container, so Jellyfin handles its buttons' play and
        // details actions. Its slides are refilled every so often.
        let heroLoading = false;
        const heroElement = () => {
            if (!hero) {
                hero = document.createElement('div');
                hero.setAttribute('is', 'emby-itemscontainer');
                hero.setAttribute('data-multiselect', 'false');
                hero.className = 'streamixHero';
                // Scroll events don't bubble, but they can be caught on the way down
                hero.addEventListener('scroll', () => requestAnimationFrame(updateDots), { passive: true, capture: true });
            }
            return hero;
        };

        const placeHero = (attempt = 0) => {
            const tab = homeTab();
            if (!tab) {
                // The home page sets up its tab a moment after it's shown
                if (attempt < 12 && document.querySelector('.mainAnimatedPage.homePage:not(.hide)')) {
                    setTimeout(() => placeHero(attempt + 1), 250);
                }
                return;
            }
            const userId = api().getCurrentUserId();
            const fresh = heroUser === userId && Date.now() - heroLoadedAt < HERO_REFRESH_MS;
            if (fresh || heroLoading) {
                if (hero && hero.childElementCount && tab.firstElementChild !== hero) tab.prepend(hero);
                return;
            }
            heroUser = userId;
            heroLoadedAt = Date.now();
            heroLoading = true;
            // Hold the hero's place straight away, so the rows don't jump down when it arrives
            const element = heroElement();
            if (tab.firstElementChild !== element) tab.prepend(element);
            loadHero().then(async (items) => {
                if (!items.length) {
                    element.remove();
                    element.replaceChildren();
                    heroSignature = '';
                    return;
                }
                // Nothing new (same titles, same progress): leave the slides, and where they're swiped to, alone
                const signature = items.map((item) => item.Id + ':' + ((item.UserData && item.UserData.PlaybackPositionTicks) || 0)).join();
                if (signature === heroSignature && element.childElementCount) return;
                heroSignature = signature;
                // The first picture is ready before the hero shows, then each one fades in
                const first = new Image();
                first.src = backdropOf(items[0]);
                await first.decode().catch(() => {});
                element.innerHTML = `<div class="sxHeroTrack">${items.map(slideHtml).join('')}</div>`
                    + (items.length > 1 ? `<div class="sxHeroDots">${items.map(() => '<span></span>').join('')}</div>` : '');
                element.querySelectorAll('.sxHeroArt, .sxHeroLogo').forEach((img) => {
                    if (img.complete) img.classList.add('loaded');
                    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
                });
                const current = homeTab();
                if (current && current.firstElementChild !== element) current.prepend(element);
                updateDots();
            }).catch(() => {
                heroLoadedAt = 0;
            }).finally(() => {
                heroLoading = false;
            });
        };

        return {
            update() {
                updateBar();
                if (root.classList.contains('streamix-tabbar')) placeHero();
            },
            // For the splash: the home screen isn't complete until its hero is in
            pending: () => !!document.querySelector('.mainAnimatedPage.homePage:not(.hide)') && (heroLoading || !heroLoadedAt)
        };
    })();

    const updatePageState = () => {
        updateLoginState();
        updateBrowseState();
        retileLibraries();
        phone.update();
        relabelSettingsMenu();
        setTimeout(relabelSettingsMenu, 300);
    };

    // Libraries open on "Suggestions"; when that's empty, show the full list (Shows / Movies) instead.
    // Live TV opens on "Programs", which is empty without guide data; show the channels then.
    const skipEmptySuggestions = () => {
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
            if (!isTv) return;
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
