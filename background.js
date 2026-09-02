/**
 * Change Colors - Manifest V3 service worker.
 *
 * Styling is applied with chrome.scripting.insertCSS instead of a content
 * script: the CSS can then be injected while the document commits, which keeps
 * the "no flash of the original page" behaviour of the Manifest V2 version
 * without shipping a script into every frame of every site.
 *
 * Two things shape the way that is done.
 *
 * The unit of work is a document, not a tab and not a frame. A frame keeps its
 * id when it navigates, so anything aimed at a frame lands in whatever document
 * the frame holds by the time it arrives - which, after a redirect, is a page
 * the extension may have decided not to touch at all. Every injection and every
 * removal names a `documentId`, so work decided for one document can only ever
 * reach that document; when it is gone, the call simply fails.
 *
 * And removing a stylesheet needs the exact text it was inserted with, so the
 * text of every stylesheet believed to be in a document is kept - in
 * chrome.storage.session, because the service worker is not persistent - until
 * a removal for that document has actually succeeded. A stylesheet forgotten
 * while it is still in a page is one nothing can take out again.
 *
 * Everything that touches a tab goes through one queue per tab, which keeps
 * these read-modify-writes from overlapping and gives sub frames their ordering:
 * a frame commits after its parent, so by the time its task runs the top frame's
 * task has recorded what the page wants.
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
// committed - work queued for a page the tab has since left is pointless.
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
 * A freshly committed document is never coalesced; each one has a document of
 * its own to style.
 *
 * The navigation counter only saves pointless work here. What keeps a task from
 * reaching the wrong page is that it names the documents it works on.
 */
function queueSync(tabId, url, fresh) {
    const navigation = navigationOf(tabId);
    if (fresh !== undefined) {
        return runOnTab(tabId, function () {
            if (navigationOf(tabId) !== navigation) {
                return undefined;
            }
            return syncTab(tabId, url, fresh);
        });
    }
    const seq = ++sequence;
    latestResync.set(tabId, seq);
    return runOnTab(tabId, function () {
        if (latestResync.get(tabId) !== seq) {
            return undefined;
        }
        // The URL a resync was queued with can be a page ago by the time it
        // runs, so the tab's live frames are what it works from; `url` is only
        // a fallback for when they cannot be read.
        return syncTab(tabId, url);
    });
}

/* ------------------------------------------------------------ tab plumbing */

/**
 * What is known about a tab:
 *
 *   desired    the stylesheet the page should have. Written as soon as a
 *              document commits, before anything is injected, because a sub
 *              frame commits while the top frame's injection is still running
 *              and has to read this navigation's answer, not the last page's.
 *   documents  documentId -> the stylesheets believed to be in that document,
 *              as indices into `sheets`. A stylesheet is added only by an
 *              insertCSS that succeeded and taken away only by a removeCSS that
 *              succeeded. Each call names one document, so there is no partial
 *              success to misread: what the list says is what that document
 *              holds.
 *   sheets     the text of those stylesheets, held once however many documents
 *              have them. The text is the only thing that can remove a
 *              stylesheet, and it is a few kilobytes, so documents refer to it
 *              rather than repeat it.
 *
 * A document the browser no longer lists is not necessarily gone: the
 * back/forward cache holds whole documents, stylesheet and all, and hands them
 * back on the next Back. Their entries are therefore kept - they cost an index
 * each - until there are more of them than any tab plausibly has, and only ones
 * that are not live are ever dropped.
 */
const MAX_DOCUMENTS = 50;

function injectedKey(tabId) {
    return INJECTED_PREFIX + tabId;
}

async function getRecord(tabId) {
    const stored = await chrome.storage.session.get(injectedKey(tabId));
    const value = stored[injectedKey(tabId)];
    return {
        desired: (value && value.desired) || null,
        documents: (value && value.documents) || {},
        sheets: (value && value.sheets) || []
    };
}

/** Drops the text of stylesheets no document refers to any more. */
function compact(record) {
    const sheets = [];
    const moved = new Map();
    for (const id of Object.keys(record.documents)) {
        record.documents[id] = record.documents[id].map(function (index) {
            if (!moved.has(index)) {
                moved.set(index, sheets.push(record.sheets[index]) - 1);
            }
            return moved.get(index);
        });
    }
    record.sheets = sheets;
}

