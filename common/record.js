/**
 * What is known about a tab, and the rules for forgetting any of it.
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
 *              answer. It is the one decision for that page: a sub frame
 *              applies it rather than deciding again from settings that may
 *              have moved on since.
 *   pages      documentId -> the page it belongs to. This is how a document is
 *              reached at all: a page restored from the back/forward cache
 *              brings its sub frames back already loaded, they commit nothing,
 *              and `webNavigation.getAllFrames` does not list them - not even
 *              seconds later.
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
 *   top        the page the tab is actually showing. Only a fallback, for
 *              working out which page a sub frame belongs to when the browser
 *              does not say.
 *
 * Nothing that says a document holds a stylesheet is ever dropped on a guess.
 * A document the browser no longer lists is not necessarily gone - that is the
 * whole reason `pages` exists - so there is no count at which its entry stops
 * being worth keeping: dropping it while the stylesheet is still in the page
 * leaves a stylesheet nothing can ever remove, because removeCSS needs exactly
 * the text this record holds. What a tab knows goes when the tab goes.
 *
 * Two things are allowed to be forgotten. A decision, because it carries whole
 * stylesheets and only matters while a page can still commit a document - a
 * page that is no longer being loaded gets a fresh decision if it ever comes
 * back. And a `pages` entry for a document with nothing in it, which costs only
 * the chance to restyle that document later. Even those are only given up when
 * the browser will not store the record as it is.
 */

/** What a page gets when nothing is meant to be applied to it. */
export const NOTHING = {css: null, shadowCss: null, probe: false};

export function readRecord(value) {
    return {
        decisions: (value && value.decisions) || {},
        pages: (value && value.pages) || {},
        documents: (value && value.documents) || {},
        sheets: (value && value.sheets) || [],
        top: (value && value.top) || null
    };
}

export function isEmpty(record) {
    return !Object.keys(record.decisions).length &&
        !Object.keys(record.pages).length &&
        !Object.keys(record.documents).length;
}

/**
 * What a page decided. A page nothing was decided for and a page decided to be
 * left alone are the same thing to a document: take the stylesheet out and stop
 * the agent.
 */
export function decisionFor(record, pageId) {
    return record.decisions[pageId] || NOTHING;
}

/** The page a document belongs to, as far as anything here knows. */
export function pageOf(record, documentId, parentDocumentId) {
    if (record.pages[documentId]) {
        return record.pages[documentId];
    }
    if (parentDocumentId && record.pages[parentDocumentId]) {
        return record.pages[parentDocumentId];
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

export function indexOfSheet(record, css) {
    const index = record.sheets.indexOf(css);
    return index === -1 ? record.sheets.push(css) - 1 : index;
}

/** Drops the text of stylesheets no document refers to any more. */
export function compact(record) {
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

/**
 * Gives up as little as possible, in the order it can least be missed, until
 * the caller says the record fits. Called only when storing it failed.
 *
 * Returns false when there is nothing left it is willing to give up: everything
 * remaining is a document believed to hold a stylesheet, and forgetting one of
 * those would strand it.
 */
export function shed(record, keep) {
    for (const id of Object.keys(record.decisions)) {
        if (!keep.has(id)) {
            delete record.decisions[id];
            return true;
        }
    }
    for (const id of Object.keys(record.pages)) {
        if (!keep.has(id) && !record.documents[id]) {
            delete record.pages[id];
            return true;
        }
    }
    return false;
}
