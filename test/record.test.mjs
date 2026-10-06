// What a tab knows, and what it does when it cannot write it down.
//
// The rule the whole navigation design rests on: a stylesheet can be removed
// only while this record holds the exact text it was inserted with, and a
// document the browser no longer lists is not necessarily gone. So the record
// is never narrowed on a guess - not for size, not for age - and a page is
// never changed unless the record that says so has been stored first.
//
// The record model and the ordering of the work, in node, against a browser
// that can be told to refuse.
import {
    compact,
    decisionFor,
    documentsOfPage,
    isEmpty,
    pageOf,
    readRecord,
    setDecision,
    setSheets,
    sheetsOf
} from '../common/record.js';
import { syncCommittedFrame, syncPage } from '../common/sync.js';

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(ok);
    console.log(
        (ok ? 'PASS  ' : 'FAIL  ') +
            name +
            (ok
                ? ''
                : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    );
}

function decision(css) {
    return {
        css: css,
        shadowCss: css ? css + '/shadow' : null,
        probe: Boolean(css)
    };
}

/** A page with a top document and `frames` sub frames, all holding `css`. */
function page(record, pageId, frames, css) {
    setDecision(record, pageId, decision(css));
    record.pages[pageId] = pageId;
    setSheets(record, pageId, [css]);
    for (let i = 0; i < frames; i++) {
        const id = pageId + '-frame-' + i;
        record.pages[id] = pageId;
        setSheets(record, id, [css]);
    }
    return record;
}

const STOPPED = new Error('the service worker stopped');

/**
 * A browser that remembers what each document holds and what was last stored,
 * and that can be told to refuse to store anything or to stop part way through.
 *
 * `removeCss` follows the real one: the request going through is what it
 * reports, and a document that did not have that stylesheet is nothing to do
 * rather than a failure. Only a document it cannot reach is false.
 */
function browser({ acceptSaves = true, world = new Map() } = {}) {
    const inPage = world;
    const calls = [];
    let stored = null;
    function step(what) {
        // Stopping is said in terms of the work, not how many calls have gone
        // by: setting a page up is calls too, and an ordinal quietly moves when
        // anything else does.
        if (io.stopBefore && io.stopBefore(what, calls)) {
            throw STOPPED;
        }
        calls.push(what);
    }
    const io = {
        stopBefore: null,
        // Documents the browser will not let anything reach, the way a frame
        // that is going away refuses everything aimed at it.
        unreachable: new Set(),
        insertCss(documentId, css) {
            step('insert ' + documentId);
            if (io.unreachable.has(documentId)) {
                return Promise.resolve(false);
            }
            inPage.set(
                documentId,
                (inPage.get(documentId) || []).concat([css])
            );
            return Promise.resolve(true);
        },
        removeCss(documentId, css) {
            step('remove ' + documentId);
            if (io.unreachable.has(documentId)) {
                return Promise.resolve(false);
            }
            const held = inPage.get(documentId) || [];
            inPage.set(
                documentId,
                held.filter((text) => text !== css)
            );
            return Promise.resolve(true);
        },
        save(record) {
            step('save');
            if (!io.acceptSaves) {
                return Promise.resolve(false);
            }
            // What a service worker restart would read back.
            stored = JSON.parse(JSON.stringify(record));
            return Promise.resolve(true);
        },
        applyAgent(documentId) {
            step('agent ' + documentId);
            return Promise.resolve();
        },
        acceptSaves,
        /** Forgets the calls so far, so setting a page up is not part of a run. */
        forgetCalls() {
            calls.length = 0;
        },
        /** The same pages, seen by a service worker that has just started. */
        restart(options) {
            return browser(Object.assign({ world: inPage }, options));
        },
        // What the pages hold, against what the last stored record claims.
        stranded() {
            const record = readRecord(stored);
            const out = [];
            for (const [documentId, held] of inPage) {
                for (const css of held) {
                    if (!sheetsOf(record, documentId).includes(css)) {
                        out.push(
                            documentId + ' holds an unrecorded stylesheet'
                        );
                    }
                }
            }
            return out;
        },
        /** Stylesheets the record claims that the page does not have. */
        phantom(only) {
            const record = readRecord(stored);
            const out = [];
            for (const documentId of Object.keys(record.documents)) {
                if (only && documentId !== only) {
                    continue;
                }
                for (const css of sheetsOf(record, documentId)) {
                    if (!(inPage.get(documentId) || []).includes(css)) {
                        out.push(
                            documentId + ' is claimed to hold what it does not'
                        );
                    }
                }
            }
            return out;
        },
        get calls() {
            return calls;
        },
        get stored() {
            return stored;
        },
        held(documentId) {
            return inPage.get(documentId) || [];
        }
    };
    return io;
}

