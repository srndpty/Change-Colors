/**
 * JavaScript code to detect availability of a particular font in a browser
 * using JavaScript and CSS.
 *
 * Author : Lalit Patel
 * Website: http://www.lalit.org/lab/jsoncookies
 * License: Creative Commons Attribution-ShareAlike 2.5
 *          http://creativecommons.org/licenses/by-sa/2.5/
 * Version: 0.15
 *
 * Reworked as an ES module for the Manifest V3 version; the detection itself is
 * unchanged.
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