function saveRecord(tabId, record) {
    compact(record);
    if (!record.desired && !Object.keys(record.documents).length) {
        return chrome.storage.session.remove(injectedKey(tabId));
    }
    return chrome.storage.session.set({[injectedKey(tabId)]: record});
}

function sheetsOf(record, documentId) {
    return (record.documents[documentId] || []).map(function (index) {
        return record.sheets[index];
    });
}

function indexOfSheet(record, css) {
    const index = record.sheets.indexOf(css);
    return index === -1 ? record.sheets.push(css) - 1 : index;
}

/**
 * Forgets the oldest documents that are no longer live. A document still listed
 * by the browser is kept whatever the count: its stylesheets can still be
 * removed, and only this record knows their text.
 */
function forgetDeadDocuments(record, live) {
    const ids = Object.keys(record.documents);
    if (ids.length <= MAX_DOCUMENTS) {
        return;
    }
    for (const id of ids) {
        if (Object.keys(record.documents).length <= MAX_DOCUMENTS) {
            return;
        }
        if (!live || !live.has(id)) {
            delete record.documents[id];
        }
    }
}

/** The documents the tab is holding right now, top level frame first. */
async function liveFrames(tabId) {
    try {
        const frames = await chrome.webNavigation.getAllFrames({tabId: tabId});
        return (frames || []).filter(function (frame) {
            return Boolean(frame.documentId);
        });
    } catch (e) {
        return [];
    }
}

/** Resolves true only if the stylesheet is now in that document. */
async function insertCss(tabId, documentId, css) {
    try {
        await chrome.scripting.insertCSS({
            target: {tabId: tabId, documentIds: [documentId]},
            css: css
        });
        return true;
    } catch (e) {
        // The document is gone already, or is one we may not touch.
        return false;
    }
}

