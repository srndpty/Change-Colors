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

/**
 * Settings are read, changed and written back, and nothing about
 * chrome.storage.local makes that one step. Two of them overlapping lose one
 * of the two changes: both read the same lists, both write their own, and the
 * second write is the whole list, not the difference. That is not hypothetical
 * for a toggle - the popup and the keyboard shortcut change the same lists, and
 * two presses of the same button are two of these.
 *
 * So every change goes through one chain, one at a time, and reads the settings
 * *inside* it rather than being handed them. What that chain cannot cover on
 * its own is a second context: a chain lives in the page that made it, and the
 * popup is a page of its own. The popup therefore asks the service worker to
 * make the change (see `requestOverrideChange`), so that every change to the
 * override lists is made on the worker's chain. `updateSettings` is what that
 * chain is.
 */
let changes = Promise.resolve();

/**
 * Runs `change` with the settings as they are once everything queued before it
 * has been written, and saves whatever patch it returns. Returning nothing
 * saves nothing.
 */
export function updateSettings(change) {
    const done = changes.then(function () {
        return null;
    }, function () {
        return null;
    }).then(async function () {
        const settings = await getSettings();
        const patch = change(settings);
        if (patch) {
            await saveSettings(patch);
        }
        return patch;
    });
    // The chain must not be broken by a change that threw, and must not carry
    // its rejection to whoever queues next.
    changes = done.catch(function () {});
    return done;
}

function withEntry(list, value, present) {
    const has = list.includes(value);
    if (has === present) {
        return list;
    }
    return present
        ? list.concat([value])
        : list.filter(function (entry) {
            return entry !== value;
        });
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
 * What a scope says: true if it is set to override, false if it is set not to,
 * null if it says nothing and the scope under it decides.
 *
 * A scope listed both ways is a contradiction no button can produce any more -
 * the ones below take a page off one list as they put it on the other - but
 * settings saved by older versions can hold one. It is read as "do not
 * override", the side that leaves the page as its author wrote it, and the
 * next press of that scope's button resolves it for good.
 */
function scopeSetting(on, off) {
    if (off) {
        return false;
    }
    return on ? true : null;
}

/**
 * Resolves the override rules for one URL.
 *
 * The page decides; failing that the domain; failing that the global setting.
 * The narrower scope wins because that is what the buttons offering it say they
 * do - "no override on this page", while the global override is on, has to
 * actually mean it. (Manifest V2 let any inclusion beat any exclusion, so a
 * page turned on individually stayed on afterwards no matter what was pressed.)
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
    state.page = scopeSetting(state.OverridenPages, state.NotOverridenPages);
    state.domainSetting = scopeSetting(state.OverridenDomains, state.NotOverridenDomains);
    // What each scope's button is offering to change: what this domain does
    // where nothing is said about the page, and what this page does in the end.
    state.domainActive = state.domainSetting === null
        ? state.OverrideAll
        : state.domainSetting;
    state.active = state.page === null ? state.domainActive : state.page;
    return state;
}

/**
 * The lists as they should be once a scope is set to `want`, given what the
 * scopes under it already do.
 *
 * A scope is only listed while it disagrees with what it would get anyway: a
 * page set to what its domain does is taken off both page lists, so that later
 * changing the domain takes the page with it. And a scope is never on both
 * lists, which is what makes the button that reads the state and the button
 * that changes it agree.
 */
function overridePatch(state, scope, want) {
    if (scope === 'all') {
        return {OverrideAll: want};
    }
    if (scope === 'domain') {
        const explicit = want !== state.OverrideAll;
        return {
            OverridenDomains: withEntry(state.domains.on, state.domain, explicit && want),
            NotOverridenDomains: withEntry(state.domains.off, state.domain, explicit && !want)
        };
    }
    const explicit = want !== state.domainActive;
    return {
        OverridenPages: withEntry(state.pages.on, state.url, explicit && want),
        NotOverridenPages: withEntry(state.pages.off, state.url, explicit && !want)
    };
}

/** The scopes a change can name. Anything else is not a change we know. */
const SCOPES = ['page', 'domain', 'all'];

export function isScope(scope) {
    return SCOPES.includes(scope);
}

function stateWithLists(settings, url) {
    const state = getOverrideState(settings, url);
    state.pages = {on: settings.OverridenPages, off: settings.NotOverridenPages};
    state.domains = {on: settings.OverridenDomains, off: settings.NotOverridenDomains};
    return state;
}

/**
 * Sets one scope of one URL to `active`: the page, the domain, or everything.
 *
 * Saying what the answer should be, rather than "change it", is what makes this
 * safe to do twice. A message to the service worker that fails is not proof
 * that nothing happened - the worker can save the settings and be stopped
 * before its answer gets out - so the popup has to be able to repeat itself
 * without undoing what went through.
 */
export function setOverride(scope, url, active) {
    if (!isScope(scope)) {
        return Promise.reject(new Error('unknown scope: ' + scope));
    }
    return updateSettings(function (settings) {
        return overridePatch(stateWithLists(settings, url), scope, Boolean(active));
    });
}

/** What one scope of one URL gets as things stand. */
export function overrideOf(state, scope) {
    if (scope === 'all') {
        return state.OverrideAll;
    }
    return scope === 'domain' ? state.domainActive : state.active;
}

/**
 * Turns one scope of one URL around. The keyboard shortcuts are this: there is
 * nothing on screen for them to agree with, so what they mean is "the other
 * one". They run in the service worker, where reading and writing are one step,
 * so nothing can come between the reading and the writing.
 *
 * The popup does not use this. Its buttons say which way they are going -
 * "remove the override on this page" - and send that, so that a message it has
 * to repeat says the same thing the second time.
 */
export function toggleOverride(scope, url) {
    if (!isScope(scope)) {
        return Promise.reject(new Error('unknown scope: ' + scope));
    }
    return updateSettings(function (settings) {
        const state = stateWithLists(settings, url);
        return overridePatch(state, scope, !overrideOf(state, scope));
    });
}

/**
 * Asks the service worker to make the change, so that changes from the popup
 * and changes from a keyboard shortcut are made one at a time on the same
 * chain.
 *
 * If the worker does not answer the change is made here instead. That is only
 * safe because what is sent is the answer and not a change: a worker stopped
 * between saving and answering has already done exactly what this then does
 * again, and doing it again changes nothing.
 */
export async function requestOverrideChange(scope, url, active) {
    try {
        const answer = await chrome.runtime.sendMessage({
            action: 'setOverride',
            scope: scope,
            url: url,
            active: Boolean(active)
        });
        if (answer && answer.ok) {
            return;
        }
    } catch (e) {
        // Service worker did not answer, which says nothing about whether it
        // did the work.
    }
    await setOverride(scope, url, active);
}
