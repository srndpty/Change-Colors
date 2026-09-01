/**
 * Stylesheet generation.
 *
 * Two things shape these rules.
 *
 * The stylesheet is generated twice: once for the document, and once for shadow
 * roots, because a document stylesheet does not cross a shadow boundary and
 * components built with shadow DOM would keep their own colors. Both come from
 * one set of rules through a "scope" - the document scope anchors everything at
 * `html > body`, the shadow scope at `:host`.
 *
 * And the opaque background is painted on everything, then taken back off the
 * elements that never had one. Sites stack transparent elements on top of their
 * content - ripple overlays on a menu entry, the controls over a video, the
 * headline over a hero banner - and painting those opaque hides what is below.
 * agent.js measures each element's own background and tags the see-through ones
 * so `[data-changecolors-clear]` can restore them. Painting first and clearing
 * afterwards keeps the page readable even if the agent never gets to run.
 */

/** Set by agent.js on elements whose own background is see-through. */
export const CLEAR_ATTRIBUTE = 'data-changecolors-clear';

/**
 * Set by agent.js while it measures an element, to read the background the site
 * asks for rather than the one we just painted.
 */
export const PROBE_ATTRIBUTE = 'data-changecolors-probe';

const NOT_PROBED = ':not([' + PROBE_ATTRIBUTE + '])';

const DOCUMENT_SCOPE = {root: 'html > body', prefix: 'html > body ', host: null};
const SHADOW_SCOPE = {root: ':host', prefix: '', host: ':host'};

/**
 * Specificity padding.
 *
 * Sites use `!important` themselves, and on an id or class selector their
 * declaration beats ours - that is how a component keeps its black text on our
 * dark background. `:not(#id)` matches everything while counting as an id, so
 * it lifts our rules above anything a page is likely to declare without
 * changing what they match. Rules that have to win against our own base rule
 * get one level more.
 */
const BOOST = ':not(#changecolors-a):not(#changecolors-b):not(#changecolors-c)';
const BOOST_OVER_BASE = BOOST + ':not(#changecolors-d)';

/**
 * Quotes a font family name for CSS. Settings saved by older versions already
 * contain the surrounding single quotes, so they are stripped first.
 */
export function cssFontFamily(name) {
    const clean = String(name || 'Arial').trim().replace(/^['"]|['"]$/g, '').replace(/["\\;{}]/g, '');
    return '"' + clean + '", sans-serif';
}

function prefixed(scope, selectors, boost) {
    return selectors.map(function (selector) {
        return scope.prefix + selector + (boost || BOOST);
    }).join(',');
}

/**
 * Selectors that must stay transparent so playing media remains visible, even
 * on a page where agent.js could not run.
 */
function mediaGuard(scope) {
    const selectors = ['video', 'audio'];
    let path = '> video';
    for (let depth = 0; depth < 4; depth++) {
        selectors.push('*:has(' + path + ')', '*:has(' + path + ') *');
        path = '> * ' + path;
    }
    return prefixed(scope, selectors, BOOST_OVER_BASE);
}

/** Elements agent.js found to have no background of their own. */
function clearedSelectors(scope) {
    let css = prefixed(scope, ['[' + CLEAR_ATTRIBUTE + ']' + NOT_PROBED], BOOST_OVER_BASE);
    if (scope.host) {
        css += ',:host([' + CLEAR_ATTRIBUTE + '])' + NOT_PROBED + BOOST_OVER_BASE;
    }
    return css;
}

function linkSelectors(scope, state) {
    return prefixed(scope, [
        'a:' + state, 'a:' + state + ' *',
        'a:' + state + ':hover', 'a:' + state + ':hover *',
        'a:' + state + ':active', 'a:' + state + ':active *'
    ], BOOST_OVER_BASE);
}

function build(settings, scope) {
    // The page frame always keeps the chosen background; only elements inside it
    // can be cleared again.
    const frame = scope.root + BOOST;
    const inside = scope.prefix + '*' + NOT_PROBED + BOOST;
    let css = '';

    if (!settings.DefaultBrowserColor) {
        css += frame + ',' + inside + '{' +
            'background-color: #' + settings.background_color + ' !important;' +
            'color: #' + settings.text_color + ' !important;' +
            'text-shadow: none !important;' +
            '-webkit-text-fill-color: currentcolor !important;}' +
            clearedSelectors(scope) + '{background-color: transparent !important;}' +
            linkSelectors(scope, 'link') + '{color: #' + settings.links_color + ' !important;}' +
            linkSelectors(scope, 'visited') + '{color: #' + settings.visited_links_color + ' !important;}' +
            mediaGuard(scope) + '{background-color: transparent !important;}';
    }

    if (!settings.DefaultBrowserFont) {
        const fontSize = parseInt(settings.FontSize, 10) || 0;
        css += scope.root + BOOST + ',' + scope.prefix + '*' + BOOST + '{' +
            'line-height: normal !important;' +
            'font-family: ' + cssFontFamily(settings.OverrideFontName) + ' !important;' +
            (fontSize !== 0 ? 'font-size: ' + fontSize + 'pt !important;' : '') +
            '}';
    }

    if (!settings.ShowImage) {
        // Hiding images covers CSS backgrounds too, otherwise hero banners and
        // other decorative images would survive as element backgrounds.
        // Clickable elements keep theirs, because that is often the only thing
        // marking a button or an icon.
        css += prefixed(scope, ['img']) + '{display: none !important;}' +
            scope.root + BOOST + ',' +
            scope.prefix + '*:not([onclick]):not(:link):not(:visited)' + BOOST +
            '{background-image: none !important;}';
    }

    if (!settings.ShowFlash) {
        css += prefixed(scope, ['object', 'embed']) + '{display: none !important;}';
    }

    return css;
}

/** Stylesheet for the document. */
export function buildCss(settings) {
    return build(settings, DOCUMENT_SCOPE);
}

/** The same rules, written to be adopted by a shadow root. */
export function buildShadowCss(settings) {
    return build(settings, SHADOW_SCOPE);
}

/** Whether the styling needs agent.js to run in the page. */
export function needsPageAgent(settings) {
    return !settings.DefaultBrowserColor;
}
