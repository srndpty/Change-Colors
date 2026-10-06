/**
 * What is known about a tab.
 *
 * A tab is not one page. It holds the page it is showing, whatever the
 * back/forward cache is keeping for it, and any page it is prerendering, all at
 * once - so everything here is keyed by the document it belongs to rather than
 * by the tab.
 *
 *   decisions  pageId -> what that page should have: its stylesheet, the
 *              stylesheet for its shadow trees, and whether the agent has to
 *              measure. Written as soon as the page's top document commits,
 *              before anything is injected, because a sub frame commits while
 *              the injection is still running and has to read its own page's
 *              answer. A page keeps its decision for as long as it can still
 *              commit a document, which is for as long as it exists: a page on
 *              screen adds an iframe whenever it likes.
 *   pages      documentId -> the page it belongs to. This is how a document is
 *              reached at all - a page restored from the back/forward cache
 *              brings its sub frames back already loaded, they commit nothing,
 *              and `webNavigation.getAllFrames` does not list them - and it is
 *              also how a sub frame that commits later is told which page it
 *              belongs to, through its parent.
 *   documents  documentId -> the stylesheets believed to be in that document,
 *              as indices into `sheets`. A stylesheet is added only by an
 *              insertCSS that succeeded and taken away only by a removeCSS that
 *              succeeded. Each call names one document, so there is no partial
 *              success to misread.
 *   sheets     the text of every stylesheet mentioned above, held once however
 *              many documents and decisions refer to it. The text is the only
 *              thing that can remove a stylesheet, it is a few kilobytes, and
 *              a tab's pages mostly want the same one.
 *   uncertain  documentId -> true, while what `documents` says about it is a
 *              claim about what it may hold rather than what it does. A
 *              stylesheet has to be written down before it is put into a page,
 *              so between the two the record is deliberately wider than the
 *              truth - and a service worker that stops in there leaves that
 *              wider claim behind for the next one, which would otherwise read
 *              it as fact and never insert the stylesheet at all. Whoever picks
 *              such a document up puts it back in a known state: take out
 *              everything the record admits to, then put in what it should
 *              have.
 *   top        the page the tab is actually showing. Only a fallback, for
 *              working out which page a sub frame belongs to when the browser
 *              does not say.
 *
 * Nothing here is ever dropped to save room. Each of these is authority for
 * something that cannot be worked out again: which document holds a stylesheet
 * and its exact text, which page a document belongs to, and what its page
 * decided. A document the browser no longer lists is not necessarily gone, a
 * page on screen can commit a new sub frame at any moment, and a guess in
 * either direction strands a stylesheet in a page or hands a document the
 * decision of the wrong page. What a tab knows goes when the tab goes.
 *
 * What keeps that affordable is that the big values - the stylesheets - are
 * held once each, so what a page costs is a few dozen bytes of document ids.
 */

/** What a page gets when nothing is meant to be applied to it. */
export const NOTHING = { css: null, shadowCss: null, probe: false };

export function readRecord(value) {
    return {
        decisions: (value && value.decisions) || {},
        pages: (value && value.pages) || {},
        documents: (value && value.documents) || {},
        uncertain: (value && value.uncertain) || {},
        sheets: (value && value.sheets) || [],
        top: (value && value.top) || null
    };
}

export function isEmpty(record) {
    return (
        !Object.keys(record.decisions).length &&
        !Object.keys(record.pages).length &&
        !Object.keys(record.documents).length
    );
}

function textAt(record, index) {
    return index === null || index === undefined ? null : record.sheets[index];
}

export function indexOfSheet(record, css) {
    if (css === null || css === undefined) {
        return null;
    }
    const index = record.sheets.indexOf(css);
    return index === -1 ? record.sheets.push(css) - 1 : index;
}

/**
 * What a page decided. A page nothing was decided for and a page decided to be
 * left alone are the same thing to a document: take the stylesheet out and stop
 * the agent.
 */
export function decisionFor(record, pageId) {
    const stored = record.decisions[pageId];
    if (!stored) {
        return NOTHING;
    }
    return {
        css: textAt(record, stored.css),
        shadowCss: textAt(record, stored.shadow),
        probe: Boolean(stored.probe)
    };
}

export function setDecision(record, pageId, decision) {
    if (!decision || !decision.css) {
        delete record.decisions[pageId];
        return;
    }
    record.decisions[pageId] = {
        css: indexOfSheet(record, decision.css),
        shadow: indexOfSheet(record, decision.shadowCss),
        probe: Boolean(decision.probe)
    };
}

/**
 * The page a document belongs to, as far as anything here knows, or null when
 * nothing here knows.
 *
 * `top` is the last resort and only that. It is the page the tab is showing,
 * which is the right answer for a sub frame the browser tells us nothing about
 * - but it is only ever as fresh as the last write that got through, and a
 * write that failed for want of room leaves it naming the page before this one.
 * So when the browser does name the parent, that name is the whole answer: if
 * the parent is not recorded, this document's page is not known, and guessing
 * hands the frame the decision of a page that is no longer on screen - the top
 * document bare and one iframe still colored, written back as fact. Not
 * knowing is recoverable; the next full resync reaches the frame through its
 * page.
 */
export function pageOf(record, documentId, parentDocumentId) {
    if (record.pages[documentId]) {
        return record.pages[documentId];
    }
    if (parentDocumentId) {
        return record.pages[parentDocumentId] || null;
    }
    return record.top;
}

/** Every document recorded as belonging to a page, the page's own aside. */
export function documentsOfPage(record, pageId) {
    return Object.keys(record.pages).filter(function (id) {
        return id !== pageId && record.pages[id] === pageId;
    });
}

export function sheetsOf(record, documentId) {
    return (record.documents[documentId] || []).map(function (index) {
        return record.sheets[index];
    });
}

/**
 * Whether what the record says about a document is a claim about what it may
 * hold rather than what it does.
 */
export function isUncertain(record, documentId) {
    return Boolean(record.uncertain[documentId]);
}

export function markUncertain(record, documentId) {
    record.uncertain[documentId] = true;
}

export function settle(record, documentId) {
    delete record.uncertain[documentId];
}

export function setSheets(record, documentId, texts) {
    if (!texts.length) {
        delete record.documents[documentId];
        // Nothing is claimed, so there is nothing left to be wrong about.
        delete record.uncertain[documentId];
        return;
    }
    record.documents[documentId] = texts.map(function (css) {
        return indexOfSheet(record, css);
    });
}

/** Drops the text of stylesheets nothing refers to any more. */
export function compact(record) {
    const sheets = [];
    const moved = new Map();
    function keep(index) {
        if (index === null || index === undefined) {
            return index;
        }
        if (!moved.has(index)) {
            moved.set(index, sheets.push(record.sheets[index]) - 1);
        }
        return moved.get(index);
    }
    for (const id of Object.keys(record.uncertain)) {
        if (!record.documents[id]) {
            delete record.uncertain[id];
        }
    }
    for (const id of Object.keys(record.documents)) {
        record.documents[id] = record.documents[id].map(keep);
    }
    for (const id of Object.keys(record.decisions)) {
        const decision = record.decisions[id];
        decision.css = keep(decision.css);
        decision.shadow = keep(decision.shadow);
    }
    record.sheets = sheets;
}
