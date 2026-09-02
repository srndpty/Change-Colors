/**
 * Bringing documents in line with what their page should have.
 *
 * The order of the work here is the whole point. A stylesheet can only be
 * removed by handing back the exact text it was inserted with, so the record of
 * what is in a page has to be written down before it becomes true, and may only
 * be narrowed once it has stopped being true:
 *
 *   - Nothing is put into a page until the record that says so has been stored.
 *     A record that could not be stored means the page is left exactly as it
 *     was, which is a state the record still describes correctly.
 *   - What is stored first is the wider claim: every document is written down
 *     as holding both what it has and what it is about to be given. If the
 *     work then half happens, or the service worker stops before the result can
 *     be stored, the record covers more than the page holds - and claiming a
 *     stylesheet that is not there only makes a later removal a no-op, while
 *     failing to claim one that is there strands it forever.
 *   - The exact result is stored afterwards, and that write is the only one
 *     allowed to make the record say less.
 *
 * `io` is what talks to the browser: insertCss and removeCss resolve true only
 * if the document really changed, save resolves true only if the record was
 * stored, and applyAgent runs the page agent. Passing it in is what lets this
 * be tested against a browser that refuses to store anything.
 */
import {
    decisionFor,
    documentsOfPage,
    setDecision,
    setSheets,
    sheetsOf
} from './record.js';

function union(texts, css) {
    if (!css || texts.includes(css)) {
        return texts;
    }
    return texts.concat([css]);
}

/**
 * Brings one document in line, given what it is known to hold. Records what it
 * ends up holding: a stylesheet stays on the list unless removing it succeeded,
 * and joins the list only if inserting it did.
 */
export async function syncDocument(io, documentId, wantedCss, record, present) {
    const kept = [];
    for (const css of present) {
        if (css === wantedCss || !await io.removeCss(documentId, css)) {
            kept.push(css);
        }
    }
    if (wantedCss && !kept.includes(wantedCss) &&
            await io.insertCss(documentId, wantedCss)) {
        kept.push(wantedCss);
    }
    setSheets(record, documentId, kept);
    return kept;
}

/**
 * Brings a whole page in line: its top document, the documents the browser
 * lists for it, and the ones only this record remembers - a page restored from
 * the back/forward cache brings its sub frames back without an event or a frame
 * tree entry of any kind.
 */
export async function syncPage(io, pageId, decision, record, alsoLive) {
    const ids = [pageId];
    for (const id of (alsoLive || []).concat(documentsOfPage(record, pageId))) {
        if (!ids.includes(id)) {
            ids.push(id);
        }
    }

    const present = new Map();
    for (const id of ids) {
        present.set(id, sheetsOf(record, id));
    }

    setDecision(record, pageId, decision);
    for (const id of ids) {
        record.pages[id] = pageId;
        setSheets(record, id, union(present.get(id), decision.css));
    }
    if (!await io.save(record)) {
        // The page is untouched, and that is what the stored record still says.
        return false;
    }

    for (const id of ids) {
        await syncDocument(io, id, decision.css, record, present.get(id));
    }
    await io.save(record);

    for (const id of ids) {
        await io.applyAgent(id, decision);
    }
    return true;
}

/**
 * A sub frame that has just committed, applying whatever its own page decided -
 * including that it wants nothing, since a sub frame restored from the
 * back/forward cache still holds the stylesheet and the agent it was left with.
 */
export async function syncCommittedFrame(io, documentId, pageId, record) {
    const decision = decisionFor(record, pageId);
    const present = sheetsOf(record, documentId);

    record.pages[documentId] = pageId;
    setSheets(record, documentId, union(present, decision.css));
    if (!await io.save(record)) {
        return false;
    }

    await syncDocument(io, documentId, decision.css, record, present);
    await io.save(record);
    await io.applyAgent(documentId, decision);
    return true;
}
