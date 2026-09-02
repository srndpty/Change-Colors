// What a tab is allowed to forget.
//
// The rule the whole navigation design rests on: a stylesheet is removable only
// while this record still holds the exact text it was inserted with, and a
// document the browser no longer lists is not necessarily gone. So nothing that
// says a document holds a stylesheet may be dropped because there is a lot of
// it - only because the document was seen to let go of it, or because the tab
// did.
//
// This is the record model on its own, in node.
import {
    compact,
    decisionFor,
    documentsOfPage,
    indexOfSheet,
    isEmpty,
    pageOf,
    readRecord,
    sheetsOf,
    shed
} from '../common/record.js';

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(ok);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name +
        (ok ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
}

/** A page with a top document and `frames` sub frames, all holding `css`. */
function page(record, pageId, frames, css) {
    record.decisions[pageId] = {css: css, shadowCss: null, probe: false};
    record.pages[pageId] = pageId;
    record.documents[pageId] = [indexOfSheet(record, css)];
    for (let i = 0; i < frames; i++) {
        const id = pageId + '-frame-' + i;
        record.pages[id] = pageId;
        record.documents[id] = [indexOfSheet(record, css)];
    }
    return record;
}

/* ------------------------------------------------- a page with many frames */

// The shape that used to lose provenance: one page holding more documents than
// any per-tab limit would allow, put aside while the tab goes somewhere else.
const record = readRecord(null);
page(record, 'cached', 60, 'body{background:#080808}');
page(record, 'onScreen', 1, 'body{background:#223344}');
record.top = 'onScreen';

const keep = new Set(['onScreen', 'onScreen-frame-0']);
let shedding = 0;
while (shed(record, keep)) {
    shedding++;
    if (shedding > 500) {
        break;
    }
}

check('everything a cached page holds is still there',
    documentsOfPage(record, 'cached').length, 60);
check('and the stylesheet in each of them is still known',
    sheetsOf(record, 'cached-frame-59'), ['body{background:#080808}']);
check('and so is the one in its top document',
    sheetsOf(record, 'cached'), ['body{background:#080808}']);
check('the page on screen keeps its decision',
    decisionFor(record, 'onScreen').css, 'body{background:#223344}');
check('the decision of a page that is only cached is what went first',
    decisionFor(record, 'cached').css, null);
check('shedding stops rather than touching documents that hold something',
    shed(record, keep), false);

/* ------------------------------------------ what shedding gives up, in order */

// One page holding a stylesheet, plus one document that is only known about -
// nothing has been put in it, so all that is lost with it is the chance to
// restyle it later.
const order = readRecord(null);
page(order, 'a', 0, 'css-a');
order.pages['reachable-only'] = 'a';

shed(order, new Set());
check('a decision goes before anything else', Object.keys(order.decisions), []);
check('and nothing else went with it', Object.keys(order.pages).sort(),
    ['a', 'reachable-only']);

shed(order, new Set());
check('then a document nothing was put in', Object.keys(order.pages), ['a']);

check('and a document that holds a stylesheet is where it stops',
    shed(order, new Set()), false);
check('which is still there with its text',
    sheetsOf(order, 'a'), ['css-a']);

/* ------------------------------------------------------------ housekeeping */

const sheets = readRecord(null);
page(sheets, 'p', 1, 'in-use');
sheets.sheets.push('nothing-refers-to-this');
compact(sheets);
check('the text of a stylesheet no document holds is dropped',
    sheets.sheets, ['in-use']);
check('and the ones still held are found where the documents say',
    sheetsOf(sheets, 'p-frame-0'), ['in-use']);

check('a document is filed under the page of the frame that made it',
    pageOf(readRecord({pages: {parent: 'thePage'}}), 'new', 'parent'), 'thePage');
check('and falls back to the page the tab is showing',
    pageOf(readRecord({top: 'thePage'}), 'new', undefined), 'thePage');
check('an empty record is recognised as empty', isEmpty(readRecord(null)), true);
check('and one holding a stylesheet is not', isEmpty(sheets), false);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