/* -------------------------------------------- a page with many sub frames */

// The shape a per-tab limit used to lose: one page holding more documents than
// any such limit would allow, put aside while the tab goes elsewhere.
const many = readRecord(null);
page(many, 'cached', 60, 'body{background:#080808}');
page(many, 'onScreen', 1, 'body{background:#223344}');
many.top = 'onScreen';

const round = browser();
await syncPage(round, 'onScreen', decision('body{background:#334455}'), many, [
    'onScreen-frame-0'
]);

check(
    'everything a cached page holds is still known',
    documentsOfPage(many, 'cached').length,
    60
);
check(
    'with the text of the stylesheet in each of them',
    sheetsOf(many, 'cached-frame-59'),
    ['body{background:#080808}']
);
check(
    'and the decision its page took',
    decisionFor(many, 'cached').css,
    'body{background:#080808}'
);
check(
    'a page on screen keeps its own decision too, for the iframes it may add',
    decisionFor(many, 'onScreen').css,
    'body{background:#334455}'
);

/* --------------------------------------------- a browser that will not store */

// Nothing may be put into a page that could not be written down first.
const refused = readRecord(null);
refused.top = 'page';
const refusing = browser({ acceptSaves: false });
const went = await syncPage(refusing, 'page', decision('css-new'), refused);

check(
    'a page whose record cannot be stored is reported as not done',
    went,
    false
);
check(
    'and nothing was done to it',
    refusing.calls.filter((c) => c !== 'save'),
    []
);
check(
    'so nothing is left in it that is not written down',
    refusing.stranded(),
    []
);

/* ------------------- a browser that stops storing part way through the work */

// The first save is what allows the work; a later refusal must not be able to
// narrow what was stored, or a stylesheet ends up in a page nothing knows about.
const halfway = readRecord(null);
halfway.top = 'page';
const failing = browser();
failing.acceptSaves = true;
const originalSave = failing.save;
let saves = 0;
failing.save = function (record) {
    saves++;
    // Everything after the write-ahead is refused, as a quota would.
    failing.acceptSaves = saves < 2;
    return originalSave(record);
};
await syncPage(failing, 'page', decision('css-new'), halfway, ['page-frame']);

check(
    'the stylesheet reached both documents',
    [failing.held('page'), failing.held('page-frame')],
    [['css-new'], ['css-new']]
);
check(
    'and the last record stored still accounts for all of it',
    failing.stranded(),
    []
);

/* ------------------------------------ a document that already held another */

const replacing = readRecord(null);
replacing.top = 'page';
page(replacing, 'page', 0, 'css-old');
const swapping = browser();
swapping.insertCss('page', 'css-old');
await syncPage(swapping, 'page', decision('css-new'), replacing);

check(
    'the old stylesheet came out and the new one went in',
    swapping.held('page'),
    ['css-new']
);
check(
    'and what the page holds is what the record says',
    sheetsOf(readRecord(swapping.stored), 'page'),
    ['css-new']
);

/* --------------------------- a worker that stops part way through the work */

// Everything the record says has been written down before it became true, so a
// worker that stops in the middle leaves a record that says more than the page
// holds. The next worker has to be able to tell that from a record that is
// exact, and to put the document back in a known state either way.

