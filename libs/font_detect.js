/**
 * JavaScript code to detect available availability of a
 * particular font in a browser using JavaScript and CSS.
 *
 * Author : Lalit Patel
 * Website: http://www.lalit.org/lab/jsoncookies
 * License: Creative Commons Attribution-ShareAlike 2.5
 *          http://creativecommons.org/licenses/by-sa/2.5/
 * Version: 0.15
 *          changed comparision font to serif from sans-serif,
 *          as in FF3.0 font of child element didn't fallback
 *          to parent element if the font is missing.
 * Updated: 09 July 2009 10:52pm
 *
 * The block above is the notice this file arrived with, kept word for word.
 * Two things about it are worth knowing, and neither can be settled from here -
 * see THIRD_PARTY_NOTICES.md:
 *
 * - the website line points at the author's JSON cookies page rather than the
 *   font detector's own page, which is
 *   http://www.lalit.org/lab/javascript-css-font-detect/
 * - versions 0.2 and 0.3 of this work, published in 2012, carry the Apache
 *   License 2.0 rather than the license above. This is 0.15, from 2009, and
 *   what it says is what is honoured here.
 *
 * Changed for the Manifest V3 version: written as an ES module - the font list
 * and a factory are exported where the original set two globals - and the
 * measurement made once when the detector is built instead of on every test.
 * What is measured is unchanged: one span of `mmmmmmmmmml` at 72px, compared
 * against `serif`, which is the change 0.15 itself is.
 */

export const FONTS = ["Agency FB","American Typewriter","Andale Mono","Apple Chancery","Arial","Arial Black","Arial Narrow","Arial Rounded MT Bold","Arial Unicode MS","Baskerville","Big Caslon","Bitstream Charter","Bitstream Vera Sans","Bitstream Vera Sans Mono","Bitstream Vera Serif","Blackadder ITC","Book Antiqua","Bookman Old Style","Bradley Hand ITC","Brush Script MT","Calibri","Calisto MT","Cambria","Candara","Castellar","Century Gothic","Century Schoolbook","Century Schoolbook L","Comic Sans MS","Consolas","Constantia","Copperplate","Copperplate Gothic Bold","Copperplate Gothic Light","Corbel","Courier","Courier 10 Pitch","Courier New","Curlz MT","DejaVu Sans","DejaVu Sans Condensed","DejaVu Sans Light","DejaVu Sans Mono","DejaVu Serif","DejaVu Serif Condensed","Didot","Edwardian Script ITC","Electron","Engravers MT","Eras Demi ITC","Eras Light ITC","Felix Titling","Franklin Gothic Book","Franklin Gothic Demi","Franklin Gothic Demi Cond","Franklin Gothic Heavy","Franklin Gothic Medium","Franklin Gothic Medium Cond","FreeMono","FreeSans","FreeSerif","Freestyle Script","French Script MT","Futura","Garamond","Geneva","Georgia","Gill Sans","Gill Sans MT","Gill Sans MT Condensed","Gill Sans Ultra Bold","Goudy Old Style","Goudy Stout","Haettenschweiler","Helvetica","Helvetica Neue","Herculanum","Hoefler Text","Impact","Imprint MT Shadow","Jokerman","Juice ITC","Kartika","Kristen ITC","Liberation Mono","Liberation Sans","Liberation Serif","Lucida Bright","Lucida Console","Lucida Grande","Lucida Handwriting","Lucida Sans","Lucida Sans Typewriter","Lucida Sans Unicode","Maiandra GD","Marker Felt","Metal","Microsoft Sans Serif","Mistral","Monaco","Monotype Corsiva","MS Reference Sans Serif","Nice","Nimbus Mono L","Nimbus Roman No9 L","Nimbus Sans L","OCR A Extended","Optima","Palace Script MT","Palatino","Palatino Linotype","Papyrus","Perpetua","Pristina","Rage Italic","Rockwell","Rockwell Extra Bold","Script MT Bold","Segoe UI","Skia","Sylfaen","Tahoma","Tempus Sans ITC","Times","Times New Roman","Trebuchet MS","URW Bookman L","URW Chancery L","URW Gothic L","URW Palladio L","Verdana","Vivaldi","Vrinda","Zapfino"];

export function createFontDetector() {
    const body = document.getElementsByTagName('BODY')[0];
    const container = document.createElement('DIV');
    const sample = document.createElement('SPAN');
    container.appendChild(sample);
    // A serif comparison font: a child element does not always fall back to the
    // font of its parent, so the fallback has to be explicit on both.
    container.style.fontFamily = 'serif';
    sample.style.fontFamily = 'serif';
    sample.style.fontSize = '72px';
    sample.textContent = 'mmmmmmmmmml';

    body.appendChild(container);
    const defaultWidth = sample.offsetWidth;
    const defaultHeight = sample.offsetHeight;
    body.removeChild(container);

    return function test(font) {
        if (font.toLowerCase() === 'serif') {
            return true;
        }
        body.appendChild(container);
        sample.style.fontFamily = '"' + font + '", serif';
        const width = sample.offsetWidth;
        const height = sample.offsetHeight;
        body.removeChild(container);
        return width !== defaultWidth || height !== defaultHeight;
    };
}
