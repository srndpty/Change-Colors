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
 *    colors their own styles give them. The same rules, written around `:host`,
 *    are adopted by every shadow root.
 */
(function () {
    const CLEAR = 'data-changecolors-clear';
    const PROBE = 'data-changecolors-probe';
    // Anything this translucent reads as an overlay rather than a surface.
    const SOLID_ALPHA = 0.9;
    const FLUSH_DELAY = 100;
    const MAX_PER_FLUSH = 6000;

    if (window.__changeColorsAgent) {
        window.__changeColorsAgent.rescan();
        return;
    }

    let sheet = null;
    let sheetCss = '';
    const styledRoots = new Set();

    /* ------------------------------------------------------- shadow trees */

    function adopt(root) {
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

    /* ----------------------------------------------------- own background */

    function isSeeThrough(color) {
        const match = /^rgba?\(([^)]+)\)/.exec(color || '');
        if (!match) {
            return true;
        }
        const parts = match[1].split(/[,/]/);
        const alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
        return !(alpha >= SOLID_ALPHA);
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

    function collect(root, into, budget) {
        const elements = root.querySelectorAll('*');
        for (let i = 0; i < elements.length && into.length < budget; i++) {
            const element = elements[i];
            if (element !== document.documentElement && element !== document.body) {
                into.push(element);
            }
            if (element.shadowRoot) {
                adopt(element.shadowRoot);
                collect(element.shadowRoot, into, budget);
            }
        }
    }

    function scan(roots) {
        const elements = [];
        for (const root of roots) {
            if (root.isConnected === false) {
                continue;
            }
            if (root.nodeType === Node.ELEMENT_NODE &&
                    root !== document.documentElement && root !== document.body) {
                elements.push(root);
            }
            collect(root, elements, MAX_PER_FLUSH);
            if (elements.length >= MAX_PER_FLUSH) {
                break;
            }
        }
        measure(elements);
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
                // A class or style change is how a page repaints an element.
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
        // the first pass, and changes inside a shadow tree are invisible to the
        // observer above.
        window.addEventListener('load', rescan, {once: true});
        [500, 2000, 5000].forEach(function (delay) {
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
                    // Root is gone.
                }
                const style = root.querySelector && root.querySelector('style[data-changecolors]');
                if (style) {
                    style.remove();
                }
            });
            styledRoots.clear();
            document.querySelectorAll('[' + CLEAR + '],[' + PROBE + ']').forEach(function (element) {
                element.removeAttribute(CLEAR);
                element.removeAttribute(PROBE);
            });
            delete window.__changeColorsAgent;
        }
    };

    if (document.documentElement) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    }
})();
