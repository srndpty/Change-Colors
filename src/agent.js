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
    const GRADIENT = 'data-changecolors-gradient';
    const BACKGROUND_IMAGE = '--changecolors-background-image';
    const GRADIENT_TARGETS = ['', 'before', 'after'].map(function (pseudo) {
        return {
            pseudo: pseudo ? '::' + pseudo : null,
            attribute: GRADIENT + (pseudo ? '-' + pseudo : ''),
            property: BACKGROUND_IMAGE + (pseudo ? '-' + pseudo : '')
        };
    });
    const GRADIENT_SELECTOR = GRADIENT_TARGETS.map(
        (target) => '[' + target.attribute + ']'
    ).join(',');

    // Split only top-level commas: URLs and gradient arguments may contain commas.
    function withoutGradients(image) {
        const layers = [];
        let start = 0,
            depth = 0,
            quote = '';
        for (let i = 0; i < image.length; i++) {
            const char = image[i];
            if (char === '\\') {
                i++;
                continue;
            }
            if (quote) {
                if (char === quote) quote = '';
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }
            if (char === '(') depth++;
            if (char === ')') depth--;
            if (char === ',' && depth === 0) {
                layers.push(image.slice(start, i).trim());
                start = i + 1;
            }
        }
        layers.push(image.slice(start).trim());
        let changed = false;
        const filtered = layers.map(function (layer) {
            if (
                /^(?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(
                    layer
                )
            ) {
                changed = true;
                return 'none';
            }
            return layer;
        });
        return changed ? filtered.join(', ') : null;
    }
    // Anything this translucent reads as an overlay rather than a surface.
    const SOLID_ALPHA = 0.9;
    const FLUSH_DELAY = 100;
    // A flush walks at most this many elements; what is left over is picked up
    // by the next one, right away.
    const MAX_PER_FLUSH = 6000;
    // And holds at most this many subtrees waiting to be walked, taking on at
    // most this many more in one go. Without a limit on the queue itself, a page
    // that adds tens of thousands of separate subtrees at once would have a tree
    // walker alive for every one of them before the first was walked: bounding
    // the work of a flush is not the same as bounding what is waiting.
    const MAX_QUEUED_WALKS = 4000;
    const MAX_ROOTS_PER_FLUSH = 1000;
    // How many of the shadow trees already styled a flush looks over for ones
    // that have been taken out of the page. Bounded like everything else: a
    // flush must not cost the length of the inventory.
    const MAX_ROOTS_PRUNED_PER_FLUSH = 200;
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
    let overrideGradients = false;
    // Every shadow root the stylesheet is in, and the observer watching each of
    // them: stop() has to be able to take the stylesheet out of all of them,
    // including the ones found before the last setCss(), and both of these
    // hold the tree they name alive.
    //
    // Which is why a root taken out of the page is let go of here as well - see
    // forget(). A component rebuilt on every render, which is what a long-lived
    // single page application does all day, would otherwise leave the agent
    // holding every host it ever styled and the whole subtree under each. The
    // observer is per root rather than one for all of them for that reason
    // alone: one observer cannot be told to stop watching a single target.
    const styledRoots = new Set();
    const observedRoots = new Map();
    // Timers of the delayed rescans, so stop() can cancel them.
    const delayed = [];

    /* ------------------------------------------------------- shadow trees */

    function adopt(root) {
        observeRoot(root);
        try {
            if (sheet) {
                if (root.adoptedStyleSheets.indexOf(sheet) === -1) {
                    root.adoptedStyleSheets = root.adoptedStyleSheets.concat([
                        sheet
                    ]);
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
            const rootObserver = new MutationObserver(onMutations);
            rootObserver.observe(root, OBSERVED);
            observedRoots.set(root, rootObserver);
        } catch (e) {
            // Root is gone.
        }
    }

    /**
     * Whether a shadow tree is still part of *this* page.
     *
     * Connected is not enough on its own. A host moved into another document -
     * adoptNode(), or an <iframe> taking a subtree - stays connected there, and
     * this agent, which belongs to the document it was injected in, must let go
     * of it: the agent in that document is the one that styles it now. Hence
     * the walk up from the root through however many shadow boundaries it sits
     * behind, which is what `composed` does.
     */
    function isAttached(root) {
        const host = root && root.host;
        if (!host || !host.isConnected || host.ownerDocument !== document) {
            return false;
        }
        return host.getRootNode({ composed: true }) === document;
    }

    /**
     * Takes the stylesheet out of a shadow tree and lets go of it: its
     * observer, its place in the inventory, and through those the tree itself.
     *
     * A tree that comes back is not lost by this. It comes back through its
     * host, which the document's observer sees being added, and adopt() puts
     * everything back - including the measuring, which is the only thing that
     * can be stale by then.
     */
    /** Takes everything this agent put into a shadow tree back out of it. */
    function unstyle(root) {
        try {
            root.adoptedStyleSheets = root.adoptedStyleSheets.filter(
                function (adopted) {
                    return adopted !== sheet;
                }
            );
        } catch (e) {
            // Root is gone.
        }
        const style =
            root.querySelector &&
            root.querySelector('style[data-changecolors]');
        if (style) {
            style.remove();
        }
        // Tags set inside a shadow tree are out of the document's reach.
        cleanAttributes(root);
    }

    function forget(root) {
        const rootObserver = observedRoots.get(root);
        if (rootObserver) {
            rootObserver.disconnect();
            observedRoots.delete(root);
        }
        unstyle(root);
        styledRoots.delete(root);
    }

    // Where the sweep for detached trees got to, and whether one is wanted. A
    // Set iterator sees what is added while it is alive, and deleting through
    // it is safe, so it is kept between flushes rather than the inventory being
    // copied out each time.
    //
    // A sweep is asked for by something being taken out of the page, and lasts
    // one pass over the inventory. Sweeping only then is what keeps this from
    // being a cost the agent pays for ever: a page that removes nothing has
    // nothing to let go of.
    let sweep = null;
    let sweeping = false;
    let requested = false;
    let forgotten = 0;

    /** Something left the page, so the inventory has to be looked over again. */
    function requestSweep() {
        requested = true;
        sweeping = true;
        wake();
    }

    function pruneDetachedRoots() {
        for (let i = 0; i < MAX_ROOTS_PRUNED_PER_FLUSH; i++) {
            if (!sweep) {
                sweep = styledRoots.values();
                forgotten = 0;
                // Everything asked for so far is what this pass is answering.
                // What is asked for after this point is not: a tree the pass
                // has already walked past can be taken out of the page a moment
                // later, and only another pass will see that.
                requested = false;
            }
            const next = sweep.next();
            if (next.done) {
                // The end of a walk is not the end of the inventory. Taking
                // entries out of a Set while walking it can cut the walk short
                // - the browser is free to rebuild the table underneath it, and
                // Chrome does once enough has been taken out - so a pass that
                // let go of anything is followed by another. So is one that was
                // overtaken by a removal. Only a whole pass that let go of
                // nothing, with nothing asked for while it ran, ends the sweep.
                // Each pass costs what one costs: the same few hundred a flush.
                sweep = null;
                sweeping = forgotten > 0 || requested;
                return;
            }
            if (!isAttached(next.value)) {
                forget(next.value);
                forgotten++;
            }
        }
    }

    function setCss(css, measure, gradients) {
        sheetCss = css;
        measuring = measure !== false;
        overrideGradients = measuring && gradients === true;
        if (!overrideGradients) {
            document.querySelectorAll(GRADIENT_SELECTOR).forEach(clearGradient);
            for (const root of styledRoots)
                root.querySelectorAll(GRADIENT_SELECTOR).forEach(clearGradient);
        }
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
        const backgrounds = elements.map(function (element) {
            const style = window.getComputedStyle(element);
            return {
                clear: isSeeThrough(style.backgroundColor),
                image: overrideGradients
                    ? withoutGradients(style.backgroundImage)
                    : null,
                pseudoImages: GRADIENT_TARGETS.slice(1).map((target) =>
                    overrideGradients
                        ? withoutGradients(
                              window.getComputedStyle(element, target.pseudo)
                                  .backgroundImage
                          )
                        : null
                )
            };
        });
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            element.removeAttribute(PROBE);
            const background = backgrounds[i];
            const images = [background.image, ...background.pseudoImages];
            for (let j = 0; j < GRADIENT_TARGETS.length; j++) {
                const target = GRADIENT_TARGETS[j];
                if (images[j] !== null) {
                    element.style.setProperty(target.property, images[j]);
                    element.setAttribute(target.attribute, '');
                } else if (element.hasAttribute(target.attribute)) {
                    element.style.removeProperty(target.property);
                    element.removeAttribute(target.attribute);
                }
            }
            if (
                element === document.documentElement ||
                element === document.body
            )
                continue;
            if (background.clear && background.image === null) {
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
    // The high water marks of what a flush takes on, kept where the work happens
    // rather than sampled from outside: a flush runs to completion, so nothing
    // outside can see the middle of one.
    //
    // `seen` counts what the draining loops looked at, which is what says the
    // waiting is left where it waits: taking six thousand elements out of a
    // million costs the same as taking six thousand out of six thousand only if
    // the other nine hundred and ninety four thousand are never touched.
    const stats = {
        maxWalks: 0,
        maxRootsFromPending: 0,
        maxRootsSeen: 0,
        maxElementsTaken: 0,
        maxElementsSeen: 0
    };

    function resetStats() {
        for (const key of Object.keys(stats)) {
            stats[key] = 0;
        }
    }

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
        const whole = walking.get(document.documentElement);
        if (whole && !whole.started && root !== document.documentElement) {
            // A walk of the whole document is queued and has not begun; it will
            // reach this subtree on its way through.
            return;
        }
        if (walks.length >= MAX_QUEUED_WALKS) {
            // The queue is as long as it is allowed to get. Nothing is dropped:
            // it waits where the roots waiting to be taken on wait, and is taken
            // on when there is room. Every way in comes through here, shadow
            // roots found while walking included, so this is the only place the
            // limit has to hold.
            pendingRoots.add(root);
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
        stats.maxWalks = Math.max(stats.maxWalks, walks.length);
    }

    function finishWalk(walk) {
        walks.shift();
        if (walk.again && walk.root.isConnected !== false) {
            walk.walker = document.createTreeWalker(
                walk.root,
                NodeFilter.SHOW_ELEMENT
            );
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

        // Drained where they sit: the ones not reached stay in the set, which
        // is the work being avoided. Copying the remainder out and back would
        // be the cost this is meant to bound.
        let elementsTaken = 0;
        let elementsSeen = 0;
        for (const element of pendingElements) {
            elementsSeen++;
            if (budget <= 0) {
                break;
            }
            pendingElements.delete(element);
            budget--;
            elementsTaken++;
            // Checked here as well, because a component can attach its shadow
            // root long after the rescans below have stopped.
            if (element.shadowRoot && !observedRoots.has(element.shadowRoot)) {
                adopt(element.shadowRoot);
                queueWalk(element.shadowRoot);
            }
            if (measuring) {
                want(element, batch, seen);
            }
        }
        stats.maxElementsTaken = Math.max(
            stats.maxElementsTaken,
            elementsTaken
        );
        stats.maxElementsSeen = Math.max(stats.maxElementsSeen, elementsSeen);

        // Taking a root on costs a tree walker and a place in the queue, so this
        // is bounded like everything else: a page that adds thousands of
        // separate subtrees at once has them taken on over several flushes. The
        // ones not reached are left in the set exactly where they are - looking
        // at them at all is the work being avoided.
        let intake = MAX_ROOTS_PER_FLUSH;
        let rootsTaken = 0;
        let rootsSeen = 0;
        for (const root of pendingRoots) {
            rootsSeen++;
            if (
                intake <= 0 ||
                budget <= 0 ||
                walks.length >= MAX_QUEUED_WALKS
            ) {
                break;
            }
            pendingRoots.delete(root);
            intake--;
            budget--;
            rootsTaken++;
            if (root.isConnected !== false) {
                queueWalk(root);
            }
        }
        stats.maxRootsFromPending = Math.max(
            stats.maxRootsFromPending,
            rootsTaken
        );
        stats.maxRootsSeen = Math.max(stats.maxRootsSeen, rootsSeen);

        while (walks.length && budget > 0) {
            const walk = walks[0];
            if (!walk.started) {
                walk.started = true;
                if (walk.root.nodeType === Node.ELEMENT_NODE) {
                    handle(walk.root);
                }
            }
            let node;
            while (budget > 0 && (node = walk.walker.nextNode())) {
                handle(node);
            }
            if (budget > 0) {
                finishWalk(walk);
            }
        }

        measure(batch);
        if (sweeping) {
            pruneDetachedRoots();
        }

        if (
            walks.length ||
            pendingElements.size ||
            pendingRoots.size ||
            sweeping
        ) {
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
        return String(cssText || '')
            .split(';')
            .map(function (declaration) {
                const colon = declaration.indexOf(':');
                if (colon === -1) {
                    return '';
                }
                const property = declaration
                    .slice(0, colon)
                    .trim()
                    .toLowerCase();
                if (
                    GRADIENT_TARGETS.some(
                        (target) => property === target.property
                    )
                )
                    return '';
                return property === 'background' ||
                    property.indexOf('background-') === 0 ||
                    property.indexOf('--') === 0
                    ? declaration.trim()
                    : '';
            })
            .filter(Boolean)
            .sort()
            .join(';');
    }

    function onMutations(records) {
        for (const record of records) {
            if (record.type === 'childList') {
                record.addedNodes.forEach(function (node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        scheduleSubtree(node);
                    }
                });
                if (record.removedNodes.length) {
                    // Something left the page, so a shadow tree this agent is
                    // holding may have gone with it. The removed nodes
                    // themselves are not enough to tell - the host can be
                    // anywhere under one - so what follows is a pass over the
                    // inventory, spread over flushes.
                    requestSweep();
                }
                continue;
            }
            if (!measuring || record.target.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }
            if (record.attributeName === 'style') {
                const before = inlineBackground(record.oldValue);
                const after = inlineBackground(
                    record.target.getAttribute('style')
                );
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
    }

    // The document's own observer. Shadow trees get one each, in observeRoot().
    const observer = new MutationObserver(onMutations);

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
        window.addEventListener('load', rescan, { once: true });
        [500, 2000, 5000].forEach(function (delay) {
            delayed.push(setTimeout(rescan, delay));
        });
    }

    function cleanAttributes(root) {
        if (!root || !root.querySelectorAll) {
            return;
        }
        root.querySelectorAll(
            '[' + CLEAR + '],[' + PROBE + '],' + GRADIENT_SELECTOR
        ).forEach(function (element) {
            element.removeAttribute(CLEAR);
            element.removeAttribute(PROBE);
            clearGradient(element);
        });
    }

    function clearGradient(element) {
        for (const target of GRADIENT_TARGETS) {
            if (element.hasAttribute(target.attribute))
                element.style.removeProperty(target.property);
            element.removeAttribute(target.attribute);
        }
    }

    window.__changeColorsAgent = {
        setCss: setCss,
        rescan: rescan,
        /**
         * What is still waiting, and the most any one flush has taken on or
         * looked at. The limits are the point of it: nothing outside can watch
         * a flush, which runs to completion, so the marks are kept as it goes.
         * `reset` clears them, for asking the same questions of what happens
         * next.
         *
         * `maxRootsFromPending` counts subtrees taken off the waiting list. A
         * shadow root found while walking goes straight into the queue instead,
         * which `maxWalks` is what bounds.
         */
        pending: function (reset) {
            const answer = {
                roots: pendingRoots.size,
                elements: pendingElements.size,
                walks: walks.length,
                // What the agent is holding on to rather than what is waiting:
                // a shadow tree taken out of the page is held by both of these
                // until a flush notices and lets go of it.
                styledRoots: styledRoots.size,
                observedRoots: observedRoots.size,
                sweeping: sweeping,
                maxWalks: stats.maxWalks,
                maxRootsFromPending: stats.maxRootsFromPending,
                maxRootsSeen: stats.maxRootsSeen,
                maxElementsTaken: stats.maxElementsTaken,
                maxElementsSeen: stats.maxElementsSeen,
                limits: {
                    perFlush: MAX_PER_FLUSH,
                    queuedWalks: MAX_QUEUED_WALKS,
                    rootsPerFlush: MAX_ROOTS_PER_FLUSH
                }
            };
            if (reset) {
                resetStats();
            }
            return answer;
        },
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
            observedRoots.forEach(function (rootObserver) {
                rootObserver.disconnect();
            });
            observedRoots.clear();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            styledRoots.forEach(unstyle);
            styledRoots.clear();
            sweep = null;
            sweeping = false;
            requested = false;
            cleanAttributes(document);
            delete window.__changeColorsAgent;
        }
    };

    if (document.documentElement) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    }
})();
