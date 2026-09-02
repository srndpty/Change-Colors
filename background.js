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
import {migrateLegacySettings} from './common/migration.js';
import {
    NOTHING,
    compact,
    decisionFor,
    documentsOfPage,
    indexOfSheet,
    isEmpty,
    pageOf,
    readRecord,
    sheetsOf,
    shed
} from './common/record.js';

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
// Tabs that closed while work for them was still running. Kept for the life of
// the service worker, which is as long as anything can still be holding a
// record for one: a browser session never gives a tab id out twice.
const closedTabs = new Set();
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
            // A page the tab is only prerendering is not made pointless by the
            // page on screen changing: it is a page of its own, and it will be
            // on screen itself if the user goes there.
            if (fresh.active && navigationOf(tabId) !== navigation) {
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

/* ------------------------------------------------------------ tab plumbing */

function injectedKey(tabId) {
    return INJECTED_PREFIX + tabId;
}

async function getRecord(tabId) {
    const stored = await chrome.storage.session.get(injectedKey(tabId));
    return readRecord(stored[injectedKey(tabId)]);
}

/**
 * Stores what is known about a tab.
 *
 * There is no size at which this starts throwing away what it knows: a
 * stylesheet forgotten while it is still in a page is one nothing can ever
 * remove. Only a refusal from storage makes it give anything up, and then only
 * what `shed()` is willing to part with, one piece at a time. If even that is
 * not enough the record is left as it was - a record that could not be written
 * is recoverable, a page in a state nothing knows about is not.
 */
async function saveRecord(tabId, record, keep) {
    if (closedTabs.has(tabId)) {
        return undefined;
    }
    compact(record);
    if (isEmpty(record)) {
        return chrome.storage.session.remove(injectedKey(tabId));
    }
    for (;;) {
        try {
            return await chrome.storage.session.set({[injectedKey(tabId)]: record});
        } catch (e) {
            if (!shed(record, keep || new Set())) {
                return undefined;
            }
            compact(record);
        }
    }
}

/**
 * The documents of the page the tab is showing.
 *
 * A tab can be holding more than that - a page it is prerendering is in the
 * same tab and has a top level frame of its own - so anything that is not part
 * of the active page is left out here and dealt with by its own page.
 */
async function liveFrames(tabId) {
    try {
        const frames = await chrome.webNavigation.getAllFrames({tabId: tabId});
        return (frames || []).filter(function (frame) {
            return Boolean(frame.documentId) &&
                (frame.documentLifecycle === undefined || frame.documentLifecycle === 'active');
        });
    } catch (e) {
        return [];
    }
}

/**
 * The frame a page starts at.
 *
 * `frameId === 0` is not that test: a prerendered page's own top level frame
 * has a non-zero id, which is what `frameType` was added for. The fallback is
 * for browsers that do not report it.
 */
function isOutermost(frame) {
    if (frame.frameType !== undefined) {
        return frame.frameType === 'outermost_frame';
    }
    return frame.frameId === 0;
}

/**
 * The documents that belong to one page, walked down from its top document.
 *
 * A frame list is not one page's worth of frames. While a page replaces another
 * - a redirect, a link clicked before the last page finished - both documents
 * can be in it at once, and a page being prerendered is in it the whole time.
 * Taking the list at face value would mean applying one page's decision to
 * another page's document, which is exactly what naming documents is meant to
 * prevent.
 */
function documentsUnder(frames, top) {
    const children = new Map();
    for (const frame of frames) {
        const parent = frame.parentDocumentId ||
            (frame.parentFrameId >= 0 ? 'frame:' + frame.parentFrameId : null);
        if (parent === null) {
            continue;
        }
        children.set(parent, (children.get(parent) || []).concat([frame]));
    }
    const found = [top.documentId];
    const queue = [top];
    while (queue.length) {
        const frame = queue.shift();
        const below = (children.get(frame.documentId) || [])
            .concat(children.get('frame:' + frame.frameId) || []);
        for (const child of below) {
            if (!found.includes(child.documentId)) {
                found.push(child.documentId);
                queue.push(child);
            }
        }
    }
    return found;
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

/**
 * Puts the document's agent in the state the decision calls for. Stopping is
 * not only for a document that had one: a document restored from the
 * back/forward cache comes back with the agent it was left running, and with
 * the tags that agent put on the page.
 */
async function applyAgent(tabId, documentId, decision) {
    if (decision.shadowCss !== null) {
        await startAgent(tabId, documentId, decision.shadowCss, decision.probe);
    } else {
        await stopAgent(tabId, documentId);
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

/**
 * Brings a whole page in line with what it should have: its top document, the
 * documents the browser lists for it, and the ones only this record remembers -
 * a page restored from the back/forward cache brings its sub frames back
 * without an event or a frame tree entry of any kind.
 *
 * The decision is recorded before anything is injected, because a sub frame
 * commits while the injection is still running and has to read its own page's
 * answer rather than the last page's.
 */
async function syncPage(tabId, pageId, decision, record, alsoLive) {
    const ids = [pageId];
    for (const id of (alsoLive || []).concat(documentsOfPage(record, pageId))) {
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }

    if (decision.css) {
        record.decisions[pageId] = decision;
    } else {
        delete record.decisions[pageId];
    }
    for (const id of ids) {
        record.pages[id] = pageId;
    }
    await saveRecord(tabId, record, new Set(ids));

    for (const id of ids) {
        await syncDocument(tabId, id, decision.css, record);
    }
    await saveRecord(tabId, record, new Set(ids));

    for (const id of ids) {
        await applyAgent(tabId, id, decision);
    }
}

/**
 * Brings a tab in line with the current settings. Runs on the tab's queue, so
 * it has the tab to itself for the whole of its read-modify-write.
 *
 * `fresh` is set when a page's top document has just committed, and names that
 * document: the work is the same as a resync, but for the page that document
 * starts - which is not necessarily the page the tab is showing, since a tab
 * prerenders whole pages of its own.
 */
async function syncTab(tabId, url, fresh) {
    const record = await getRecord(tabId);

    if (fresh !== undefined) {
        const decision = isSupportedUrl(url) ? await wantedFor(url) : NOTHING;
        if (fresh.active) {
            record.top = fresh.documentId;
            await setIcon(tabId, Boolean(decision.css));
        }
        await syncPage(tabId, fresh.documentId, decision, record);
        return;
    }

    const frames = await liveFrames(tabId);
    const top = frames.find(isOutermost);
    let currentUrl = top ? top.url : url;
    if (!top) {
        try {
            currentUrl = (await chrome.tabs.get(tabId)).url;
        } catch (e) {
            return;
        }
    }
    if (!isSupportedUrl(currentUrl)) {
        // Nothing is dropped: the pages behind this one may still be in the
        // back/forward cache with a stylesheet in them, and this record holds
        // the only copy of the text that can remove it. They go when the tab
        // does.
        await setIcon(tabId, false);
        return;
    }

    const pageId = top ? top.documentId : record.top;
    if (!pageId) {
        return;
    }
    record.top = pageId;
    const decision = await wantedFor(currentUrl);
    await setIcon(tabId, Boolean(decision.css));
    await syncPage(tabId, pageId, decision, record,
        top ? documentsUnder(frames, top) : []);
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
    const active = details.documentLifecycle === undefined ||
        details.documentLifecycle === 'active';
    if (isOutermost(details)) {
        if (active) {
            // Recorded before queueing, so work queued for the page this one
            // replaces can tell that it has nothing left to do.
            noteNavigation(details.tabId);
        }
        queueSync(details.tabId, details.url, {
            documentId: details.documentId,
            active: active
        });
        return;
    }
    const navigation = navigationOf(details.tabId);
    runOnTab(details.tabId, async function () {
        if (active && navigationOf(details.tabId) !== navigation) {
            return;
        }
        // Whatever this frame's own page decided, including that it wants
        // nothing: a sub frame restored from the back/forward cache still holds
        // the stylesheet and the agent it was left with, and both have to go.
        const record = await getRecord(details.tabId);
        const pageId = pageOf(record, details.documentId, details.parentDocumentId);
        if (!pageId) {
            return;
        }
        const decision = decisionFor(record, pageId);
        record.pages[details.documentId] = pageId;
        await syncDocument(details.tabId, details.documentId, decision.css, record);
        await saveRecord(details.tabId, record, new Set([pageId, details.documentId]));
        await applyAgent(details.tabId, details.documentId, decision);
    });
});

// Single page applications change the URL without committing a new document,
// which can flip a per-page override on or off.
chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
    if (isOutermost(details) && details.documentLifecycle !== 'prerender') {
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
    // A task that is part way through its work carries on - there is no way to
    // stop it - and would write back what it read before the tab closed. Tab ids
    // are not reused within a browser session, so remembering the closed one is
    // enough to keep that write from putting the record back.
    closedTabs.add(tabId);
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
