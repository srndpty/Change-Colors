/**
 * Stylesheet generation.
 *
 * The same rules are needed twice: once for the document, and once inside every
 * shadow root, because a document stylesheet does not reach into shadow trees -
 * that is why components built with shadow DOM (YouTube's sidebar, for one)
 * kept their own black-on-white text over the dark background. Both variants
 * are generated from one set of rules through a "scope": the document scope
 * anchors everything at `html > body`, the shadow scope at `:host`.
 */

/** Set by agent.js on elements that carry a background image. */
export const BACKGROUND_IMAGE_ATTRIBUTE = 'data-changecolors-bgimage';

const DOCUMENT_SCOPE = {root: 'html > body', prefix: 'html > body ', host: null};
const SHADOW_SCOPE = {root: ':host', prefix: '', host: ':host'};

/**
 * Specificity padding.
 *
 * Sites do use `!important` themselves, and when they do it on an id or class
 * selector their declaration beats ours - that is how a component ends up
 * keeping its black text on our dark background. `:not(#id)` matches
 * everything while counting as an id, so it lifts our rules above anything a
 * page is likely to declare without changing what they match. Rules that have
 * to win against our own base rule (link colors, the media and banner guards)
 * get one level more.
 */
const BOOST = ':not(#changecolors-a):not(#changecolors-b):not(#changecolors-c)';
const BOOST_OVER_BASE = BOOST + ':not(#changecolors-d)';

function boosted(selector, boost) {
    return selector + boost;
}

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
        return boosted(scope.prefix + selector, boost || BOOST);
    }).join(',');
}

/**
 * Selectors that must stay transparent so playing media remains visible.
 *
 * Forcing an opaque background on every element also paints the overlays a
 * video player stacks on top of its <video> (thumbnails, gradients, end
 * screens), which is what turned videos into a black rectangle. Clearing the
 * background of the player container chain - up to four levels above the
 * <video> - and of everything inside it lets the video show through again,
 * while the rest of the page keeps its solid background.
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

/**
 * agent.js tags the elements that carry a background image. An opaque
 * background on what is drawn inside them - the headline and buttons of a hero
 * banner - would hide the picture.
 */
function bannerGuard(scope) {
    const selectors = [
        '[' + BACKGROUND_IMAGE_ATTRIBUTE + ']',
        '[' + BACKGROUND_IMAGE_ATTRIBUTE + '] *'
    ];
    let css = prefixed(scope, selectors, BOOST_OVER_BASE);
    if (scope.host) {
        // The host of this shadow tree may be the banner itself.
        css += ',' + boosted(':host([' + BACKGROUND_IMAGE_ATTRIBUTE + ']) *', BOOST_OVER_BASE);
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
    const everything = boosted(scope.root, BOOST) + ',' + boosted(scope.prefix + '*', BOOST);
    let css = '';

    if (!settings.DefaultBrowserColor) {
        css += everything + '{' +
            'background-color: #' + settings.background_color + ' !important;' +
            'color: #' + settings.text_color + ' !important;' +
            'text-shadow: none !important;' +
            '-webkit-text-fill-color: currentcolor !important;}' +
            linkSelectors(scope, 'link') + '{color: #' + settings.links_color + ' !important;}' +
            linkSelectors(scope, 'visited') + '{color: #' + settings.visited_links_color + ' !important;}' +
            mediaGuard(scope) + '{background-color: transparent !important;}' +
            bannerGuard(scope) + '{background-color: transparent !important;}';
    }

    if (!settings.DefaultBrowserFont) {
        const fontSize = parseInt(settings.FontSize, 10) || 0;
        css += everything + '{' +
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
            boosted(scope.root, BOOST) + ',' +
            boosted(scope.prefix + '*:not([onclick]):not(:link):not(:visited)', BOOST) +
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
