/**
 * Runs in the page (isolated world) and does the two things a document
 * stylesheet cannot do on its own.
 *
 * 1. It gives back the elements that never had a background of their own. The
 *    stylesheet paints everything with the chosen background, which is what
 *    made sites unreadable in places: the transparent overlays a page stacks on
 *    top of its content - the ripple layer over a menu entry, the controls over
 *    a video, the headline over a hero banner - turned opaque and covered what
 *    was underneath. Each element is measured with the stylesheet held off for
 *    the length of the measurement, and the see-through ones are tagged so the
 *    stylesheet clears them again.
 *
 * 2. It styles shadow trees. A stylesheet injected in the document never
 *    crosses a shadow boundary, so components built with shadow DOM keep the
 *    colors, the font and the images their own styles give them. The same
 *    rules, written around `:host`, are adopted by every shadow root, and every
 *    shadow root found is watched for changes of its own - the document's
 *    observer cannot see inside one.
 *
 * Only the first job needs the page measured; a font-only override gets the
 * agent for its shadow trees and skips the measuring entirely.
 */
(function () {
    const CLEAR = 'data-changecolors-clear';
    const PROBE = 'data-changecolors-probe';
    // Anything this translucent reads as an overlay rather than a surface.
    const SOLID_ALPHA = 0.9;
    const FLUSH_DELAY = 100;
    // A flush walks at most this many elements; what is left over is picked up
    // by the next one, right away.
    const MAX_PER_FLUSH = 6000;
    const CONTINUE_DELAY = 16;

    const OBSERVED = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'style']
    };

    if (window.__changeColorsAgent) {
        window.__changeColorsAgent.rescan();
        return;
    }

    let sheet = null;
    let sheetCss = '';
    // Set by stop(). The delayed rescans below outlive it, and an agent that
    // has been stopped must not tag anything again - the page may have been
    // handed to a new agent in the meantime.
    let stopped = false;
    // Whether the stylesheet paints backgrounds, and elements therefore have to
    // be measured.
    let measuring = true;
    // Every shadow root the stylesheet was put into, for the whole life of the
    // agent: stop() has to be able to take it out of all of them, including the
    // ones found before the last setCss().
    const styledRoots = new Set();
    const observedRoots = new Set();
    // Timers of the delayed rescans, so stop() can cancel them.
    const delayed = [];

    /* ------------------------------------------------------- shadow trees */

    function adopt(root) {
        observeRoot(root);
        try {
            if (sheet) {
                if (root.adoptedStyleSheets.indexOf(sheet) === -1) {
                    root.adoptedStyleSheets = root.adoptedStyleSheets.concat([sheet]);
                }
                styledRoots.add(root);
                return;
            }
        } catch (e) {
            // Constructed stylesheets refused; fall through to a <style> tag.
        }
        let style = root.querySelector('style[data-changecolors]');
        if (!style) {
            style = document.createElement('style');
            style.setAttribute('data-changecolors', '');
            root.appendChild(style);
        }
        if (style.textContent !== sheetCss) {
            style.textContent = sheetCss;
        }
        styledRoots.add(root);
    }

    /**
     * A shadow tree's changes are invisible to an observer watching the
     * document, so each root found gets watched itself. That covers a component
     * rendering its content after it is attached, which the periodic rescans
     * below only caught while they lasted.
     */
    function observeRoot(root) {
        if (observedRoots.has(root)) {
            return;
        }
        try {
            observer.observe(root, OBSERVED);
            observedRoots.add(root);
        } catch (e) {
            // Root is gone.
        }
    }

    function setCss(css, measure) {
        sheetCss = css;
        measuring = measure !== false;
        if (!sheet) {
            try {
                sheet = new CSSStyleSheet();
            } catch (e) {
                sheet = null;
            }
        }
        if (sheet) {
            try {
                sheet.replaceSync(css);
            } catch (e) {
                sheet = null;
            }
        }
        // The roots that already have this stylesheet keep it: it is the same
        // CSSStyleSheet object, and replaceSync() has just given it the new
        // rules. The inventory is not cleared, because it is what stop() undoes
        // the styling from.
        rescan();
    }

    /* ----------------------------------------------------- own background */

    /**
     * The alpha of a computed color.
     *
     * getComputedStyle() serializes a color in the syntax it was written in, so
     * a site using `oklch()`, `lab()` or `color()` - all of them ordinary CSS
     * now - does not come back as `rgb()`. Every one of those puts the alpha
     * last, after a slash; only the legacy comma syntax of rgba() and hsla()
     * puts it fourth in the list. Anything unrecognised counts as opaque, which
     * paints the element rather than leaving it see-through: the same fallback
     * the stylesheet itself takes.
     */
    function alphaOf(color) {
        const text = String(color || '').trim();
        if (!text) {
            return 1;
        }
        if (text === 'transparent') {
            return 0;
        }
        const match = /^[a-z-]+\(([^)]*)\)$/i.exec(text);
        if (!match) {
            return 1;
        }
        const body = match[1];
        const slash = body.indexOf('/');
        let alpha = slash === -1 ? null : body.slice(slash + 1);
        if (alpha === null) {
            const parts = body.split(',');
            alpha = parts.length > 3 ? parts[3] : null;
        }
        if (alpha === null) {
            return 1;
        }
        alpha = alpha.trim();
        // `none` is CSS Color 4 for "no alpha component", which renders opaque.
        const value = alpha === 'none' ? 1 : parseFloat(alpha);
        if (!isFinite(value)) {
            return 1;
        }
        return alpha.endsWith('%') ? value / 100 : value;
    }

    function isSeeThrough(color) {
        return !(alphaOf(color) >= SOLID_ALPHA);
    }

    /**
     * Measures a batch in three steps so the browser only recalculates styles
     * once per step: tag everything as being probed (which takes our own
     * background rules out of the cascade), read what the site asks for, then
     * apply the verdicts. No paint happens in between, so nothing flickers.
     */
    function measure(elements) {
        if (!elements.length) {
            return;
        }
        for (const element of elements) {
            element.setAttribute(PROBE, '');
        }
        const seeThrough = elements.map(function (element) {
            return isSeeThrough(window.getComputedStyle(element).backgroundColor);
        });
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            element.removeAttribute(PROBE);
            if (seeThrough[i]) {
                if (!element.hasAttribute(CLEAR)) {
                    element.setAttribute(CLEAR, '');
                }
            } else if (element.hasAttribute(CLEAR)) {
                element.removeAttribute(CLEAR);
            }
        }
    }

    /* ------------------------------------------------------------- walking */

    function want(element, batch, seen) {
        if (element === document.documentElement || element === document.body) {
            return;
        }
        if (seen.has(element) || !element.isConnected) {
            return;
        }
        seen.add(element);
        batch.push(element);
    }

    // Subtrees to walk (new content, or a subtree whose styling may have
    // changed), and single elements to re-check.
    const pendingRoots = new Set();
    const pendingElements = new Set();
    // Walks left unfinished by a flush that ran out of budget, and the roots
    // they belong to: a root already being walked is not queued a second time.
    // A page that keeps changing a class on a big container would otherwise
    // stack up a full walk of that container per change, faster than they can
    // be worked off.
    const walks = [];
    const walking = new Map();
    let timer = null;

    function queueWalk(root) {
        const already = walking.get(root);
        if (already) {
            // Something in it changed while it was being walked; go round once
            // more when this pass is done, however many changes there were.
            already.again = true;
            return;
        }
        const walk = {
            root: root,
            walker: document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT),
            started: false,
            again: false
        };
        walking.set(root, walk);
        walks.push(walk);
    }

    function finishWalk(walk) {
        walks.shift();
        if (walk.again && walk.root.isConnected !== false) {
            walk.walker = document.createTreeWalker(walk.root, NodeFilter.SHOW_ELEMENT);
            walk.started = false;
            walk.again = false;
            walks.push(walk);
            return;
        }
        walking.delete(walk.root);
    }

    /**
     * Measures and styles what is pending, up to MAX_PER_FLUSH elements -
     * counting the elements a page restyled one by one, not only the ones
     * walked. Nothing is dropped for being over the limit: unfinished walks
     * keep their place and the rest of the elements keep theirs, and the next
     * flush follows straight after. That is what keeps the deep DOM of a site
     * like YouTube or Twitch measured all the way down without a busy page
     * being able to hand the agent unbounded work in one go.
     */
    function flush() {
        timer = null;
        const batch = [];
        const seen = new Set();
        let budget = MAX_PER_FLUSH;

        function handle(element) {
            budget--;
            if (element.shadowRoot) {
                adopt(element.shadowRoot);
                queueWalk(element.shadowRoot);
            }
            if (measuring) {
                want(element, batch, seen);
            }
        }

        const later = [];
        pendingElements.forEach(function (element) {
            if (budget <= 0) {
                later.push(element);
                return;
            }
            budget--;
            // Checked here as well, because a component can attach its shadow
            // root long after the rescans below have stopped.
            if (element.shadowRoot && !observedRoots.has(element.shadowRoot)) {
                adopt(element.shadowRoot);
                queueWalk(element.shadowRoot);
            }
            if (measuring) {
                want(element, batch, seen);
            }
        });
        pendingElements.clear();
        for (const element of later) {
            pendingElements.add(element);
        }

        pendingRoots.forEach(function (root) {
            if (root.isConnected !== false) {
                queueWalk(root);
            }
        });
        pendingRoots.clear();

        while (walks.length && budget > 0) {
            const walk = walks[0];
            if (!walk.started) {
                walk.started = true;
                if (walk.root.nodeType === Node.ELEMENT_NODE) {
                    handle(walk.root);
                }
            }
            let node = null;
            while (budget > 0 && (node = walk.walker.nextNode())) {
                handle(node);
            }
            if (budget > 0) {
                finishWalk(walk);
            }
        }

        measure(batch);

        if (walks.length || pendingElements.size) {
            timer = setTimeout(flush, CONTINUE_DELAY);
        }
    }

    function wake() {
        if (stopped) {
            return;
        }
        if (timer === null) {
            timer = setTimeout(flush, FLUSH_DELAY);
        }
    }

    function scheduleSubtree(root) {
        pendingRoots.add(root);
        wake();
    }

    function scheduleElement(element) {
        pendingElements.add(element);
        wake();
    }

    function rescan() {
        if (stopped) {
            return;
        }
        if (document.documentElement) {
            scheduleSubtree(document.documentElement);
        }
    }

    /**
     * Returns the inline declarations that can alter a background. Comparing
     * these lets us ignore animation-frame updates to unrelated properties
     * such as a volume slider's width. Custom properties are included because
     * a background declaration may refer to one with var().
     */
    function inlineBackground(cssText) {
        return String(cssText || '').split(';').map(function (declaration) {
            const colon = declaration.indexOf(':');
            if (colon === -1) {
                return '';
            }
            const property = declaration.slice(0, colon).trim().toLowerCase();
            return property === 'background' || property.indexOf('background-') === 0 ||
                    property.indexOf('--') === 0 ? declaration.trim() : '';
        }).filter(Boolean).sort().join(';');
    }

    const observer = new MutationObserver(function (records) {
        for (const record of records) {
            if (record.type === 'childList') {
                record.addedNodes.forEach(function (node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        scheduleSubtree(node);
                    }
                });
                continue;
            }
            if (!measuring || record.target.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }
            if (record.attributeName === 'style') {
                const before = inlineBackground(record.oldValue);
                const after = inlineBackground(record.target.getAttribute('style'));
                // Inline styles change every frame on things like a volume
                // slider or a progress bar. Ignore those unless a background
                // declaration (or a custom property it can use) changed.
                if (before === after) {
                    continue;
                }
                // A custom property is inherited, so a descendant's background
                // can be built from the one that just changed.
                if (before.indexOf('--') !== -1 || after.indexOf('--') !== -1) {
                    scheduleSubtree(record.target);
                    continue;
                }
                scheduleElement(record.target);
                continue;
            }
            // A class change usually brings a background with it, and rules
            // like `.dark .card {...}` mean it brings one to the subtree as
            // well - a theme switch or an expanding menu would otherwise leave
            // stale verdicts behind. The walk is bounded per flush, so a large
            // subtree costs time rather than responsiveness.
            scheduleSubtree(record.target);
        }
    });

    function start() {
        if (stopped) {
            // Stopped before the document was ready enough to start on.
            return;
        }
        rescan();
        observer.observe(document.documentElement, OBSERVED);
        // Shadow roots are often attached, and backgrounds often applied, after
        // the first pass. Each root found is watched from then on; these
        // rescans are what finds the ones attached later.
        window.addEventListener('load', rescan, {once: true});
        [500, 2000, 5000].forEach(function (delay) {
            delayed.push(setTimeout(rescan, delay));
        });
    }

    function cleanAttributes(root) {
        if (!root || !root.querySelectorAll) {
            return;
        }
        root.querySelectorAll('[' + CLEAR + '],[' + PROBE + ']').forEach(function (element) {
            element.removeAttribute(CLEAR);
            element.removeAttribute(PROBE);
        });
    }

    window.__changeColorsAgent = {
        setCss: setCss,
        rescan: rescan,
        stop: function () {
            stopped = true;
            observer.disconnect();
            window.removeEventListener('load', rescan);
            document.removeEventListener('DOMContentLoaded', start);
            delayed.forEach(clearTimeout);
            delayed.length = 0;
            walks.length = 0;
            walking.clear();
            pendingRoots.clear();
            pendingElements.clear();
            observedRoots.clear();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            walks.length = 0;
            pendingRoots.clear();
            pendingElements.clear();
            styledRoots.forEach(function (root) {
                try {
                    root.adoptedStyleSheets = root.adoptedStyleSheets.filter(function (adopted) {
                        return adopted !== sheet;
                    });
                } catch (e) {
                    // Root is gone.
                }
                const style = root.querySelector && root.querySelector('style[data-changecolors]');
                if (style) {
                    style.remove();
                }
                // Tags set inside a shadow tree are out of the document's reach.
                cleanAttributes(root);
            });
            styledRoots.clear();
            cleanAttributes(document);
            delete window.__changeColorsAgent;
        }
    };

    if (document.documentElement) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    }
})();
