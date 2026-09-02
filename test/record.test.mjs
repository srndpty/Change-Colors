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
import {syncCommittedFrame, syncPage} from '../common/sync.js';

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(ok);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name +
        (ok ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
}

function decision(css) {
    return {css: css, shadowCss: css ? css + '/shadow' : null, probe: Boolean(css)};
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

/**
 * A browser that can be told to refuse to store anything, and remembers what
 * was done to each document and what was last stored.
 */
function browser({acceptSaves = true} = {}) {
    const inPage = new Map();
    const calls = [];
    let stored = null;
    const io = {
        insertCss(documentId, css) {
            calls.push('insert ' + documentId);
            inPage.set(documentId, (inPage.get(documentId) || []).concat([css]));
            return Promise.resolve(true);
        },
        removeCss(documentId, css) {
            calls.push('remove ' + documentId);
            const held = inPage.get(documentId) || [];
            if (!held.includes(css)) {
                return Promise.resolve(false);
            }
            inPage.set(documentId, held.filter(text => text !== css));
            return Promise.resolve(true);
        },
        save(record) {
            calls.push('save');
            if (!io.acceptSaves) {
                return Promise.resolve(false);
            }
            // What a service worker restart would read back.
            stored = JSON.parse(JSON.stringify(record));
            return Promise.resolve(true);
        },
        applyAgent(documentId) {
            calls.push('agent ' + documentId);
            return Promise.resolve();
        },
        acceptSaves,
        // What the pages hold, against what the last stored record claims.
        stranded() {
            const record = readRecord(stored);
            const out = [];
            for (const [documentId, held] of inPage) {
                for (const css of held) {
                    if (!sheetsOf(record, documentId).includes(css)) {
                        out.push(documentId + ' holds an unrecorded stylesheet');
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
await syncPage(round, 'onScreen', decision('body{background:#334455}'), many,
    ['onScreen-frame-0']);

check('everything a cached page holds is still known',
    documentsOfPage(many, 'cached').length, 60);
check('with the text of the stylesheet in each of them',
    sheetsOf(many, 'cached-frame-59'), ['body{background:#080808}']);
check('and the decision its page took', decisionFor(many, 'cached').css,
    'body{background:#080808}');
check('a page on screen keeps its own decision too, for the iframes it may add',
    decisionFor(many, 'onScreen').css, 'body{background:#334455}');

/* --------------------------------------------- a browser that will not store */

// Nothing may be put into a page that could not be written down first.
const refused = readRecord(null);
refused.top = 'page';
const refusing = browser({acceptSaves: false});
const went = await syncPage(refusing, 'page', decision('css-new'), refused);

check('a page whose record cannot be stored is reported as not done', went, false);
check('and nothing was done to it',
    refusing.calls.filter(c => c !== 'save'), []);
check('so nothing is left in it that is not written down', refusing.stranded(), []);

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

check('the stylesheet reached both documents',
    [failing.held('page'), failing.held('page-frame')],
    [['css-new'], ['css-new']]);
check('and the last record stored still accounts for all of it',
    failing.stranded(), []);

/* ------------------------------------ a document that already held another */

const replacing = readRecord(null);
replacing.top = 'page';
page(replacing, 'page', 0, 'css-old');
const swapping = browser();
swapping.insertCss('page', 'css-old');
await syncPage(swapping, 'page', decision('css-new'), replacing);

check('the old stylesheet came out and the new one went in',
    swapping.held('page'), ['css-new']);
check('and what the page holds is what the record says',
    sheetsOf(readRecord(swapping.stored), 'page'), ['css-new']);

/* ------------------------------------------------ a sub frame that commits */

const framed = readRecord(null);
framed.top = 'page';
page(framed, 'page', 0, 'css-page');
const committing = browser();
await syncCommittedFrame(committing, 'frame', 'page', framed);

check('a sub frame is given what its own page decided',
    committing.held('frame'), ['css-page']);
check('and is filed under it', framed.pages.frame, 'page');

const refusedFrame = readRecord(null);
refusedFrame.top = 'page';
page(refusedFrame, 'page', 0, 'css-page');
const refusingFrame = browser({acceptSaves: false});
await syncCommittedFrame(refusingFrame, 'frame', 'page', refusedFrame);
check('a sub frame whose record cannot be stored is left alone',
    refusingFrame.calls.filter(c => c !== 'save'), []);

/* ------------------------------------------------------------ housekeeping */

const sheets = readRecord(null);
page(sheets, 'p', 1, 'in-use');
sheets.sheets.push('nothing-refers-to-this');
compact(sheets);
check('the text of a stylesheet nothing refers to is dropped',
    sheets.sheets.includes('nothing-refers-to-this'), false);
check('the ones documents hold survive it',
    sheetsOf(sheets, 'p-frame-0'), ['in-use']);
check('and so do the ones decisions refer to',
    decisionFor(sheets, 'p').shadowCss, 'in-use/shadow');

check('a stylesheet is held once however many documents have it',
    (() => {
        const shared = readRecord(null);
        page(shared, 'p', 9, 'same-text');
        return shared.sheets.length;
    })(), 2);

check('a document is filed under the page of the frame that made it',
    pageOf(readRecord({pages: {parent: 'thePage'}}), 'new', 'parent'), 'thePage');
check('and falls back to the page the tab is showing',
    pageOf(readRecord({top: 'thePage'}), 'new', undefined), 'thePage');
check('an empty record is recognised as empty', isEmpty(readRecord(null)), true);
check('and one holding a stylesheet is not', isEmpty(sheets), false);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