/**
 * Runs a sync that stops where `stopBefore` says, then hands what was stored to
 * a fresh worker looking at the same pages.
 */
async function interrupted(stopBefore, { startWith, decisionCss } = {}) {
    const record = readRecord(null);
    record.top = 'page';
    if (startWith) {
        page(record, 'page', 0, startWith);
    }
    const first = browser();
    if (startWith) {
        await first.insertCss('page', startWith);
    }
    // Setting the page up is not part of the run being interrupted.
    first.forgetCalls();
    first.stopBefore = stopBefore;
    try {
        await syncPage(
            first,
            'page',
            decision(decisionCss || 'css-new'),
            record
        );
    } catch (error) {
        if (error !== STOPPED) {
            throw error;
        }
    }
    // A new worker knows only what was stored.
    const revived = readRecord(JSON.parse(JSON.stringify(first.stored)));
    const second = first.restart();
    await syncPage(second, 'page', decision(decisionCss || 'css-new'), revived);
    return { first: first, second: second, record: revived };
}

const untilInsert = (what) => what === 'insert page';
const untilSecondSave = (what, calls) =>
    what === 'save' && calls.filter((c) => c === 'save').length === 1;

// Stopped after the write-ahead save, before anything was put in the page.
const beforeInsert = await interrupted(untilInsert);
check('it stopped where it was meant to', beforeInsert.first.calls, ['save']);
check(
    'a stylesheet the record claimed but never got in is put in',
    beforeInsert.second.held('page'),
    ['css-new']
);
check('exactly once', beforeInsert.second.held('page').length, 1);
check(
    'and the record ends up exact',
    beforeInsert.second.phantom().concat(beforeInsert.second.stranded()),
    []
);
check(
    'with nothing left uncertain',
    Object.keys(beforeInsert.record.uncertain),
    []
);

// Stopped after the old stylesheet came out, before the new one went in.
const betweenSwap = await interrupted(untilInsert, { startWith: 'css-old' });
check(
    'it stopped between the removal and the insert',
    betweenSwap.first.calls,
    ['save', 'remove page']
);
check(
    'a swap that stopped half way ends with only the new stylesheet',
    betweenSwap.second.held('page'),
    ['css-new']
);
check(
    'and a record that matches it',
    betweenSwap.second.phantom().concat(betweenSwap.second.stranded()),
    []
);

// Stopped after the insert, before the exact record could be stored.
const afterInsert = await interrupted(untilSecondSave);
check(
    'it stopped after the insert and before the record of it',
    afterInsert.first.calls,
    ['save', 'insert page']
);
check(
    'a stylesheet that got in before the stop is not put in twice',
    afterInsert.second.held('page'),
    ['css-new']
);
check(
    'and the record matches the page',
    afterInsert.second.phantom().concat(afterInsert.second.stranded()),
    []
);

/* ------------------- a document that cannot be reached while it is uncertain */

// Recovery needs the document to answer. One that does not is still a document
// nobody knows the contents of, and saying otherwise would leave the stylesheet
// it should have been given unclaimed and never inserted.
const outOfReach = readRecord(null);
outOfReach.top = 'page';
const stopping = browser();
stopping.stopBefore = untilInsert;
try {
    await syncPage(stopping, 'page', decision('css-new'), outOfReach);
} catch (error) {
    if (error !== STOPPED) {
        throw error;
    }
}
const away = readRecord(JSON.parse(JSON.stringify(stopping.stored)));
const unreachable = stopping.restart();
unreachable.unreachable.add('page');
await syncPage(unreachable, 'page', decision('css-new'), away);

check(
    'a document that could not be reached is left uncertain',
    Object.keys(away.uncertain),
    ['page']
);
check('and is still claimed to hold what it may hold', sheetsOf(away, 'page'), [
    'css-new'
]);
check('and nothing was put in it', unreachable.held('page'), []);

