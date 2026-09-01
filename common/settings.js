/**
 * Shared settings model for Change Colors.
 *
 * Every setting lives in chrome.storage.local (Manifest V3 service workers have
 * no localStorage). Colors are stored as 6 hex digits without a leading '#',
 * which is the format the Manifest V2 version used, so migrated data keeps
 * working as-is.
 */

export const DEFAULTS = {
    OverridenDomains: [],
    OverridenPages: [],
    NotOverridenDomains: [],
    NotOverridenPages: [],
    OverrideAll: false,
    CustomFonts: [],
    DefaultBrowserFont: true,
    DefaultBrowserColor: false,
    text_color: 'E8E8E8',
    background_color: '080808',
    links_color: '2E79DB',
    visited_links_color: '9B51DB',
    FontSize: '0',
    ShowImage: true,
    ShowFlash: true,
    OverrideFontName: 'Arial'
};

export function getSettings() {
    return chrome.storage.local.get(DEFAULTS);
}

export function saveSettings(patch) {
    return chrome.storage.local.set(patch);
}

export async function toggleListEntry(listName, value) {
    const settings = await getSettings();
    const list = settings[listName].slice();
    const index = list.indexOf(value);
    if (index === -1) {
        list.push(value);
    } else {
        list.splice(index, 1);
    }
    await saveSettings({[listName]: list});
}

export async function toggleFlag(flagName) {
    const settings = await getSettings();
    await saveSettings({[flagName]: !settings[flagName]});
}

/** Pages we are allowed to (and want to) restyle. */
export function isSupportedUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));
}

export function extractDomain(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        return '';
    }
}

/**
 * Resolves the override rules for one URL.
 * `active` follows the Manifest V2 semantics: a global override applies unless
 * the page or domain is on an exclusion list, and a per-page or per-domain
 * override always wins.
 */
export function getOverrideState(settings, url) {
    const domain = extractDomain(url);
    const state = {
        url: url,
        domain: domain,
        OverridenPages: settings.OverridenPages.includes(url),
        OverridenDomains: settings.OverridenDomains.includes(domain),
        NotOverridenPages: settings.NotOverridenPages.includes(url),
        NotOverridenDomains: settings.NotOverridenDomains.includes(domain),
        OverrideAll: Boolean(settings.OverrideAll)
    };
    state.active = (state.OverrideAll && !(state.NotOverridenPages || state.NotOverridenDomains)) ||
        state.OverridenPages || state.OverridenDomains;
    return state;
}

/**
 * Selectors that must stay transparent so playing media remains visible.
 *
 * Forcing an opaque background on every element also paints the overlays a
 * video player stacks on top of its <video> (thumbnails, gradients, end
 * screens), which is what turned videos into a black rectangle. Clearing the
 * background of the player container chain - up to four levels above the
 * <video> - and of everything inside it lets the video show through again,
 * while the rest of the page keeps its solid background.
 */
function mediaGuardSelectors() {
    const selectors = ['video', 'audio'];
    let path = '> video';
    for (let depth = 0; depth < 4; depth++) {
        selectors.push('*:has(' + path + ')', '*:has(' + path + ') *');
        path = '> *' + ' ' + path;
    }
    return selectors.map(function (selector) {
        return 'html > body ' + selector;
    }).join(',');
}

/**
 * Quotes a font family name for CSS. Settings saved by older versions already
 * contain the surrounding single quotes, so they are stripped first.
 */
export function cssFontFamily(name) {
    const clean = String(name || 'Arial').trim().replace(/^['"]|['"]$/g, '').replace(/["\\;{}]/g, '');
    return '"' + clean + '", sans-serif';
}

export function buildCss(settings) {
    const backgroundColor = '#' + settings.background_color;
    const textColor = '#' + settings.text_color;
    const linksColor = '#' + settings.links_color;
    const visitedLinksColor = '#' + settings.visited_links_color;
    const fontFamily = cssFontFamily(settings.OverrideFontName);
    const fontSize = parseInt(settings.FontSize, 10) || 0;

    let css = '';

    if (!settings.DefaultBrowserColor) {
        css += 'html > body, html > body * {' +
            'background-color: ' + backgroundColor + ' !important;' +
            'color: ' + textColor + ' !important;' +
            'text-shadow: none !important;' +
            '-webkit-text-fill-color: currentcolor !important;}' +
            'html > body a:link, html > body a:link *,' +
            'html > body a:link:hover, html > body a:link:hover *,' +
            'html > body a:link:active, html > body a:link:active * {' +
            'color: ' + linksColor + ' !important;}' +
            'html > body a:visited, html > body a:visited *,' +
            'html > body a:visited:hover, html > body a:visited:hover *,' +
            'html > body a:visited:active, html > body a:visited:active * {' +
            'color: ' + visitedLinksColor + ' !important;}' +
            mediaGuardSelectors() + '{background-color: transparent !important;}';
    }

    if (!settings.DefaultBrowserFont) {
        css += 'html > body, html > body * {' +
            'line-height: normal !important;' +
            'font-family: ' + fontFamily + ' !important;' +
            (fontSize !== 0 ? 'font-size: ' + fontSize + 'pt !important;' : '') +
            '}';
    }

    if (!settings.ShowImage) {
        // Hiding images covers CSS backgrounds too, otherwise hero banners and
        // other decorative images would survive as element backgrounds.
        // Clickable elements keep theirs, because that is often the only thing
        // marking a button or an icon.
        css += 'html > body img { display: none !important; }' +
            'html > body, html > body *:not([onclick]):not(:link):not(:visited) {' +
            'background-image: none !important;}';
    }

    if (!settings.ShowFlash) {
        css += 'html > body object, html > body embed { display: none !important; }';
    }

    return css;
}
