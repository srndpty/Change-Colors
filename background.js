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
 *
 * Everything that touches a tab goes through one queue per tab. Syncing is a
 * read-modify-write ("which stylesheet is in this tab" -> remove it -> insert
 * the new one -> write it back) driven by four independent event sources, and
 * chrome.scripting.removeCSS only removes a stylesheet whose text is handed
 * back to it exactly: two overlapping syncs would leave a stylesheet in the
 * page that nothing can remove any more. The queue also gives sub frames the
 * ordering they need - a frame commits after its parent, so by the time its
 * task runs the top frame's task has recorded what this document wants.
 */

import {
    getSettings,
    getOverrideState,
    isSupportedUrl,
    toggleFlag,
    toggleListEntry
} from './common/settings.js';
import {buildCss, buildShadowCss, needsPageAgent, needsBackgroundProbe} from './common/css.js';

const ICON_ON = 'icons/colors_icons.png';
const ICON_OFF = 'icons/colors_icons_grey.png';
const INJECTED_PREFIX = 'injected:';

/* -------------------------------------------------------- one queue per tab */

// Tail of the chain of tasks queued for a tab, and the sequence number of the
// newest full resync queued for it.
const tabTasks = new Map();
const latestResync = new Map();
let sequence = 0;

function runOnTab(tabId, task) {
    const previous = tabTasks.get(tabId) || Promise.resolve();
    const next = previous.then(task, task).catch(function () {
        // A failed task must not break the chain for the ones behind it.
    });
    tabTasks.set(tabId, next);
    next.then(function () {
        if (tabTasks.get(tabId) === next) {
            tabTasks.delete(tabId);
            latestResync.delete(tabId);
        }
    });
    return next;
}

/**
 * Queues a sync for a tab.
 *
 * A full resync is coalesced: while one waits its turn a newer one makes it
 * pointless, and dropping it matters because the options page writes to storage
 * on every `input` event - dragging a color picker queues dozens of them.
 * A freshly committed frame is never coalesced; each one has its own document
 * to style.
 */
function queueSync(tabId, url, freshFrameId) {
    if (freshFrameId !== undefined) {
        return runOnTab(tabId, function () {
            return syncTab(tabId, url, freshFrameId);
        });
    }
    const seq = ++sequence;
    latestResync.set(tabId, seq);
    return runOnTab(tabId, function () {
        if (latestResync.get(tabId) !== seq) {
            return undefined;
        }
        return syncTab(tabId, url);
    });
}

/* ------------------------------------------------------------ tab plumbing */

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

function targetFor(tabId, frameId) {
    return frameId === undefined ?
        {tabId: tabId, allFrames: true} :
        {tabId: tabId, frameIds: [frameId]};
}

async function insertCss(tabId, css, frameId) {
    try {
        await chrome.scripting.insertCSS({target: targetFor(tabId, frameId), css: css});
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
 * agent.js styles shadow trees (a document stylesheet cannot reach into them)
 * and tags the elements carrying a background of their own.
 *
 * Both injections ask for `injectImmediately`. Without it chrome.scripting runs
 * a script at `document_idle`, while the document stylesheet paints every
 * element with the chosen background from the first paint on: the see-through
 * layers a page stacks over its content - a headline over a hero banner, the
 * controls over a video - would stay opaque until the page went idle.
 */
async function startAgent(tabId, shadowCss, probe, frameId) {
    const target = targetFor(tabId, frameId);
    try {
        await chrome.scripting.executeScript({
            target: target,
            files: ['agent.js'],
            injectImmediately: true
        });
        await chrome.scripting.executeScript({
            target: target,
            args: [shadowCss, probe],
            injectImmediately: true,
            func: function (css, measure) {
                if (window.__changeColorsAgent) {
                    window.__changeColorsAgent.setCss(css, measure);
                }
            }
        });
    } catch (e) {
        // Frame gone, or a document we may not script.
    }
}

async function stopAgent(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: {tabId: tabId, allFrames: true},
            injectImmediately: true,
            func: function () {
                if (window.__changeColorsAgent) {
                    window.__changeColorsAgent.stop();
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

/** What the current settings ask for on one URL. */
async function wantedFor(url) {
    const settings = await getSettings();
    const state = getOverrideState(settings, url);
    if (!state.active) {
        return {css: null, shadowCss: null, probe: false};
    }
    return {
        css: buildCss(settings),
        shadowCss: needsPageAgent(settings) ? buildShadowCss(settings) : null,
        probe: needsBackgroundProbe(settings)
    };
}

/**
 * Brings a tab in line with the current settings. Runs on the tab's queue, so
 * it has the tab to itself for the whole of its read-modify-write.
 *
 * `freshFrameId` is set when a document (or sub frame) has just committed: the
 * old stylesheet went away with the old document, so it only needs injecting.
 */
async function syncTab(tabId, url, freshFrameId) {
    if (!isSupportedUrl(url)) {
        if (freshFrameId === 0 || freshFrameId === undefined) {
            await rememberInjectedCss(tabId, null);
        }
        await setIcon(tabId, false);
        return;
    }

    const wanted = await wantedFor(url);
    await setIcon(tabId, Boolean(wanted.css));

    if (freshFrameId !== undefined) {
        // What this document wants is recorded before anything is injected, so
        // a sub frame committing while the agent is still being injected reads
        // this navigation's stylesheet rather than the previous page's.
        if (freshFrameId === 0) {
            await rememberInjectedCss(tabId, wanted.css);
        }
        if (wanted.css) {
            await insertCss(tabId, wanted.css, freshFrameId);
        }
        if (wanted.shadowCss !== null) {
            await startAgent(tabId, wanted.shadowCss, wanted.probe, freshFrameId);
        }
        return;
    }

    const injectedCss = await getInjectedCss(tabId);
    if (injectedCss !== wanted.css) {
        if (injectedCss) {
            await removeCss(tabId, injectedCss);
        }
        // Recorded before the insert, for the same reason as above.
        await rememberInjectedCss(tabId, wanted.css);
        if (wanted.css) {
            await insertCss(tabId, wanted.css);
        }
    }
    if (wanted.shadowCss !== null) {
        await startAgent(tabId, wanted.shadowCss, wanted.probe);
    } else {
        await stopAgent(tabId);
    }
}

async function syncAllTabs() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(function (tab) {
        return queueSync(tab.id, tab.url);
    }));
}

async function syncActiveTab(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        await queueSync(tab.id, tab.url);
    } catch (e) {
        // Tab is gone.
    }
}

/**
 * A frame commits after its parent has, so queueing here - synchronously, in
 * listener order - puts a sub frame behind the top frame's task, and it reads
 * the stylesheet that task recorded.
 */
chrome.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) {
        queueSync(details.tabId, details.url, 0);
        return;
    }
    runOnTab(details.tabId, async function () {
        // Sub frames inherit the decision taken for the top level document.
        const injectedCss = await getInjectedCss(details.tabId);
        if (!injectedCss) {
            return;
        }
        await insertCss(details.tabId, injectedCss, details.frameId);
        const settings = await getSettings();
        if (needsPageAgent(settings)) {
            await startAgent(details.tabId, buildShadowCss(settings),
                needsBackgroundProbe(settings), details.frameId);
        }
    });
});

// Single page applications change the URL without committing a new document,
// which can flip a per-page override on or off.
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
    if (details.frameId === 0) {
        queueSync(details.tabId, details.url);
    }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
    syncActiveTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' || changeInfo.url) {
        queueSync(tabId, tab.url);
    }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    tabTasks.delete(tabId);
    latestResync.delete(tabId);
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