/** Resolves true only if the stylesheet is no longer in that document. */
async function removeCss(tabId, documentId, css) {
    try {
        await chrome.scripting.removeCSS({
            target: {tabId: tabId, documentIds: [documentId]},
            css: css
        });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Brings one document in line with what the page should have, and records what
 * it ends up holding.
 *
 * This is the same work whether the document has just committed, has come back
 * from the back/forward cache with the stylesheet of an older setting still in
 * it, or is simply being resynced: what it should have is compared with what it
 * is known to have.
 */
async function syncDocument(tabId, documentId, wantedCss, record) {
    const present = sheetsOf(record, documentId);
    const kept = [];
    for (const css of present) {
        if (css === wantedCss || !await removeCss(tabId, documentId, css)) {
            kept.push(css);
        }
    }
    if (wantedCss && !kept.includes(wantedCss) &&
            await insertCss(tabId, documentId, wantedCss)) {
        kept.push(wantedCss);
    }
    if (kept.length) {
        record.documents[documentId] = kept.map(function (css) {
            return indexOfSheet(record, css);
        });
    } else {
        delete record.documents[documentId];
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
async function startAgent(tabId, documentId, shadowCss, probe) {
    const target = {tabId: tabId, documentIds: [documentId]};
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
        // Document gone, or one we may not script.
    }
}

async function stopAgent(tabId, documentId) {
    try {
        await chrome.scripting.executeScript({
            target: {tabId: tabId, documentIds: [documentId]},
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

async function clearTab(tabId) {
    await saveRecord(tabId, {desired: null, documents: {}});
    await setIcon(tabId, false);
}

/**
 * Brings a tab in line with the current settings. Runs on the tab's queue, so
 * it has the tab to itself for the whole of its read-modify-write.
 *
 * `fresh` ({frameId, documentId}) is set when a top level document has just
 * committed. The work is the same as a resync, but for that document alone:
 * the frame may already hold another one, and the other frames of the page get
 * their own commits.
 */
async function syncTab(tabId, url, fresh) {
    if (fresh !== undefined) {
        if (!isSupportedUrl(url)) {
            await clearTab(tabId);
            return;
        }
        const wanted = await wantedFor(url);
        await setIcon(tabId, Boolean(wanted.css));
        const record = await getRecord(tabId);
        // Recorded before anything is injected, so a sub frame committing while
        // the agent is still being injected reads this navigation's answer.
        record.desired = wanted.css;
        await saveRecord(tabId, record);
        await syncDocument(tabId, fresh.documentId, wanted.css, record);
        forgetDeadDocuments(record, new Set([fresh.documentId]));
        await saveRecord(tabId, record);
        if (wanted.shadowCss !== null) {
            await startAgent(tabId, fresh.documentId, wanted.shadowCss, wanted.probe);
        }
        return;
    }

    const frames = await liveFrames(tabId);
    const top = frames.find(function (frame) {
        return frame.frameId === 0;
    });
    let currentUrl = top ? top.url : url;
    if (!top) {
        try {
            currentUrl = (await chrome.tabs.get(tabId)).url;
        } catch (e) {
            return;
        }
    }
    if (!isSupportedUrl(currentUrl)) {
        await clearTab(tabId);
        return;
    }

    const wanted = await wantedFor(currentUrl);
    await setIcon(tabId, Boolean(wanted.css));

    const record = await getRecord(tabId);
    record.desired = wanted.css;
    const live = new Set();
    for (const frame of frames) {
        live.add(frame.documentId);
        // Sub frames follow the decision taken for the page they belong to.
        await syncDocument(tabId, frame.documentId, wanted.css, record);
    }
    forgetDeadDocuments(record, live);
    await saveRecord(tabId, record);

    for (const frame of frames) {
        if (wanted.shadowCss !== null) {
            await startAgent(tabId, frame.documentId, wanted.shadowCss, wanted.probe);
        } else {
            await stopAgent(tabId, frame.documentId);
        }
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
 *
 * A document restored from the back/forward cache commits again with the id it
 * already had, and `syncDocument()` treats it for what it is: a document that
 * may still hold the stylesheet of an older setting, to be brought in line
 * rather than assumed empty.
 */
chrome.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) {
        // Recorded before queueing, so work queued for the page this one
        // replaces can tell that it has nothing left to do.
        noteNavigation(details.tabId);
        queueSync(details.tabId, details.url, {
            frameId: details.frameId,
            documentId: details.documentId
        });
        return;
    }
    const navigation = navigationOf(details.tabId);
    runOnTab(details.tabId, async function () {
        if (navigationOf(details.tabId) !== navigation) {
            return;
        }
        const record = await getRecord(details.tabId);
        if (!record.desired) {
            return;
        }
        await syncDocument(details.tabId, details.documentId, record.desired, record);
        await saveRecord(details.tabId, record);
        const settings = await getSettings();
        if (needsPageAgent(settings)) {
            await startAgent(details.tabId, details.documentId,
                buildShadowCss(settings), needsBackgroundProbe(settings));
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

chrome.runtime.onInstalled.addListener(async function () {
    await migrateLegacySettings();
    await syncAllTabs();
});

chrome.runtime.onStartup.addListener(async function () {
    // Migration is retried here: a browser start is the next chance to reach an
    // offscreen document if the one on update could not be created.
    await migrateLegacySettings();
    await syncAllTabs();
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
 *
 * "Once" means once it has worked. The document reports what it found - an
 * empty object if there was nothing - so a report and a failure to get one are
 * different things, and only a report ends the migration. A creation that
 * failed, an offscreen document already in use, or a report that never came
 * leaves it to be tried again on the next browser start; marking it done there
 * would throw away the settings of everyone it happened to.
 */
let migrating = null;

function migrateLegacySettings() {
    if (!migrating) {
        migrating = runMigration().finally(function () {
            migrating = null;
        });
    }
    return migrating;
}

async function runMigration() {
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
        // No offscreen support, or the document already exists.
    } finally {
        try {
            await chrome.offscreen.closeDocument();
        } catch (e) {
            // Never opened.
        }
    }

    if (legacy === null || typeof legacy !== 'object') {
        // Nothing was read. Leave the flag alone and try again another time.
        return;
    }
    await chrome.storage.local.set(Object.assign({legacyMigrationDone: true}, legacy));
}
