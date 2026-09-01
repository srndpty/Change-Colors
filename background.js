/**
 * Change Colors - Manifest V3 service worker.
 *
 * Styling is applied with chrome.scripting.insertCSS instead of a content
 * script: the CSS can then be injected while the document commits, which keeps
 * the "no flash of the original page" behaviour of the Manifest V2 version
 * without shipping a script into every frame of every site.
 *
 * The service worker is not persistent, so the stylesheet currently injected in
 * a tab is remembered in chrome.storage.session (needed to remove exactly that
 * stylesheet later) rather than in a module variable.
 */

import {
    getSettings,
    buildCss,
    getOverrideState,
    isSupportedUrl,
    needsBackgroundMarker,
    toggleFlag,
    toggleListEntry
} from './common/settings.js';

const ICON_ON = 'icons/colors_icons.png';
const ICON_OFF = 'icons/colors_icons_grey.png';
const INJECTED_PREFIX = 'injected:';

function injectedKey(tabId) {
    return INJECTED_PREFIX + tabId;
}

async function getInjectedCss(tabId) {
    const stored = await chrome.storage.session.get(injectedKey(tabId));
    return stored[injectedKey(tabId)] || null;
}

function rememberInjectedCss(tabId, css) {
    if (css) {
        return chrome.storage.session.set({[injectedKey(tabId)]: css});
    }
    return chrome.storage.session.remove(injectedKey(tabId));
}

async function insertCss(tabId, css, frameId) {
    const target = frameId === undefined ?
        {tabId: tabId, allFrames: true} :
        {tabId: tabId, frameIds: [frameId]};
    try {
        await chrome.scripting.insertCSS({target: target, css: css});
    } catch (e) {
        // The frame can be gone already, or be a page we may not touch.
    }
}

async function removeCss(tabId, css) {
    try {
        await chrome.scripting.removeCSS({target: {tabId: tabId, allFrames: true}, css: css});
    } catch (e) {
        // Nothing to remove - the document was replaced in the meantime.
    }
}

/**
 * marker.js tags the elements carrying a background image so the stylesheet can
 * keep the content drawn on top of them transparent. It is only needed while the
 * colors are overridden and images are shown.
 */
async function startMarker(tabId, frameId) {
    const target = frameId === undefined ?
        {tabId: tabId, allFrames: true} :
        {tabId: tabId, frameIds: [frameId]};
    try {
        await chrome.scripting.executeScript({target: target, files: ['marker.js']});
    } catch (e) {
        // Frame gone, or a document we may not script.
    }
}

async function stopMarker(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: {tabId: tabId, allFrames: true},
            func: function () {
                if (window.__changeColorsMarker) {
                    window.__changeColorsMarker.stop();
                }
            }
        });
    } catch (e) {
        // Nothing to stop.
    }
}

async function setIcon(tabId, active) {
    try {
        await chrome.action.setIcon({tabId: tabId, path: active ? ICON_ON : ICON_OFF});
        await chrome.action.setTitle({
            tabId: tabId,
            title: active ? 'Change Colors (override active)' : 'Change Colors'
        });
    } catch (e) {
        // Tab closed while we were working on it.
    }
}

/**
 * Brings a tab in line with the current settings.
 * `freshFrameId` is set when a document (or sub frame) has just committed: the
 * old stylesheet went away with the old document, so it only needs injecting.
 */
async function syncTab(tabId, url, freshFrameId) {
    if (!isSupportedUrl(url)) {
        await setIcon(tabId, false);
        return;
    }

    const settings = await getSettings();
    const state = getOverrideState(settings, url);
    const wantedCss = state.active ? buildCss(settings) : null;
    const wantsMarker = state.active && needsBackgroundMarker(settings);
    await setIcon(tabId, state.active);

    if (freshFrameId !== undefined) {
        if (wantedCss) {
            await insertCss(tabId, wantedCss, freshFrameId);
        }
        if (wantsMarker) {
            await startMarker(tabId, freshFrameId);
        }
        if (freshFrameId === 0) {
            await rememberInjectedCss(tabId, wantedCss);
        }
        return;
    }

    const injectedCss = await getInjectedCss(tabId);
    if (injectedCss === wantedCss) {
        return;
    }
    if (injectedCss) {
        await removeCss(tabId, injectedCss);
    }
    if (wantedCss) {
        await insertCss(tabId, wantedCss);
    }
    if (wantsMarker) {
        await startMarker(tabId);
    } else {
        await stopMarker(tabId);
    }
    await rememberInjectedCss(tabId, wantedCss);
}

