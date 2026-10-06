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
 *   - What is stored first is the wider claim: a document about to be given a
 *     stylesheet is written down as holding both what it has and what it is
 *     about to get, and marked as uncertain - the record now says what it may
 *     hold. Claiming a stylesheet that is not there only makes a later removal
 *     a no-op, while failing to claim one that is there strands it forever.
 *   - The exact result is stored afterwards and the mark comes off. That write
 *     is the only one allowed to make the record say less.
 *
 * A service worker that stops between those two writes leaves a document marked
 * uncertain, and the next one puts it back in a known state before doing
 * anything else: everything the record admits to comes out, including the
 * stylesheet the page should end up with, and then that one goes in. Removing a
 * stylesheet a document does not have is a no-op, so this is always safe, and
 * it is the only way to tell "the record says Y is in there" from "Y really is
 * in there".
 *
 * `io` is what talks to the browser. insertCss resolves true only if the
 * stylesheet is now in the document. removeCss resolves true if the request
 * went through, which includes a document that did not have it in the first
 * place - the browser treats that as nothing to do - and false only if the
 * document could not be reached at all. save resolves true only if the record
 * was stored. Passing all of it in is what lets this be tested against a
 * browser that refuses to store anything, or stops half way.
 */
import {
    decisionFor,
    documentsOfPage,
    isUncertain,
    markUncertain,
    setDecision,
    setSheets,
    settle,
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
 * ends up holding: a stylesheet stays on the list unless removing it went
 * through, and joins the list only if inserting it did.
 *
 * `unsure` says the list is what the document may hold rather than what it
 * does, so even the stylesheet it should end up with is taken out first and put
 * back - the only way to be sure it is there exactly once. That only settles
 * the question if the removals actually went through: a document that could not
 * be reached this time is still a document nobody knows the contents of, and
 * saying otherwise would leave the stylesheet it should have been given
 * unclaimed and never inserted. It stays uncertain until someone reaches it.
 *
 * An insert that fails needs no such care. The removals that came before it
 * succeeded, so what the document holds is known exactly: nothing of ours.
 */
export async function syncDocument(
    io,
    documentId,
    wantedCss,
    record,
    present,
    unsure
) {
    const kept = [];
    let known = true;
    for (const css of present) {
        if (!unsure && css === wantedCss) {
            kept.push(css);
            continue;
        }
        if (!(await io.removeCss(documentId, css))) {
            kept.push(css);
            if (unsure) {
                known = false;
            }
        }
    }
    if (
        wantedCss &&
        !kept.includes(wantedCss) &&
        (await io.insertCss(documentId, wantedCss))
    ) {
        kept.push(wantedCss);
    }
    setSheets(record, documentId, kept);
    if (known) {
        settle(record, documentId);
    } else {
        markUncertain(record, documentId);
    }
    return kept;
}

/** Writes down what a document may hold, before it is given anything. */
function claim(record, documentId, present, wantedCss) {
    const widened = union(present, wantedCss);
    if (widened !== present) {
        markUncertain(record, documentId);
    }
    setSheets(record, documentId, widened);
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
    const unsure = new Map();
    for (const id of ids) {
        present.set(id, sheetsOf(record, id));
        unsure.set(id, isUncertain(record, id));
    }

    setDecision(record, pageId, decision);
    for (const id of ids) {
        record.pages[id] = pageId;
        claim(record, id, present.get(id), decision.css);
    }
    if (!(await io.save(record))) {
        // The page is untouched, and that is what the stored record still says.
        return false;
    }

    for (const id of ids) {
        // Only a document that was already unsure when this began needs putting
        // back in a known state. The mark this run just made says the same
        // thing to the next worker, not to this one: it has not inserted
        // anything yet, and `present` says so.
        await syncDocument(
            io,
            id,
            decision.css,
            record,
            present.get(id),
            unsure.get(id)
        );
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
    const unsure = isUncertain(record, documentId);

    record.pages[documentId] = pageId;
    claim(record, documentId, present, decision.css);
    if (!(await io.save(record))) {
        return false;
    }

    await syncDocument(io, documentId, decision.css, record, present, unsure);
    await io.save(record);
    await io.applyAgent(documentId, decision);
    return true;
}
