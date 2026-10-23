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

    // Colours from the artwork: the picture's strongest hues, measured in OKLab (where equal steps look
    // equal), give the TV its accent, the rims and progress bars, and dark tones of the same hue for the
    // page and its surfaces. A picture with little colour keeps its hue but stays quiet.
    const artColours = (() => {
        const toLinear = (c) => {
            c /= 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const toOklab = (r, g, b) => {
            const lr = toLinear(r);
            const lg = toLinear(g);
            const lb = toLinear(b);
            const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
            const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
            const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
            return [
                0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
            ];
        };
        const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
        const rgbOf = (L, C, h) => {
            const a = C * Math.cos(h * Math.PI / 180);
            const b = C * Math.sin(h * Math.PI / 180);
            const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
            const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
            const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
            return [
                fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
            ];
        };
        // OKLCH to sRGB, giving up chroma (never lightness or hue) until the colour fits the screen
        const rgb = (L, C, h) => {
            let lo = 0;
            let hi = C;
            let out = rgbOf(L, C, h);
            if (out.every((c) => c >= 0 && c <= 1)) return out.map((c) => Math.round(c * 255));
            for (let i = 0; i < 12; i++) {
                const mid = (lo + hi) / 2;
                const test = rgbOf(L, mid, h);
                if (test.every((c) => c >= 0 && c <= 1)) {
                    lo = mid;
                    out = test;
                } else {
                    hi = mid;
                }
            }
            out = rgbOf(L, lo, h);
            return out.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
        };
        const css = (L, C, h, alpha = 1) => {
            const [r, g, b] = rgb(L, C, h);
            return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
        };

        // The picture, shrunk to a few hundred pixels: hues are weighed by how vivid they are (a small bright
        // red outweighs a big dull brown), ignoring near-black, near-white and grey
        const BINS = 24;
        const paletteOf = (img) => {
            const W = 24;
            const H = 14;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            let data;
            try {
                ctx.drawImage(img, 0, 0, W, H);
                data = ctx.getImageData(0, 0, W, H).data;
            } catch (e) {
                return null;
            }
            const weight = new Float64Array(BINS);
            const sumA = new Float64Array(BINS);
            const sumB = new Float64Array(BINS);
            const sumC = new Float64Array(BINS);
            let total = 0;
            for (let i = 0; i < data.length; i += 4) {
                const [L, a, b] = toOklab(data[i], data[i + 1], data[i + 2]);
                const C = Math.hypot(a, b);
                if (L < 0.2 || L > 0.95 || C < 0.025) continue;
                const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
                const bin = Math.floor(hue / (360 / BINS)) % BINS;
                const w = C * C;
                weight[bin] += w;
                sumA[bin] += a * w;
                sumB[bin] += b * w;
                sumC[bin] += C * w;
                total += w;
            }
            if (total < 0.02) return null;
            // Neighbouring bins count towards a peak, so a hue split across a boundary isn't lost
            const score = [...weight].map((w, i) => w + 0.5 * (weight[(i + BINS - 1) % BINS] + weight[(i + 1) % BINS]));
            const order = score.map((v, i) => i).sort((x, y) => score[y] - score[x]);
            const picked = [];
            for (const bin of order) {
                if (!weight[bin] || score[bin] < score[order[0]] * 0.12) break;
                const near = picked.some((other) => Math.min(Math.abs(other - bin), BINS - Math.abs(other - bin)) < 3);
                if (!near) picked.push(bin);
                if (picked.length === 3) break;
            }
            const hues = picked.map((bin) => (Math.atan2(sumB[bin], sumA[bin]) * 180 / Math.PI + 360) % 360);
            const top = picked[0];
            return { hues, chroma: sumC[top] / weight[top], vivid: total / (W * H) };
        };

        // The variables streamix.css is written in (its defaults are the banner's violet). Only ones that colour a
        // few things (the focused control, rims, progress, pills, panels): changing them restyles the page, and
        // posters and text keep fixed colours so it never has to repaint them all.
        const themeOf = (palette) => {
            const h1 = palette.hues[0];
            const h2 = palette.hues.length > 1 ? palette.hues[1] : (h1 + 40) % 360;
            const h3 = palette.hues.length > 2 ? palette.hues[2] : (h1 + 320) % 360;
            // Quiet pictures get quiet colours; vivid ones as much as reads well on a dark page
            const c = Math.min(0.19, Math.max(0.07, palette.chroma * (palette.vivid > 0.004 ? 1.6 : 0.9)));
            return {
                '--sx-accent': css(0.68, c, h1),
                '--sx-accent-2': css(0.8, c * 0.75, h1),
                '--sx-accent-soft': css(0.66, c, h1, 0.26),
                '--sx-glow': `0 8px 24px ${css(0.6, c, h1, 0.45)}`,
                '--sx-rim': `0 0 0 2px ${css(0.8, c * 0.75, h1)}, 0 0 22px ${css(0.6, c, h1, 0.5)}`,
                '--sx-brand': `linear-gradient(135deg, ${css(0.8, c, h2)} 0%, ${css(0.7, c, h1)} 50%, ${css(0.72, c, h3)} 100%)`,
                '--sx-progress': `linear-gradient(90deg, ${css(0.8, c, h2)} 0%, ${css(0.7, c, h1)} 55%, ${css(0.72, c, h3)} 100%)`,
                '--sx-tint': css(0.86, 0.06, h1),
                '--sx-bg': css(0.15, 0.03, h1),
                '--sx-app': css(0.19, 0.04, h1),
                '--sx-surface': css(0.24, 0.05, h1),
                '--sx-on-focus': css(0.18, 0.04, h1)
            };
        };
        // The page colour and the picture's own wash, for drawing into the backdrop
        const shadeOf = (palette) => {
            const h1 = palette ? palette.hues[0] : 290;
            return { bg: rgb(0.15, 0.03, h1), wash: palette ? rgb(0.32, 0.07, h1) : rgb(0.3, 0.07, 290) };
        };
        // A phone's page: 1.6's two glows (top left, bottom right) over a dark base, in the picture's tones
        const ambientOf = (palette) => {
            const h1 = palette.hues[0];
            const h2 = palette.hues.length > 1 ? palette.hues[1] : (h1 + 40) % 360;
            const c = Math.min(0.16, Math.max(0.06, palette.chroma * 1.4));
            return `radial-gradient(90% 45% at 15% 0%, ${css(0.43, c, h1, 0.34)} 0%, ${css(0.43, c, h1, 0)} 66%), `
                + `radial-gradient(90% 45% at 90% 100%, ${css(0.4, c * 0.9, h2, 0.26)} 0%, ${css(0.4, c * 0.9, h2, 0)} 66%), `
                + `linear-gradient(180deg, ${css(0.19, 0.04, h1)} 0%, ${css(0.15, 0.03, h1)} 60%)`;
        };
        return { paletteOf, themeOf, shadeOf, ambientOf };
    })();

    // Backdrops: while browsing, the focused title's artwork fills the background, and a title's page sits
    // on its own artwork. Waits for focus to settle, decodes off the main thread, then cross-fades two
    // layers on the GPU. On a TV the artwork is blurred, once, into a small canvas that's stretched to the
    // screen (a CSS blur would be redone by the GPU on every frame of every animation), with the picture's
    // colour wash and the shade that keeps text readable drawn into the same canvas: one full-screen layer,
    // and the colours cross-fade with the picture. The page's colours are set from the same picture.
    const backdrop = (() => {
        const SETTLE_MS = 350;
        const BLUR = isTv;
        const BACKDROP_WIDTH = BLUR ? 480 : 1280;
        const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
        const gradient = (ctx, x1, y1, stops, colour) => {
            const g = ctx.createLinearGradient(0, 0, x1, y1);
            stops.forEach(([at, alpha]) => g.addColorStop(at, rgba(colour, alpha)));
            return g;
        };
        // detail: a title's page (darker on the left for its text); otherwise browsing (the picture shows top
        // right, fading into the page colour behind the rows)
        const blurred = (img, palette, detail) => {
            const canvas = document.createElement('canvas');
            const width = 320;
            const height = Math.round(width * (img.naturalHeight || 9) / (img.naturalWidth || 16));
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return img;
            ctx.filter = 'blur(7px)';
            // Drawn a little oversize, so the blur doesn't fade out towards the edges
            ctx.drawImage(img, -14, -14, width + 28, height + 28);
            ctx.filter = 'none';
            const { bg, wash } = artColours.shadeOf(palette);
            ctx.fillStyle = rgba(wash, detail ? 0.3 : 0.36);
            ctx.fillRect(0, 0, width, height);
            if (detail) {
                ctx.fillStyle = gradient(ctx, 0, height, [[0, 0.2], [0.5, 0.35], [1, 0.96]], bg);
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = gradient(ctx, width, 0, [[0, 0.86], [0.55, 0.6], [1, 0.42]], bg);
            } else {
                ctx.fillStyle = gradient(ctx, width, 0, [[0, 0.7], [0.75, 0.15], [1, 0.15]], bg);
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = gradient(ctx, 0, height, [[0, 0.2], [0.5, 0.62], [0.92, 1], [1, 1]], bg);
            }
            ctx.fillRect(0, 0, width, height);
            return canvas;
        };
        const cache = new Map();
        // The last few pictures, decoded, and their colours: going from a title on Home to its page redraws
        // the same picture with the page's shade, without fetching it again
        const pictures = new Map();
        const remember = (url, entry) => {
            pictures.delete(url);
            pictures.set(url, entry);
            if (pictures.size > 4) pictures.delete(pictures.keys().next().value);
        };
        let root = null;
        let layers = [];
        let front = 0;
        let shownKey = null;
        let timer = null;
        let requested = null;
        let settled = false;
        let palette = null;
        let heroPalette = null;
        let waiting = false;
        let themeKey = '';
        let themed = false;

        // Which colours the page wears: none (the stylesheet's banner colours) when it isn't themed; on a phone's
        // Home, the hero slide on screen; otherwise the backdrop picture. undefined keeps what's on screen: a
        // phone waiting for a title's picture, or a picture with no colour to give, holds the current colours.
        const wanted = () => {
            const html = document.documentElement;
            if (!themed) return null;
            if (isTv) return palette;
            if (html.classList.contains('sx-home')) return heroPalette || undefined;
            if (waiting) return undefined;
            return palette || undefined;
        };

        // The page's colours: the picture's on pages with artwork, the banner's (the stylesheet) elsewhere
        const applyTheme = () => {
            const html = document.documentElement;
            const colours = wanted();
            if (colours === undefined) return;
            const vars = colours ? artColours.themeOf(colours) : null;
            const key = vars ? JSON.stringify(vars) : '';
            if (key === themeKey) return;
            const old = themeKey ? Object.keys(JSON.parse(themeKey)) : [];
            themeKey = key;
            if (vars) Object.entries(vars).forEach(([name, value]) => html.style.setProperty(name, value));
            else old.forEach((name) => html.style.removeProperty(name));
            html.classList.toggle('sx-themed', !!vars);
        };

        // Phones: Home's page colour, cross-faded between two layers as the hero moves on (the backdrop itself
        // stays hidden while browsing on a phone). streamix.css shows it on a themed Home only.
        let ambient = null;
        let ambientLayers = [];
        let ambientFront = 0;
        let ambientKey = '';
        const showAmbient = (colours) => {
            if (isTv || !colours) return;
            const container = document.querySelector('.backgroundContainer');
            if (!container) return;
            if (!ambient || ambient.parentElement !== container) {
                ambient = document.createElement('div');
                ambient.id = 'streamixAmbient';
                ambientLayers = [document.createElement('div'), document.createElement('div')];
                ambientLayers.forEach((layer) => {
                    layer.className = 'saLayer';
                    ambient.appendChild(layer);
                });
                container.prepend(ambient);
                ambientKey = '';
            }
            const background = artColours.ambientOf(colours);
            if (background === ambientKey) return;
            ambientKey = background;
            const back = 1 - ambientFront;
            ambientLayers[back].style.background = background;
            ambientLayers[back].classList.add('active');
            ambientLayers[ambientFront].classList.remove('active');
            ambientFront = back;
        };

        // Phones: each layer carries its own shade (1.6's title-page shade, in the picture's dark tone), so the
        // picture and its shade fade in together
        const shaded = (img, colours) => {
            const { bg } = artColours.shadeOf(colours);
            const tone = (alpha) => `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${alpha})`;
            const shade = document.createElement('div');
            shade.className = 'sbShade';
            shade.style.background = `linear-gradient(180deg, ${tone(0.55)} 0%, ${tone(0.82)} 40%, ${tone(0.95)} 100%)`;
            return [img.cloneNode(false), shade];
        };

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
            shownKey = null;
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
                    url = pick && libraryArtUrl(pick, BACKDROP_WIDTH);
                    cache.set(id, url);
                    return url;
                }
                const item = await api.getItem(api.getCurrentUserId(), id);
                const opts = { type: 'Backdrop', maxWidth: BACKDROP_WIDTH, quality: 72 };
                if (item.BackdropImageTags && item.BackdropImageTags.length) {
                    url = api.getImageUrl(item.Id, { ...opts, index: 0, tag: item.BackdropImageTags[0] });
                } else if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
                    url = api.getImageUrl(item.ParentBackdropItemId, { ...opts, index: 0, tag: item.ParentBackdropImageTags[0] });
                } else if (item.IsFolder) {
                    const pick = await pickFromLibrary(item.Id);
                    url = pick && libraryArtUrl(pick, BACKDROP_WIDTH);
                }
            } catch (e) {
                url = null;
            }
            cache.set(id, url);
            return url;
        };

        const show = async (url) => {
            const detail = document.documentElement.classList.contains('streamix-detail');
            const key = url && `${url}|${detail}`;
            if (!url || key === shownKey || !ensureRoot()) {
                settled = true;
                if (waiting) {
                    waiting = false;
                    applyTheme();
                }
                return;
            }
            requested = key;
            let entry = pictures.get(url);
            if (!entry) {
                const img = new Image();
                img.decoding = 'async';
                img.alt = '';
                img.src = url;
                try {
                    await img.decode();
                } catch (e) {
                    if (requested === key) waiting = false;
                    return;
                }
                entry = { img, palette: artColours.paletteOf(img) };
            }
            if (requested !== key) return; // focus moved on while this was loading
            remember(url, entry);
            const back = 1 - front;
            if (BLUR) layers[back].replaceChildren(blurred(entry.img, entry.palette, detail));
            else layers[back].replaceChildren(...shaded(entry.img, entry.palette));
            layers[back].classList.add('active');
            layers[front].classList.remove('active');
            const old = layers[front];
            setTimeout(() => {
                if (!old.classList.contains('active')) old.replaceChildren();
            }, 900);
            front = back;
            shownKey = key;
            settled = true;
            // The page takes the picture's colours as it fades in
            palette = entry.palette;
            waiting = false;
            applyTheme();
        };

        return {
            focus(card) {
                clearTimeout(timer);
                timer = setTimeout(async () => show(await urlFor(card.getAttribute('data-id'), card.getAttribute('data-type'))), SETTLE_MS);
            },
            async item(id) {
                clearTimeout(timer);
                // Until this title's picture is in, a phone keeps the colours it has
                waiting = true;
                show(await urlFor(id, null));
            },
            url(url) {
                clearTimeout(timer);
                show(url);
            },
            refresh() {
                ensureRoot();
            },
            // Pages with a backdrop wear its colours; others (settings, Live TV) the banner's
            theme(on) {
                themed = on;
                applyTheme();
            },
            // Phones: the colours of the hero slide on screen, for Home
            useHeroColours(colours) {
                if (!colours) return;
                heroPalette = colours;
                showAmbient(colours);
                applyTheme();
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

    // sx-tabs: the header has a row of tabs (a library's Suggestions, Genres...), which Jellyfin fills in and
    // clears as pages change
    let tabsHeader = null;
    const watchHeaderTabs = () => {
        const header = document.querySelector('.skinHeader');
        if (!header || header === tabsHeader) return;
        tabsHeader = header;
        const check = () => root.classList.toggle('sx-tabs', !!header.querySelector('.headerTabs .emby-tab-button'));
        new MutationObserver(check).observe(header, { childList: true, subtree: true });
        check();
    };

    // Backdrops belong to pages with posters (home, libraries, search results), not settings or details
    const updateBrowseState = () => {
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        const detail = !!page && page.classList.contains('itemDetailPage');
        // Phones get Jellyfin's newer Live TV page, which has no class of its own
        const liveTv = !!page && (page.classList.contains('liveTvPage') || (!isTv && /^#\/livetv/i.test(window.location.hash)));
        // Home always counts: its featured title has artwork before any poster row is in (or focused)
        const browsing = !!page && !detail && !liveTv && (page.classList.contains('homePage') || !!page.querySelector('.card[data-id]'));
        root.classList.toggle('streamix-browse', browsing);
        root.classList.toggle('streamix-detail', detail);
        root.classList.toggle('streamix-livetv', liveTv);
        // For streamix.css, in place of :has() rules on the whole page (which restyle everything on any change)
        root.classList.toggle('sx-home', !!page && page.classList.contains('homePage'));
        watchHeaderTabs();
        if (browsing || detail) backdrop.refresh();
        // TVs wear the colours of the artwork behind any page with posters; phones of Home's hero and a title's page
        backdrop.theme(isTv ? browsing || detail : detail || (!!page && page.classList.contains('homePage')));
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
        // Phones never show a poster's backdrop (the hero carries the artwork), so they don't load one
        if (isTv && root.classList.contains('streamix-browse')) backdrop.focus(card);
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
        if (phone.pending() || featured.pending()) return 'hero';
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
        relabel('.lnkDisplayPreferences', 'Display & Language');
        relabel('.lnkHomePreferences', 'Home Screen');
        relabel('.lnkPlaybackPreferences', 'Audio & Playback');
        relabel('.clientSettings', 'Streamix Settings');
        relabel('.selectServer', 'Switch Server');
        // Each section's rows form one panel (see streamix.css): mark where each panel starts and ends
        page.querySelectorAll('.verticalSection').forEach((section) => {
            const rows = [...section.querySelectorAll(':scope > a.listItem-border')];
            const shown = rows.filter((row) => row.offsetParent !== null);
            rows.forEach((row) => {
                row.classList.toggle('sxFirst', row === shown[0]);
                row.classList.toggle('sxLast', row === shown[shown.length - 1]);
            });
        });
    };

    // TV: the top bar stays on screen and gets a shade under it once the page has scrolled (see "Navigation,
    // part 1" in streamix.css). Checked once a frame at most; the class only changes when crossing the top.
    if (isTv) {
        let scrollQueued = false;
        window.addEventListener('scroll', () => {
            if (scrollQueued) return;
            scrollQueued = true;
            requestAnimationFrame(() => {
                scrollQueued = false;
                const scrolled = window.scrollY > 8;
                if (scrolled !== root.classList.contains('sx-scrolled')) root.classList.toggle('sx-scrolled', scrolled);
            });
        }, { passive: true });
    }

    // Response on press (TV): OK marks the focused element for as long as it's held, so it answers the
    // moment the button goes down rather than when something opens (see "Feel" in streamix.css)
    if (isTv) {
        let pressed = null;
        const release = () => {
            if (pressed) pressed.classList.remove('sx-pressed');
            pressed = null;
        };
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.repeat) return;
            const target = document.activeElement;
            if (!target || target === document.body || !target.matches('.card, button, .emby-button, .sxRailItem')) return;
            release();
            pressed = target;
            target.classList.add('sx-pressed');
        }, true);
        window.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') release();
        }, true);
        document.addEventListener('focusout', release, true);
    }

    // Material icons (Apache 2.0), for the phone's tab bar and the TV's navigation rail
    const ICONS = {
        home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
        movies: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
        tvshows: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
        livetv: 'M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z',
        music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
        library: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
        search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
        settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        play: 'M8 5v14l11-7z',
        menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
        favorite: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
        add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
        check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
        expand: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
        star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
        info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z'
    };
    const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.library}"/></svg>`;
    const escapeHtml = (text) => String(text == null ? '' : text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const api = () => window.ApiClient;
    const signedIn = () => !!(api() && api().getCurrentUserId && api().getCurrentUserId());

    // A user's libraries, last session's first so menus can show straight away, then the server's
    const loadViews = (userId, onViews) => {
        const cacheKey = 'streamix-tabs-' + userId;
        try {
            const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (cached) onViews(cached, true);
        } catch (e) { /* no storage */ }
        return api().getUserViews({}, userId).then((result) => {
            const views = ((result && result.Items) || []).map((v) => ({ id: v.Id, type: v.CollectionType || '', name: v.Name }));
            try {
                localStorage.setItem(cacheKey, JSON.stringify(views));
            } catch (e) { /* no storage */ }
            onViews(views, false);
        });
    };

    // What to feature at the top of the home screen (the phone's swipeable hero, the TV's hero and its
    // carousel): what you were watching, then the newest films and shows that have artwork
    const HERO_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,UserData,SeriesName,SeriesId,'
        + 'ParentIndexNumber,IndexNumber,ParentBackdropItemId,ParentBackdropImageTags,ParentLogoItemId,ParentLogoImageTag,'
        + 'ParentThumbItemId,ParentThumbImageTag';
    const backdropOf = (item, maxWidth = 1280) => {
        const opts = { type: 'Backdrop', index: 0, maxWidth, quality: 80 };
        if (item.BackdropImageTags && item.BackdropImageTags.length) {
            return api().getImageUrl(item.Id, { ...opts, tag: item.BackdropImageTags[0] });
        }
        if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
            return api().getImageUrl(item.ParentBackdropItemId, { ...opts, tag: item.ParentBackdropImageTags[0] });
        }
        return null;
    };
    // A wide picture for a small card: the title's thumb (it usually carries the title's logo), else its backdrop
    const thumbOf = (item) => {
        const opts = { type: 'Thumb', maxWidth: 480, quality: 85 };
        if (item.ImageTags && item.ImageTags.Thumb) return api().getImageUrl(item.Id, { ...opts, tag: item.ImageTags.Thumb });
        if (item.ParentThumbItemId && item.ParentThumbImageTag) {
            return api().getImageUrl(item.ParentThumbItemId, { ...opts, tag: item.ParentThumbImageTag });
        }
        return backdropOf(item, 480);
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
    const loadFeatured = async (limit) => {
        const userId = api().getCurrentUserId();
        const images = 'Backdrop,Logo,Primary,Thumb';
        const [resume, latest] = await Promise.all([
            api().getResumableItems(userId, {
                Limit: 4, MediaTypes: 'Video', Recursive: true, Fields: HERO_FIELDS, EnableImageTypes: images
            }).catch(() => null),
            api().getItems(userId, {
                IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending',
                Limit: limit + 6, ImageTypes: 'Backdrop', Fields: HERO_FIELDS, EnableImageTypes: images
            }).catch(() => null)
        ]);
        const picked = [];
        const seen = new Set();
        for (const item of [...((resume && resume.Items) || []), ...((latest && latest.Items) || [])]) {
            const key = item.SeriesId || item.Id;
            if (seen.has(key) || !backdropOf(item)) continue;
            seen.add(key);
            picked.push(item);
            if (picked.length === limit) break;
        }
        return picked;
    };
    // The home tab (not Favorites) of the home page on screen, if that's where we are
    const homeTab = () => {
        const tab = document.querySelector('.mainAnimatedPage.homePage:not(.hide) .pageTabContent.is-active');
        return tab && tab.querySelector('.homeSectionsContainer') ? tab : null;
    };

    // ---------------------------------------------------------------------------------------------
    // Phone layout: a tab bar, a hero on the home screen and touch-friendly Live TV (see streamix.css)
    // ---------------------------------------------------------------------------------------------
    const phone = (() => {
        if (isTv) return { update() {}, pending: () => false };

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
            // Last session's libraries first, so the bar is there straight away
            loadViews(userId, (views) => {
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
        let hero = null;
        let heroUser = null;
        let heroLoadedAt = 0;
        let heroSignature = '';

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

        const loadHero = () => loadFeatured(HERO_SLIDES);

        const updateDots = () => {
            const track = hero && hero.querySelector('.sxHeroTrack');
            if (!track) return;
            const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
            hero.querySelectorAll('.sxHeroDots span').forEach((dot, i) => dot.classList.toggle('active', i === index));
        };

        // Home's colours come from the slide on screen, once a swipe has settled (fast swipes only count where they
        // stop). Each slide's colours are worked out once, from its picture, which is already loaded.
        const slideColours = new Map();
        let settleTimer = null;
        const slideIndex = (track) => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        const colourFromSlide = () => {
            const track = hero && hero.querySelector('.sxHeroTrack');
            if (!track || !track.isConnected) return;
            const index = slideIndex(track);
            const slide = track.children[index];
            const art = slide && slide.querySelector('.sxHeroArt');
            const play = slide && slide.querySelector('.sxHeroPlay');
            const id = play && play.getAttribute('data-id');
            if (!art || !id) return;
            if (slideColours.has(id)) {
                backdrop.useHeroColours(slideColours.get(id));
                return;
            }
            const measure = () => {
                const colours = artColours.paletteOf(art);
                slideColours.set(id, colours);
                if (slideIndex(track) === index) backdrop.useHeroColours(colours);
            };
            if (art.complete && art.naturalWidth) measure();
            else art.addEventListener('load', measure, { once: true });
        };
        const settleSoon = () => {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(colourFromSlide, 150);
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
                hero.addEventListener('scroll', () => {
                    requestAnimationFrame(updateDots);
                    settleSoon();
                }, { passive: true, capture: true });
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
                // Back on Home: its colours come from the slide still on screen
                if (hero && hero.childElementCount) colourFromSlide();
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
                if (signature === heroSignature && element.childElementCount) {
                    colourFromSlide();
                    return;
                }
                heroSignature = signature;
                slideColours.clear();
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
                colourFromSlide();
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

    // ---------------------------------------------------------------------------------------------
    // TV navigation (see "Navigation" in streamix.css):
    //  - a top bar inside Jellyfin's header: menu, logo, a pill per section (Home and each library), a
    //    search field and the profile. Ordinary buttons, so Jellyfin's focus navigation reaches them (▲).
    //  - a slim sidebar of icons down the left edge (Home, Search, Favorites, Live TV, Settings) that opens
    //    out with labels when the remote moves into it: ◀ from the first thing on a row, Back on a
    //    top-level page, or the menu button. Its buttons stay out of Jellyfin's focus navigation
    //    (tabindex -1); while it's open this handles the remote itself.
    // ---------------------------------------------------------------------------------------------
    const rail = (() => {
        if (!isTv) return { update() {}, onBack: () => false };

        const LIBRARY_ROUTES = { movies: 'movies', tvshows: 'tv', music: 'music' };
        // Pages the navigation leads to: Back on one of them opens the sidebar rather than leaving it
        const TOP_LEVEL = /^#\/(home|movies|tv|music|livetv|search|mypreferencesmenu|list|homevideos|musicvideos|books)(\.html)?$/;
        let nav = null;
        let bar = null;
        let views = [];
        let sideItems = [];
        let viewsUser = null;
        let profileUser = null;
        let sideKey = 'home';
        let topKey = 'home';
        let open = false;
        let shown = false;
        let returnFocus = null;

        const viewRoute = (view) => {
            // Straight to the channels when there's no guide (see the Live TV tile above)
            if (view.type === 'livetv') return '#/livetv?collectionType=livetv' + (liveTvHasGuide ? '' : '&tab=2');
            try {
                const url = window.Emby && window.Emby.Page && window.Emby.Page.getRouteUrl({
                    Id: view.id, Name: view.name, Type: 'CollectionFolder', CollectionType: view.type || undefined,
                    IsFolder: true, ServerId: api().serverId()
                }, {});
                if (url) return url.startsWith('#') ? url : '#' + url.replace(/^.*?#/, '');
            } catch (e) { /* older web client */ }
            const route = LIBRARY_ROUTES[view.type] || 'list';
            return `#/${route}?topParentId=${view.id}` + (view.type ? `&collectionType=${view.type}` : '');
        };

        const parts = () => {
            const hash = window.location.hash || '';
            return { path: hash.split('?')[0].toLowerCase(), params: new URLSearchParams(hash.split('?')[1] || '') };
        };

        // The library the page belongs to, or null (a title opened from a library stays under it)
        const viewForRoute = () => {
            const { path, params } = parts();
            if (path.startsWith('#/livetv')) return views.find((v) => v.type === 'livetv') || null;
            const parent = params.get('topParentId') || params.get('parentId');
            return (parent && views.find((v) => v.id === parent)) || null;
        };

        const isHome = () => {
            const { path } = parts();
            return path === '' || path === '#/' || path.startsWith('#/home');
        };

        // Which top-bar pill and which sidebar icon the page belongs to; null keeps the current one
        const keysForRoute = () => {
            const { path, params } = parts();
            if (isHome()) {
                // Switching Home's tabs doesn't always change the address: the tab on screen decides
                const tab = document.querySelector('.skinHeader .headerTabs .emby-tab-button-active');
                const favourites = tab ? tab.getAttribute('data-index') === '1' : params.get('tab') === '1';
                return { top: 'home', side: favourites ? 'favorites' : 'home' };
            }
            if (path.startsWith('#/search')) return { top: null, side: 'search' };
            if (path.startsWith('#/mypreferences')) return { top: null, side: 'settings' };
            const view = viewForRoute();
            if (view) return { top: view.id, side: view.type === 'livetv' ? 'livetv' : null };
            return { top: null, side: null };
        };

        const isTopLevel = () => {
            const { path, params } = parts();
            if (!TOP_LEVEL.test(path)) return false;
            // A plain list is top level only when it's a whole library
            if (path.startsWith('#/list')) {
                const parent = params.get('topParentId') || params.get('parentId');
                return !!parent && views.some((v) => v.id === parent);
            }
            return true;
        };

        const dialogOpen = () => !!document.querySelector('.dialogContainer');

        const sideButtons = () => (nav ? [...nav.querySelectorAll('.sxRailItem')] : []);

        const markActive = () => {
            const mark = (button, active) => {
                button.classList.toggle('active', active);
                if (active) button.setAttribute('aria-current', 'page');
                else button.removeAttribute('aria-current');
            };
            sideButtons().forEach((button) => mark(button, button.getAttribute('data-key') === sideKey));
            if (bar) bar.querySelectorAll('.sxPill').forEach((pill) => mark(pill, pill.getAttribute('data-key') === topKey));
        };

        // --- Sidebar --------------------------------------------------------------------------------
        const renderSide = () => {
            if (!nav) {
                nav = document.createElement('nav');
                nav.className = 'sxRail';
                nav.setAttribute('aria-label', 'Main menu');
                document.body.appendChild(nav);
                nav.addEventListener('click', (e) => {
                    const button = e.target.closest && e.target.closest('.sxRailItem');
                    if (button) goSide(button.getAttribute('data-key'));
                });
            }
            const live = views.find((v) => v.type === 'livetv');
            sideItems = [
                { key: 'home', name: 'Home', icon: 'home', route: '#/home' },
                { key: 'search', name: 'Search', icon: 'search', route: '#/search' },
                { key: 'favorites', name: 'Favourites', icon: 'favorite', route: '#/home?tab=1' },
                ...(live ? [{ key: 'livetv', name: live.name, icon: 'livetv', view: live }] : []),
                { key: 'settings', name: 'Settings', icon: 'settings', route: '#/mypreferencesmenu' }
            ];
            nav.innerHTML = '<div class="sxRailPanel"></div><div class="sxRailItems">'
                + sideItems.map((item) => `<button type="button" class="sxRailItem" tabindex="-1" data-key="${escapeHtml(item.key)}">`
                    + `${icon(item.icon)}<span>${escapeHtml(item.name)}</span></button>`).join('')
                + '</div>';
            markActive();
        };

        const visible = (el) => !!el && el.isConnected && el.offsetParent !== null;

        const openRail = () => {
            if (open || !shown || !nav) return;
            const active = document.activeElement;
            returnFocus = active && active !== document.body ? active : null;
            open = true;
            root.classList.add('sx-rail-open');
            const target = sideButtons().find((b) => b.getAttribute('data-key') === sideKey) || sideButtons()[0];
            if (target) target.focus({ preventScroll: true });
        };

        const closeRail = (restoreFocus) => {
            if (!open) return;
            open = false;
            root.classList.remove('sx-rail-open');
            if (!restoreFocus) return;
            if (visible(returnFocus)) {
                returnFocus.focus();
            } else {
                if (document.activeElement && nav && nav.contains(document.activeElement)) document.activeElement.blur();
                focusContent();
            }
        };

        const navigate = (route) => {
            returnFocus = null;
            // The page loses focus with the menu; the new page's focus comes from its own autofocus / focusContent
            const active = document.activeElement;
            if (active && ((nav && nav.contains(active)) || (bar && bar.contains(active)))) active.blur();
            window.location.hash = route;
        };

        // Home and Favourites are two tabs of one page: when it's on screen, switch tabs in place
        const homeTabInPlace = (index) => {
            if (!isHome()) return false;
            const tab = document.querySelector(`.skinHeader .headerTabs .emby-tab-button[data-index="${index}"]`);
            if (!tab) return false;
            const active = document.activeElement;
            if (active && ((nav && nav.contains(active)) || (bar && bar.contains(active)))) active.blur();
            tab.click();
            setTimeout(focusContent, 300);
            return true;
        };

        const goSide = (key) => {
            const item = sideItems.find((i) => i.key === key);
            if (!item) return;
            const here = keysForRoute().side === key && isTopLevel();
            closeRail(here);
            if (here) return;
            sideKey = key;
            markActive();
            if ((key === 'home' || key === 'favorites') && homeTabInPlace(key === 'favorites' ? 1 : 0)) return;
            navigate(item.view ? viewRoute(item.view) : item.route);
        };

        // --- Top bar --------------------------------------------------------------------------------
        const ensureBar = () => {
            const header = document.querySelector('.skinHeader');
            if (!header) return null;
            if (bar && bar.parentElement === header) return bar;
            bar = document.createElement('div');
            bar.className = 'sxTopBar';
            bar.innerHTML = `<button type="button" class="sxTopIcon sxMenuButton" aria-label="Menu">${icon('menu')}</button>`
                + '<div class="sxTopLogo" role="img" aria-label="Streamix"></div>'
                + '<div class="sxPills" role="navigation" aria-label="Sections"></div>'
                + `<button type="button" class="sxSearchField" aria-label="Search films and shows">${icon('search')}<span>Search</span></button>`
                + `<button type="button" class="sxProfile" aria-label="Profile and settings"><span class="sxAvatar"></span>`
                + `<span class="sxProfileName"></span>${icon('expand')}</button>`;
            header.insertBefore(bar, header.firstChild);
            bar.addEventListener('click', (e) => {
                const target = e.target.closest && e.target.closest('button');
                if (!target) return;
                if (target.classList.contains('sxMenuButton')) {
                    openRail();
                } else if (target.classList.contains('sxSearchField')) {
                    if (!parts().path.startsWith('#/search')) navigate('#/search');
                } else if (target.classList.contains('sxProfile')) {
                    if (!parts().path.startsWith('#/mypreferencesmenu')) navigate('#/mypreferencesmenu');
                } else if (target.classList.contains('sxPill')) {
                    const key = target.getAttribute('data-key');
                    if (key === topKey && isTopLevel() && keysForRoute().side !== 'favorites') return;
                    topKey = key;
                    markActive();
                    const view = views.find((v) => v.id === key);
                    if (!view && homeTabInPlace(0)) {
                        sideKey = 'home';
                        markActive();
                        return;
                    }
                    navigate(view ? viewRoute(view) : '#/home');
                }
            });
            renderPills();
            profileUser = null;
            return bar;
        };

        const renderPills = () => {
            if (!bar) return;
            // Live TV has its place in the sidebar; the pills are for browsing
            bar.querySelector('.sxPills').innerHTML = [{ id: 'home', name: 'Home' }, ...views.filter((v) => v.type !== 'livetv')]
                .map((v) => `<button type="button" class="sxPill" data-key="${escapeHtml(v.id)}">${escapeHtml(v.name)}</button>`).join('');
            markActive();
        };

        const renderProfile = () => {
            const userId = api().getCurrentUserId();
            if (!bar || profileUser === userId) return;
            profileUser = userId;
            api().getCurrentUser().then((user) => {
                if (!user || !bar) return;
                bar.querySelector('.sxProfileName').textContent = user.Name || '';
                const avatar = bar.querySelector('.sxAvatar');
                if (user.PrimaryImageTag && api().getUserImageUrl) {
                    avatar.style.backgroundImage = `url("${api().getUserImageUrl(user.Id, { type: 'Primary', tag: user.PrimaryImageTag, height: 72 })}")`;
                    avatar.textContent = '';
                } else {
                    avatar.style.backgroundImage = '';
                    avatar.textContent = (user.Name || '?').trim().charAt(0).toUpperCase();
                }
            }).catch(() => {
                profileUser = null;
            });
        };

        const loadNav = () => {
            const userId = api().getCurrentUserId();
            if (viewsUser === userId) return;
            viewsUser = userId;
            loadViews(userId, (list) => {
                views = list;
                renderSide();
                renderPills();
            }).catch(() => {
                if (!nav) renderSide();
            });
            checkLiveTvGuide();
        };

        // --- Remote ---------------------------------------------------------------------------------
        const typing = (el) => !!el && !!el.matches && el.matches('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable="true"]');

        window.addEventListener('keydown', (e) => {
            if (!shown || !nav) return;
            if (open) {
                const list = sideButtons();
                const index = list.indexOf(document.activeElement);
                switch (e.key) {
                    case 'ArrowUp':
                    case 'ArrowDown': {
                        const next = list[Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + (e.key === 'ArrowUp' ? -1 : 1)))];
                        if (next) next.focus({ preventScroll: true });
                        break;
                    }
                    case 'ArrowRight':
                        closeRail(true);
                        break;
                    case 'Enter':
                        if (index >= 0) goSide(list[index].getAttribute('data-key'));
                        break;
                    case 'ArrowLeft':
                        break;
                    default:
                        return;
                }
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            // Left with nowhere further left to go (the first thing on a row or in a grid) opens the sidebar
            if (e.key !== 'ArrowLeft' || e.repeat) return;
            const before = document.activeElement;
            if (typing(before) || dialogOpen()) return;
            // Jellyfin moves focus within this same key press, so by the next task we know whether it went anywhere.
            // Its spatial navigation can also take ◀ from the first poster of a row up into the bar above (the
            // tabs start on the same edge); ◀ never leaves a row upwards, so that counts as nowhere further left.
            setTimeout(() => {
                if (open || !shown || dialogOpen()) return;
                const now = document.activeElement;
                const intoBar = before && before !== document.body && !(before.closest && before.closest('.skinHeader'))
                    && now && now.closest && now.closest('.skinHeader');
                if (intoBar) before.focus();
                if (intoBar || now === before) openRail();
            }, 0);
        }, true);

        // Focus that leaves the sidebar some other way (a dialog, a page change) closes it
        document.addEventListener('focusin', (e) => {
            if (open && nav && !nav.contains(e.target)) closeRail(false);
        });

        const update = () => {
            const page = document.querySelector('.mainAnimatedPage:not(.hide)');
            const route = (window.location.hash || '').toLowerCase();
            const show = signedIn() && !!page && !root.classList.contains('streamix-login')
                && !page.classList.contains('itemDetailPage')
                && !/^#\/(video|nowplaying|queue|dashboard|configurationpage|wizard)/.test(route);
            if (show !== shown) {
                shown = show;
                root.classList.toggle('sx-rail', show);
                if (!show) closeRail(false);
            }
            if (!show) return;
            ensureBar();
            loadNav();
            renderProfile();
            // A page with no entry of its own (a library, say) lights up nothing in the sidebar
            const keys = keysForRoute();
            sideKey = keys.side;
            topKey = keys.top;
            markActive();
        };

        return {
            update,
            // Back on a top-level page opens the sidebar; Back with it open goes Home, and on Home leaves the app
            onBack() {
                if (!shown || dialogOpen()) return false;
                if (open) {
                    if (isHome() && keysForRoute().side === 'home') return false;
                    closeRail(false);
                    navigate('#/home');
                    return true;
                }
                if (isTopLevel()) {
                    openRail();
                    return open;
                }
                return false;
            }
        };
    })();

    window.StreamixShell = { onBack: () => rail.onBack() };

    // ---------------------------------------------------------------------------------------------
    // TV home: a featured title at the top - title, badges, story, Play / More info / Favourite on the left,
    // its artwork on the right - over a carousel of what you were watching and what's new. Moving along the
    // carousel features that title. Built as a Jellyfin items container, so Play, Resume and More info are
    // Jellyfin's own item actions (see "Featured" in streamix.css).
    // ---------------------------------------------------------------------------------------------
    const featured = (() => {
        if (!isTv) return { update() {}, pending: () => false, focusTarget: () => null };
        const COUNT = 10;
        // Often enough that Resume shows where you left off after watching something
        const REFRESH_MS = 60 * 1000;
        let element = null;
        let items = [];
        let current = -1;
        let user = null;
        let loadedAt = 0;
        let loading = false;
        let signature = '';
        let front = 0;
        let artRequest = null;
        const favourites = new Map();
        // Moving along the carousel moves the focus and the track straight away; the hero (its text, artwork
        // and the page's colours) follows once the remote rests, so holding ▶ never queues up work
        const HERO_SETTLE_MS = 160;
        let heroTimer = null;
        let shown = -1;
        // The carousel's geometry, measured once (the cards are all one size)
        let slot = 0;
        let maxX = 0;
        // Whether a title needs two lines, measured on a canvas rather than by reading the heading's height
        let measure = null;
        let titleWidth = 0;
        window.addEventListener('resize', () => {
            slot = 0;
            titleWidth = 0;
            measure = null;
        });

        const ticksToRuntime = (ticks) => {
            const minutes = Math.round((ticks || 0) / 600000000);
            if (!minutes) return null;
            return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
        };
        const isEpisode = (item) => item.Type === 'Episode';
        const titleOf = (item) => (isEpisode(item) ? item.SeriesName || item.Name : item.Name);
        // Favourites and More info act on the show when the featured title is an episode of it
        const ownerOf = (item) => (isEpisode(item) && item.SeriesId
            ? { id: item.SeriesId, type: 'Series', isFolder: true }
            : { id: item.Id, type: item.Type, isFolder: !!item.IsFolder });
        const attrsFor = (item, owner) => `data-id="${owner ? owner.id : item.Id}" data-serverid="${item.ServerId}" `
            + `data-type="${owner ? owner.type : item.Type}" data-mediatype="${owner ? '' : item.MediaType || ''}" `
            + `data-isfolder="${owner ? owner.isFolder : !!item.IsFolder}"`;

        const build = () => {
            element = document.createElement('div');
            element.setAttribute('is', 'emby-itemscontainer');
            element.setAttribute('data-multiselect', 'false');
            element.className = 'sxFeatured';
            // Jellyfin centres whatever gets focus on a TV, which would push the title off the top as the remote
            // reaches the carousel. Its scroller leaves "custom" containers alone; this block scrolls itself.
            element.setAttribute('data-scroll-mode-x', 'custom');
            element.setAttribute('data-scroll-mode-y', 'custom');
            element.innerHTML = `<div class="sxFeatHero">
                    <div class="sxFeatInfo" aria-live="polite">
                        <h1 class="sxFeatTitle"></h1>
                        <div class="sxFeatBadges"></div>
                        <div class="sxFeatMeta"></div>
                        <div class="sxFeatProgress"></div>
                        <p class="sxFeatOverview"></p>
                        <div class="sxFeatButtons focuscontainer-x">
                            <button type="button" class="sxFeatPlay itemAction" data-action="play">${icon('play')}<span>Play</span></button>
                            <button type="button" class="sxFeatIcon sxFeatMore itemAction" data-action="link" aria-label="More info">${icon('info')}</button>
                            <button type="button" class="sxFeatIcon sxFeatFav" aria-label="Add to Favourites">${icon('add')}</button>
                            <span class="sxFeatHint" aria-hidden="true"></span>
                        </div>
                    </div>
                    <div class="sxFeatArt"><div class="sxFeatLayer"></div><div class="sxFeatLayer"></div></div>
                </div>
                <div class="sxFeatRow focuscontainer-x"><div class="sxFeatTrack"></div></div>`;
            element.addEventListener('focusin', (e) => {
                // The featured block reads best whole: coming back up to it shows it from the top
                if (document.scrollingElement && document.scrollingElement.scrollTop > 0) {
                    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
                }
                const from = e.relatedTarget;
                // Coming into the carousel from above or below lands on the featured card, not merely the nearest
                const card = e.target.closest && e.target.closest('.sxFeatCard');
                if (card) {
                    const row = element.querySelector('.sxFeatRow');
                    const selected = current >= 0 ? row.querySelectorAll('.sxFeatCard')[current] : null;
                    if (selected && selected !== card && !(from && row.contains(from))) {
                        selected.focus();
                        return;
                    }
                    // Moving along the carousel features the title the remote is on
                    select(Number(card.getAttribute('data-index')));
                    scrollTo(card);
                    return;
                }
                // ...and coming up to the buttons lands on Play
                const buttons = e.target.closest && e.target.closest('.sxFeatButtons');
                const play = buttons && buttons.querySelector('.sxFeatPlay');
                if (play && e.target !== play && !(from && buttons.contains(from))) play.focus();
            });
            element.querySelector('.sxFeatFav').addEventListener('click', toggleFavourite);
            // The focused round button's name shows beside the buttons
            const buttons = element.querySelector('.sxFeatButtons');
            buttons.addEventListener('focusin', showHint);
            buttons.addEventListener('focusout', (e) => {
                if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.sxFeatIcon'))) {
                    element.querySelector('.sxFeatHint').classList.remove('on');
                }
            });
            return element;
        };

        // The carousel keeps the card the remote is on in its second slot, so the next one is always in view.
        // The row clips rather than scrolls, and the track moves with a transform.
        const scrollTo = (card) => {
            const track = element.querySelector('.sxFeatTrack');
            if (!slot) {
                const row = element.querySelector('.sxFeatRow');
                const first = track.firstElementChild;
                slot = first ? first.offsetWidth + parseFloat(getComputedStyle(track).columnGap || '0') : 0;
                maxX = Math.max(0, track.scrollWidth - row.clientWidth);
            }
            const index = Number(card.getAttribute('data-index'));
            const x = Math.min(maxX, Math.max(0, (index - 1) * slot));
            track.style.transform = `translateX(${-x}px)`;
            // Cards moved past the left edge fade out rather than leaving a sliver in the margin
            const firstShown = slot ? Math.round(x / slot) : 0;
            track.querySelectorAll('.sxFeatCard').forEach((other, i) => other.classList.toggle('sxPast', i < firstShown));
        };

        const isLong = (title, text) => {
            if (!measure) {
                const style = getComputedStyle(title);
                measure = document.createElement('canvas').getContext('2d');
                measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                if ('letterSpacing' in measure) measure.letterSpacing = style.letterSpacing;
            }
            if (!titleWidth) titleWidth = title.clientWidth;
            return measure.measureText(text).width > titleWidth;
        };

        function showHint() {
            const hint = element.querySelector('.sxFeatHint');
            const active = document.activeElement;
            const button = active && active.closest && active.closest('.sxFeatIcon');
            if (!button || !element.contains(button)) return;
            hint.textContent = button.getAttribute('aria-label');
            hint.classList.add('on');
        }

        const renderFavourite = (item) => {
            const owner = ownerOf(item);
            const button = element.querySelector('.sxFeatFav');
            const known = favourites.get(owner.id);
            const on = known != null ? known : !isEpisode(item) && !!(item.UserData && item.UserData.IsFavorite);
            button.innerHTML = icon(on ? 'check' : 'add');
            button.setAttribute('aria-label', on ? 'In Favourites' : 'Add to Favourites');
            button.classList.toggle('on', on);
            showHint();
        };

        const loadFavourite = (item) => {
            const owner = ownerOf(item);
            if (favourites.has(owner.id)) return;
            if (owner.id === item.Id) {
                favourites.set(owner.id, !!(item.UserData && item.UserData.IsFavorite));
                return;
            }
            api().getItem(api().getCurrentUserId(), owner.id).then((show) => {
                favourites.set(owner.id, !!(show && show.UserData && show.UserData.IsFavorite));
                if (items[current] === item) renderFavourite(item);
            }).catch(() => {});
        };

        function toggleFavourite() {
            const item = items[current];
            if (!item) return;
            const owner = ownerOf(item);
            const next = !favourites.get(owner.id);
            api().updateFavoriteStatus(api().getCurrentUserId(), owner.id, next).then((data) => {
                favourites.set(owner.id, data && data.IsFavorite != null ? !!data.IsFavorite : next);
                if (items[current] === item) renderFavourite(item);
            }).catch(() => {});
        }

        // The artwork cross-fades once the new picture is decoded; the text changes straight away
        const showArt = (item) => {
            // The frame is 452 CSS px wide: 904 screen pixels on a 1080p TV
            const url = backdropOf(item, 960);
            const layers = element.querySelectorAll('.sxFeatLayer');
            artRequest = url;
            const img = new Image();
            img.decoding = 'async';
            img.alt = '';
            img.src = url;
            img.decode().catch(() => {}).then(() => {
                if (artRequest !== url) return;
                const back = 1 - front;
                layers[back].replaceChildren(img);
                layers[back].classList.add('active');
                layers[front].classList.remove('active');
                front = back;
            });
            // The page's own background follows, blurred
            backdrop.url(backdropOf(item, 480));
        };

        function select(index, now = false) {
            const item = items[index];
            if (!item || index === current) return;
            const cards = element.querySelectorAll('.sxFeatCard');
            if (cards[current]) cards[current].classList.remove('selected');
            if (cards[index]) cards[index].classList.add('selected');
            current = index;
            clearTimeout(heroTimer);
            if (now) showHero(index);
            else heroTimer = setTimeout(() => showHero(current), HERO_SETTLE_MS);
        }

        function showHero(index) {
            const item = items[index];
            if (!item || index === shown) return;
            shown = index;
            const info = element.querySelector('.sxFeatInfo');
            const position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
            const left = timeLeft(item);
            const title = info.querySelector('.sxFeatTitle');
            // A title that wraps to two lines leaves room for two lines of story, so the hero keeps its height
            info.classList.toggle('sxFeatLong', isLong(title, titleOf(item)));
            title.textContent = titleOf(item);
            const badges = [];
            if (item.OfficialRating) badges.push(`<span class="sxBadge sxBadgeRating">${escapeHtml(item.OfficialRating)}</span>`);
            (item.Genres || []).slice(0, 2).forEach((genre) => badges.push(`<span class="sxBadge">${escapeHtml(genre)}</span>`));
            info.querySelector('.sxFeatBadges').innerHTML = badges.join('');
            const meta = isEpisode(item)
                ? [item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber} · E${item.IndexNumber}` : null, item.Name]
                : [item.Type === 'Series' ? 'Series' : 'Film', item.ProductionYear, ticksToRuntime(item.RunTimeTicks)];
            const rating = item.CommunityRating ? `<span class="sxFeatStar">${icon('star')}${item.CommunityRating.toFixed(1)}</span>` : '';
            info.querySelector('.sxFeatMeta').innerHTML = meta.filter(Boolean).map((m) => `<span>${escapeHtml(m)}</span>`).join('') + rating;
            const percent = left ? Math.min(100, (position / item.RunTimeTicks) * 100) : 0;
            info.querySelector('.sxFeatProgress').innerHTML = left
                ? `<span class="sxFeatBar"><span style="width:${percent.toFixed(1)}%"></span></span>${escapeHtml(left)}`
                : '';
            info.querySelector('.sxFeatOverview').textContent = item.Overview || '';
            const play = info.querySelector('.sxFeatPlay');
            const playAttrs = { 'data-action': left ? 'resume' : 'play', 'data-id': item.Id, 'data-serverid': item.ServerId,
                'data-type': item.Type, 'data-mediatype': item.MediaType || '', 'data-isfolder': String(!!item.IsFolder),
                'data-positionticks': String(position) };
            Object.entries(playAttrs).forEach(([name, value]) => play.setAttribute(name, value));
            play.querySelector('span').textContent = left ? 'Resume' : 'Play';
            const owner = ownerOf(item);
            const more = info.querySelector('.sxFeatMore');
            Object.entries({ 'data-id': owner.id, 'data-serverid': item.ServerId, 'data-type': owner.type,
                'data-isfolder': String(owner.isFolder) }).forEach(([name, value]) => more.setAttribute(name, value));
            loadFavourite(item);
            renderFavourite(item);
            // A short settle-in for the new title (skipped with reduced motion, see streamix.css). Switching
            // between two copies of the keyframes restarts it without making the browser lay out the page.
            info.classList.add('sxFeatSwap');
            info.classList.toggle('sxFeatAlt');
            showArt(item);
        }

        const cardHtml = (item, index) => `<button type="button" class="sxFeatCard itemAction" data-action="link" data-index="${index}" `
            + `${attrsFor(item, ownerOf(item))} aria-label="${escapeHtml(titleOf(item))}">`
            + `<img src="${thumbOf(item)}" alt="" decoding="async" loading="lazy">`
            + `<span class="sxFeatCardTitle">${escapeHtml(titleOf(item))}</span></button>`;

        const render = (list) => {
            const keep = items[current] && list.findIndex((i) => i.Id === items[current].Id);
            items = list;
            current = -1;
            shown = -1;
            slot = 0;
            clearTimeout(heroTimer);
            const track = element.querySelector('.sxFeatTrack');
            track.innerHTML = list.map(cardHtml).join('');
            track.style.transform = '';
            track.querySelectorAll('img').forEach((img) => {
                if (img.complete) img.classList.add('loaded');
                else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
            });
            element.classList.add('ready');
            select(keep > 0 ? keep : 0, true);
        };

        // Lands on Play once the featured title is in, unless the remote has already moved
        const claimFocus = () => {
            const active = document.activeElement;
            if (movedSinceShown || (active && element.contains(active))) return;
            if (active && active.closest && active.closest('.sxRail')) return;
            const play = element.querySelector('.sxFeatPlay');
            if (play && play.offsetParent !== null) play.focus();
        };

        const place = (attempt = 0) => {
            const tab = homeTab();
            if (!tab) {
                // The home page sets up its tab a moment after it's shown
                if (attempt < 12 && document.querySelector('.mainAnimatedPage.homePage:not(.hide)')) {
                    setTimeout(() => place(attempt + 1), 250);
                }
                return;
            }
            if (!element) build();
            if (tab.firstElementChild !== element) tab.prepend(element);
            const userId = api().getCurrentUserId();
            const fresh = user === userId && Date.now() - loadedAt < REFRESH_MS;
            if (fresh || loading) {
                if (items.length) setTimeout(claimFocus, 0);
                return;
            }
            if (user !== userId) {
                favourites.clear();
                signature = '';
            }
            user = userId;
            loadedAt = Date.now();
            loading = true;
            loadFeatured(COUNT).then(async (list) => {
                if (!list.length) {
                    element.remove();
                    signature = '';
                    return;
                }
                // Nothing new (same titles, same progress): leave the carousel and where it's scrolled to alone
                const next = list.map((item) => item.Id + ':' + ((item.UserData && item.UserData.PlaybackPositionTicks) || 0)).join();
                if (next !== signature || !items.length) {
                    signature = next;
                    // The first picture is ready before the hero shows
                    const first = new Image();
                    first.src = backdropOf(list[0], 960);
                    await first.decode().catch(() => {});
                    render(list);
                }
                claimFocus();
            }).catch(() => {
                loadedAt = 0;
            }).finally(() => {
                loading = false;
            });
        };

        return {
            update: place,
            // For the splash: the home screen isn't complete until its featured title is in
            pending: () => !!document.querySelector('.mainAnimatedPage.homePage:not(.hide)') && (loading || !loadedAt),
            focusTarget: () => (element && element.isConnected ? element.querySelector('.sxFeatPlay') : null)
        };
    })();

    // ---------------------------------------------------------------------------------------------
    // TV posters: "Continue Watching" and "Next Up" come as wide thumbnails; on a TV every row is posters.
    // The card swaps to Jellyfin's portrait shape, and to the film's poster or (for an episode) its show's.
    // ---------------------------------------------------------------------------------------------
    const posters = (() => {
        if (!isTv) return { update() {} };
        const POSTER_TYPES = /^(Movie|Episode|Series|Video|MusicVideo|Season)$/;
        const seriesOf = new Map();
        const imageId = (url) => {
            const match = /\/Items\/([0-9a-f]{32})\/Images\//i.exec(url || '');
            return match ? match[1] : null;
        };
        // The item whose poster stands for this card: a film's own, an episode's show
        const posterItem = async (card, url) => {
            const id = card.getAttribute('data-id');
            const fromUrl = imageId(url);
            if (card.getAttribute('data-type') !== 'Episode') return id;
            // Episodes show their series' thumb by default, so the picture already names the show
            if (fromUrl && fromUrl !== id) return fromUrl;
            if (!seriesOf.has(id)) {
                seriesOf.set(id, api().getItem(api().getCurrentUserId(), id).then((item) => item.SeriesId || id).catch(() => id));
            }
            return seriesOf.get(id);
        };

        const convert = (card) => {
            card.setAttribute('data-sx-poster', '1');
            const image = card.querySelector('.cardImageContainer');
            const padder = card.querySelector('.cardPadder-overflowBackdrop');
            if (!image || !padder) return;
            const current = image.getAttribute('data-src') || (/url\("?([^")]+)"?\)/.exec(image.style.backgroundImage || '') || [])[1];
            card.classList.replace('overflowBackdropCard', 'overflowPortraitCard');
            padder.classList.replace('cardPadder-overflowBackdrop', 'cardPadder-overflowPortrait');
            // The wide picture would be cropped to a sliver in the meantime (and Jellyfin's lazy loader would
            // still put it in): the card shows its loading shimmer until the poster is ready
            image.removeAttribute('data-src');
            image.style.backgroundImage = '';
            image.classList.add('sxPosterPending');
            posterItem(card, current).then((id) => {
                const url = api().getImageUrl(id, { type: 'Primary', fillHeight: 480, fillWidth: 320, quality: 90 });
                const img = new Image();
                img.decoding = 'async';
                img.src = url;
                return img.decode().catch(() => {}).then(() => {
                    image.style.backgroundImage = `url("${url}")`;
                    image.classList.remove('sxPosterPending');
                });
            }).catch(() => image.classList.remove('sxPosterPending'));
        };

        let queued = false;
        const update = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                document.querySelectorAll('.mainAnimatedPage:not(.itemDetailPage) .card.overflowBackdropCard:not([data-sx-poster])').forEach((card) => {
                    if (POSTER_TYPES.test(card.getAttribute('data-type') || '')) convert(card);
                });
            });
        };
        // Rows fill in after the page is shown, and refill after playback
        new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
        return { update };
    })();

    const updatePageState = () => {
        updateLoginState();
        updateBrowseState();
        retileLibraries();
        phone.update();
        rail.update();
        featured.update();
        posters.update();
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
        // The top bar is a place the remote goes on purpose (▲); only a page that opened with focus there moves it
        const inTopBar = !movedSinceShown && active && active.closest && active.closest('.skinHeader');
        const onToolbar = !movedSinceShown && active && active.closest
            && active.closest('.alphaPicker, .pageTabContent > .flex:first-child, .libraryPage > .flex:first-child');
        if (!inTopBar && !onToolbar && active && active !== document.body) return;
        const page = document.querySelector('.mainAnimatedPage:not(.hide)');
        // On pages with tabs, the visible tab: hidden tabs keep their cards in the page
        const scope = page && (page.querySelector('.pageTabContent.is-active') || page);
        const visible = (el) => el.offsetParent !== null;
        const target = scope && ([...scope.querySelectorAll('.sxFeatPlay, .btnPlay:not(.hide), .btnResume:not(.hide)')].find(visible)
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