async function syncAllTabs() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(function (tab) {
        return syncTab(tab.id, tab.url);
    }));
}

async function syncActiveTab(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        await syncTab(tab.id, tab.url);
    } catch (e) {
        // Tab is gone.
    }
}

chrome.webNavigation.onCommitted.addListener(async function (details) {
    if (details.frameId === 0) {
        await syncTab(details.tabId, details.url, 0);
        return;
    }
    // Sub frames inherit the decision taken for the top level document.
    const injectedCss = await getInjectedCss(details.tabId);
    if (injectedCss) {
        await insertCss(details.tabId, injectedCss, details.frameId);
        const settings = await getSettings();
        if (needsBackgroundMarker(settings)) {
            await startMarker(details.tabId, details.frameId);
        }
    }
});

// Single page applications change the URL without committing a new document,
// which can flip a per-page override on or off.
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
    if (details.frameId === 0) {
        syncTab(details.tabId, details.url);
    }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
    syncActiveTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' || changeInfo.url) {
        syncTab(tabId, tab.url);
    }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    chrome.storage.session.remove(injectedKey(tabId));
});

// The options page and the popup only write to storage; applying the result is
// this listener's job.
chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'local') {
        syncAllTabs();
    }
});

chrome.commands.onCommand.addListener(async function (command) {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab || !isSupportedUrl(tab.url)) {
        return;
    }
    switch (command) {
    case 'override-page':
        await toggleListEntry('OverridenPages', tab.url);
        break;
    case 'override-domain':
        await toggleListEntry('OverridenDomains', new URL(tab.url).hostname);
        break;
    case 'override-all':
        await toggleFlag('OverrideAll');
        break;
    }
});

chrome.runtime.onInstalled.addListener(async function (details) {
    if (details.reason === 'update' || details.reason === 'install') {
        await migrateLegacySettings();
    }
    await syncAllTabs();
});

chrome.runtime.onStartup.addListener(function () {
    syncAllTabs();
});

/** Resolves with the settings the offscreen document reports, or null. */
function waitForLegacySettings(timeoutMs) {
    return new Promise(function (resolve) {
        function stop(value) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(value);
        }
        function listener(request) {
            if (request && request.action === 'legacySettings') {
                stop(request.data);
            }
        }
        const timer = setTimeout(function () {
            stop(null);
        }, timeoutMs);
        chrome.runtime.onMessage.addListener(listener);
    });
}

/**
 * The Manifest V2 version kept its settings in the background page's
 * localStorage, which a service worker cannot read. An offscreen document can,
 * so it is used once to copy the old values over to chrome.storage.local.
 */
async function migrateLegacySettings() {
    const flag = await chrome.storage.local.get({legacyMigrationDone: false});
    if (flag.legacyMigrationDone) {
        return;
    }
    let legacy = null;
    try {
        // The document reports back on its own as soon as it runs, so there is
        // no window in which a message could be sent before it listens.
        const reported = waitForLegacySettings(5000);
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['LOCAL_STORAGE'],
            justification: 'Read settings saved by the previous Manifest V2 version.'
        });
        legacy = await reported;
    } catch (e) {
        // No offscreen support, or the document already exists - skip migration.
    } finally {
        try {
            await chrome.offscreen.closeDocument();
        } catch (e) {
            // Never opened.
        }
    }

    const patch = {legacyMigrationDone: true};
    if (legacy && typeof legacy === 'object') {
        Object.assign(patch, legacy);
    }
    await chrome.storage.local.set(patch);
}