const backInReach = unreachable.restart();
await syncPage(backInReach, 'page', decision('css-new'), away);
check(
    'once it answers again, the stylesheet goes in',
    backInReach.held('page'),
    ['css-new']
);
check('once', backInReach.held('page').length, 1);
check('and the record is exact again', Object.keys(away.uncertain), []);

// The same, for a sub frame that commits.
const frameRecord = readRecord(null);
frameRecord.top = 'page';
page(frameRecord, 'page', 0, 'css-page');
const frameFirst = browser();
frameFirst.stopBefore = (what) => what === 'insert frame';
try {
    await syncCommittedFrame(frameFirst, 'frame', 'page', frameRecord);
} catch (error) {
    if (error !== STOPPED) {
        throw error;
    }
}
const frameRevived = readRecord(JSON.parse(JSON.stringify(frameFirst.stored)));
const frameSecond = frameFirst.restart();
await syncCommittedFrame(frameSecond, 'frame', 'page', frameRevived);
check(
    'a sub frame interrupted before it was styled is styled by the next worker',
    frameSecond.held('frame'),
    ['css-page']
);
check(
    'once, with a record that matches',
    frameSecond.phantom('frame').concat(frameSecond.stranded()),
    []
);
check(
    'and nothing about it left uncertain',
    Object.keys(frameRevived.uncertain),
    []
);

/* ------------------------------------------------ a sub frame that commits */

const framed = readRecord(null);
framed.top = 'page';
page(framed, 'page', 0, 'css-page');
const committing = browser();
await syncCommittedFrame(committing, 'frame', 'page', framed);

check(
    'a sub frame is given what its own page decided',
    committing.held('frame'),
    ['css-page']
);
check('and is filed under it', framed.pages.frame, 'page');

const refusedFrame = readRecord(null);
refusedFrame.top = 'page';
page(refusedFrame, 'page', 0, 'css-page');
const refusingFrame = browser({ acceptSaves: false });
await syncCommittedFrame(refusingFrame, 'frame', 'page', refusedFrame);
check(
    'a sub frame whose record cannot be stored is left alone',
    refusingFrame.calls.filter((c) => c !== 'save'),
    []
);

/* ------------------------------------------------------------ housekeeping */

const sheets = readRecord(null);
page(sheets, 'p', 1, 'in-use');
sheets.sheets.push('nothing-refers-to-this');
compact(sheets);
check(
    'the text of a stylesheet nothing refers to is dropped',
    sheets.sheets.includes('nothing-refers-to-this'),
    false
);
check('the ones documents hold survive it', sheetsOf(sheets, 'p-frame-0'), [
    'in-use'
]);
check(
    'and so do the ones decisions refer to',
    decisionFor(sheets, 'p').shadowCss,
    'in-use/shadow'
);

check(
    'a stylesheet is held once however many documents have it',
    (() => {
        const shared = readRecord(null);
        page(shared, 'p', 9, 'same-text');
        return shared.sheets.length;
    })(),
    2
);

check(
    'a document is filed under the page of the frame that made it',
    pageOf(readRecord({ pages: { parent: 'thePage' } }), 'new', 'parent'),
    'thePage'
);
check(
    'and falls back to the page the tab is showing',
    pageOf(readRecord({ top: 'thePage' }), 'new', undefined),
    'thePage'
);
// The tab's page is only ever as fresh as the last write that got through: a
// top document whose write-ahead save failed for want of room leaves `top`
// naming the page before it. A named parent that is not recorded is therefore
// not an invitation to fall back on it - the frame is left alone until a full
// resync reaches it through its page.
check(
    'but a named parent that is not recorded leaves the page unknown',
    pageOf(
        readRecord({ top: 'stale-page', pages: {} }),
        'new',
        'uncharted-parent'
    ),
    null
);
check(
    'and the fallback is still there for a frame with no parent named',
    pageOf(readRecord({ top: 'stale-page', pages: {} }), 'new', undefined),
    'stale-page'
);
check(
    'an empty record is recognised as empty',
    isEmpty(readRecord(null)),
    true
);
check('and one holding a stylesheet is not', isEmpty(sheets), false);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
