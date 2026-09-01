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
