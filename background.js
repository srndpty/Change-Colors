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

// Tail of the chain of tasks queued for a tab, the sequence number of the
// newest full resync queued for it, and how many documents its top frame has
// committed - work queued for a tab that has navigated since is stale.
const tabTasks = new Map();
const latestResync = new Map();
const navigations = new Map();
let sequence = 0;

function navigationOf(tabId) {
    return navigations.get(tabId) || 0;
}

function noteNavigation(tabId) {
    navigations.set(tabId, navigationOf(tabId) + 1);
}

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
function queueSync(tabId, url, fresh) {
    const navigation = navigationOf(tabId);
    if (fresh !== undefined) {
        return runOnTab(tabId, function () {
            // A newer document has committed in the meantime; this one is gone.
            if (navigationOf(tabId) !== navigation) {
                return undefined;
            }
            return syncTab(tabId, url, fresh);
        });
    }
    const seq = ++sequence;
    latestResync.set(tabId, seq);
    return runOnTab(tabId, async function () {
        if (latestResync.get(tabId) !== seq) {
            return undefined;
        }
        // A resync applies to whatever the tab holds when it runs, and the URL
        // it was queued with can already be a page ago - `chrome.tabs.query`
        // answers with what the tab held at the time of the query. The override
        // rules have to be evaluated against the current URL, or a page the
        // user excluded gets the styling of the page it replaced.
        let current = url;
        try {
            current = (await chrome.tabs.get(tabId)).url;
        } catch (e) {
            return undefined;
        }
        // And if a document committed while we were asking, that commit brings
        // a sync of its own.
        if (navigationOf(tabId) !== navigation || latestResync.get(tabId) !== seq) {
            return undefined;
        }
        return syncTab(tabId, current);
    });
}

/* ------------------------------------------------------------ tab plumbing */

/**
 * What a tab is known to be in, kept in chrome.storage.session because the
 * service worker is not persistent:
 *
 *   desired  the stylesheet this document should have. Written as soon as a
 *            document commits, before anything is injected, because a sub frame
 *            commits while the top frame's injection is still running and has
 *            to read this navigation's answer rather than the previous page's.
 *   applied  the stylesheets believed to be in the page. Only a successful
 *            insertCSS adds one and only a successful removeCSS takes one away,
 *            because removeCSS needs the exact text of the stylesheet it is
 *            removing: a stylesheet dropped from this list is one nothing can
 *            take out of the page any more.
 *
 * The two are deliberately not the same value. An insertCSS that failed - a
 * frame that went away mid-flight - would otherwise be recorded as applied and
 * never retried.
 */
const MAX_TRACKED = 4;

function injectedKey(tabId) {
    return INJECTED_PREFIX + tabId;
}

async function getRecord(tabId) {
    const stored = await chrome.storage.session.get(injectedKey(tabId));
    const value = stored[injectedKey(tabId)];
    return {
        desired: (value && value.desired) || null,
        applied: (value && value.applied) || []
    };
}

function saveRecord(tabId, record) {
    if (!record.desired && !record.applied.length) {
        return chrome.storage.session.remove(injectedKey(tabId));
    }
    return chrome.storage.session.set({[injectedKey(tabId)]: record});
}

/**
 * A frame keeps its frameId across navigations, so a task that was queued for
 * one document would inject into whatever document the frame holds by the time
 * it runs. `documentId` names the document itself, which is what the injection
 * is really about.
 */
function targetFor(tabId, frame) {
    if (!frame) {
        return {tabId: tabId, allFrames: true};
    }
    if (frame.documentId) {
        return {tabId: tabId, documentIds: [frame.documentId]};
    }
    return {tabId: tabId, frameIds: [frame.frameId]};
}

/** Resolves true only if the stylesheet is now in the page. */
async function insertCss(tabId, css, frame) {
    try {
        await chrome.scripting.insertCSS({target: targetFor(tabId, frame), css: css});
        return true;
    } catch (e) {
        // The frame or document can be gone already, or be one we may not touch.
        return false;
    }
}

