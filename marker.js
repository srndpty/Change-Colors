/**
 * Marks elements that carry a real background image so the stylesheet can keep
 * them - and everything drawn inside them - transparent.
 *
 * CSS has no way to select "an element with a background image", but painting
 * an opaque background on the text sitting on top of a hero banner is exactly
 * what makes the banner look like a dark box. This runs in the isolated world,
 * so the attribute it sets is the only thing the page ever sees.
 */
(function () {
    const ATTRIBUTE = 'data-changecolors-bgimage';
    const MIN_AREA = 10000;
    const FLUSH_DELAY = 400;
    const MAX_PER_FLUSH = 5000;

    if (window.__changeColorsMarker) {
        window.__changeColorsMarker.rescan();
        return;
    }

    /**
     * Only backgrounds that behave like a picture qualify. Data-URI backgrounds
     * are skipped because they are almost always lazy-loading placeholders, and
     * a background taller than the viewport is the page backdrop rather than a
     * banner - clearing everything inside that would undo the styling.
     */
    function carriesBackgroundImage(element) {
        if (element === document.documentElement || element === document.body) {
            return false;
        }
        const style = window.getComputedStyle(element);
        const image = style.backgroundImage;
        if (!image || image.indexOf('url(') === -1) {
            return false;
        }
        if (image.indexOf('url("data:') !== -1 || image.indexOf('url(data:') !== -1) {
            return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width * rect.height < MIN_AREA) {
            return false;
        }
        return rect.height <= window.innerHeight * 1.5;
    }

    function evaluate(element) {
        const marked = element.hasAttribute(ATTRIBUTE);
        const wanted = carriesBackgroundImage(element);
        if (wanted && !marked) {
            element.setAttribute(ATTRIBUTE, '');
        } else if (!wanted && marked) {
            element.removeAttribute(ATTRIBUTE);
        }
    }

    function scan(roots) {
        let budget = MAX_PER_FLUSH;
        for (const root of roots) {
            if (!root.isConnected) {
                continue;
            }
            evaluate(root);
            const descendants = root.querySelectorAll('*');
            for (let i = 0; i < descendants.length && budget > 0; i++, budget--) {
                evaluate(descendants[i]);
            }
            if (budget <= 0) {
                return;
            }
        }
    }

    const pending = new Set();
    let timer = null;

    function flush() {
        timer = null;
        const roots = Array.from(pending);
        pending.clear();
        scan(roots);
    }

    function schedule(root) {
        pending.add(root);
        if (timer === null) {
            timer = setTimeout(flush, FLUSH_DELAY);
        }
    }

    const observer = new MutationObserver(function (records) {
        for (const record of records) {
            if (record.type === 'childList') {
                record.addedNodes.forEach(function (node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        schedule(node);
                    }
                });
            } else if (record.target.nodeType === Node.ELEMENT_NODE) {
                // A class or style change is how lazily loaded banners arrive.
                schedule(record.target);
            }
        }
    });

    function rescan() {
        if (document.documentElement) {
            schedule(document.documentElement);
        }
    }

    function start() {
        scan([document.documentElement]);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
        // Backgrounds often appear as the page settles or as images decode.
        window.addEventListener('load', rescan, {once: true});
    }

    window.__changeColorsMarker = {
        rescan: rescan,
        stop: function () {
            observer.disconnect();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            document.querySelectorAll('[' + ATTRIBUTE + ']').forEach(function (element) {
                element.removeAttribute(ATTRIBUTE);
            });
            delete window.__changeColorsMarker;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    } else {
        start();
    }
})();
