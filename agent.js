/**
 * Runs in the page (isolated world) and does the two things a document
 * stylesheet cannot do on its own:
 *
 * 1. Styles shadow trees. A stylesheet injected in the document never crosses a
 *    shadow boundary, so components built with shadow DOM keep the colors their
 *    own styles give them - black text on the dark background we just painted.
 *    The same rules, rewritten around `:host`, are adopted by every shadow root.
 *
 * 2. Tags elements that carry a background image, because CSS has no selector
 *    for "has a background image". Without the tag, the headline and buttons a
 *    site draws inside a hero banner get an opaque background and hide it.
 */
(function () {
    const ATTRIBUTE = 'data-changecolors-bgimage';
    const MIN_AREA = 10000;
    const FLUSH_DELAY = 400;
    const MAX_PER_FLUSH = 5000;
    const LATE_RESCANS = [500, 2000, 5000];

    if (window.__changeColorsAgent) {
        window.__changeColorsAgent.rescan();
        return;
    }

    let sheet = null;
    let sheetCss = '';
    const styledRoots = new Set();

    /* ------------------------------------------------------- shadow trees */

    function adopt(root) {
        if (!sheet) {
            return;
        }
        try {
            if (root.adoptedStyleSheets.indexOf(sheet) === -1) {
                root.adoptedStyleSheets = root.adoptedStyleSheets.concat([sheet]);
            }
            styledRoots.add(root);
        } catch (e) {
            // Constructed stylesheets unavailable or refused: fall back to a
            // plain <style> element inside the shadow tree.
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
    }

    function setCss(css) {
        sheetCss = css;
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
        styledRoots.clear();
        rescan();
    }

    /* --------------------------------------------------- background images */

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

    /* ------------------------------------------------------------- walking */

    let budget = 0;

    function visit(element) {
        evaluate(element);
        if (element.shadowRoot) {
            adopt(element.shadowRoot);
            walk(element.shadowRoot);
        }
    }

    function walk(root) {
        const elements = root.querySelectorAll('*');
        for (let i = 0; i < elements.length && budget > 0; i++, budget--) {
            visit(elements[i]);
        }
    }

    function scan(roots) {
        budget = MAX_PER_FLUSH;
        for (const root of roots) {
            if (root.isConnected === false) {
                continue;
            }
            if (root.nodeType === Node.ELEMENT_NODE) {
                visit(root);
            }
            walk(root);
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

    function rescan() {
        if (document.documentElement) {
            schedule(document.documentElement);
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

    function start() {
        rescan();
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
        // Shadow roots are often attached, and backgrounds often applied, after
        // the first pass. The document observer does not see changes made
        // inside a shadow tree, so check back a few times while the page
        // settles.
        window.addEventListener('load', rescan, {once: true});
        LATE_RESCANS.forEach(function (delay) {
            setTimeout(rescan, delay);
        });
    }

    window.__changeColorsAgent = {
        setCss: setCss,
        rescan: rescan,
        stop: function () {
            observer.disconnect();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            styledRoots.forEach(function (root) {
                try {
                    root.adoptedStyleSheets = root.adoptedStyleSheets.filter(function (adopted) {
                        return adopted !== sheet;
                    });
                } catch (e) {
                    // Ignore roots we can no longer touch.
                }
                const style = root.querySelector && root.querySelector('style[data-changecolors]');
                if (style) {
                    style.remove();
                }
                if (root.querySelectorAll) {
                    root.querySelectorAll('[' + ATTRIBUTE + ']').forEach(function (element) {
                        element.removeAttribute(ATTRIBUTE);
                    });
                }
            });
            styledRoots.clear();
            document.querySelectorAll('[' + ATTRIBUTE + ']').forEach(function (element) {
                element.removeAttribute(ATTRIBUTE);
            });
            delete window.__changeColorsAgent;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    } else {
        start();
    }
})();