/** Resolves true only if the stylesheet is no longer in the page. */
async function removeCss(tabId, css) {
    try {
        await chrome.scripting.removeCSS({target: {tabId: tabId, allFrames: true}, css: css});
        return true;
    } catch (e) {
        return false;
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
async function startAgent(tabId, shadowCss, probe, frame) {
    const target = targetFor(tabId, frame);
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
 * `fresh` ({frameId, documentId}) is set when a top level document has just
 * committed: the old stylesheet went away with the old document, so the new one
 * only needs injecting - into that document, named by its id, and not into
 * whatever the frame holds by the time this runs.
 */
async function syncTab(tabId, url, fresh) {
    if (!isSupportedUrl(url)) {
        await saveRecord(tabId, {desired: null, applied: []});
        await setIcon(tabId, false);
        return;
    }

    const wanted = await wantedFor(url);
    await setIcon(tabId, Boolean(wanted.css));

    if (fresh !== undefined) {
        // What this document wants is recorded before anything is injected, so
        // a sub frame committing while the agent is still being injected reads
        // this navigation's stylesheet rather than the previous page's.
        //
        // What was applied to the previous document is kept rather than dropped:
        // those stylesheets went away with it, so removing them later is a no-op
        // that costs nothing - but a stylesheet that a task still in flight for
        // the previous page put into this document stays removable.
        const previous = await getRecord(tabId);
        const record = {desired: wanted.css, applied: previous.applied.slice(-MAX_TRACKED)};
        await saveRecord(tabId, record);
        if (wanted.css && await insertCss(tabId, wanted.css, fresh)) {
            if (!record.applied.includes(wanted.css)) {
                record.applied.push(wanted.css);
            }
            await saveRecord(tabId, record);
        }
        if (wanted.shadowCss !== null) {
            await startAgent(tabId, wanted.shadowCss, wanted.probe, fresh);
        }
        return;
    }

    const record = await getRecord(tabId);
    record.desired = wanted.css;
    // A stylesheet is dropped from `applied` only once it is really gone: one
    // that failed to come out stays on the list and is tried again next time,
    // because removeCSS is the only thing that can remove it and it needs this
    // exact text.
    const kept = [];
    for (const css of record.applied) {
        if (css === wanted.css || !await removeCss(tabId, css)) {
            kept.push(css);
        }
    }
    record.applied = kept.slice(-MAX_TRACKED);
    if (wanted.css && !record.applied.includes(wanted.css) &&
            await insertCss(tabId, wanted.css)) {
        record.applied.push(wanted.css);
    }
    await saveRecord(tabId, record);

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
    const frame = {frameId: details.frameId, documentId: details.documentId};
    if (details.frameId === 0) {
        // Recorded before queueing, so anything queued for the document this
        // one replaces can tell that it is stale.
        noteNavigation(details.tabId);
        queueSync(details.tabId, details.url, frame);
        return;
    }
    const navigation = navigationOf(details.tabId);
    runOnTab(details.tabId, async function () {
        if (navigationOf(details.tabId) !== navigation) {
            // The page this frame belongs to is gone.
            return;
        }
        // Sub frames inherit the decision taken for the top level document.
        const record = await getRecord(details.tabId);
        if (!record.desired) {
            return;
        }
        if (await insertCss(details.tabId, record.desired, frame) &&
                !record.applied.includes(record.desired)) {
            // The top frame's own insert did not get through, but this frame's
            // did: the stylesheet is in the page and has to stay removable.
            record.applied = record.applied.concat([record.desired]).slice(-MAX_TRACKED);
            await saveRecord(details.tabId, record);
        }
        const settings = await getSettings();
        if (needsPageAgent(settings)) {
            await startAgent(details.tabId, buildShadowCss(settings),
                needsBackgroundProbe(settings), frame);
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
    navigations.delete(tabId);
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
