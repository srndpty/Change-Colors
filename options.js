/**
 * Options page. Reads and writes chrome.storage.local directly; the service
 * worker watches storage and re-applies the styling to open tabs.
 */
import {getSettings, saveSettings, cssFontFamily} from './common/settings.js';
import {FONTS, createFontDetector} from './libs/font_detect.js';

let settings = null;
let detectFont = null;

function $(id) {
    return document.getElementById(id);
}

/** Settings keep colors as bare hex; <input type="color"> wants a leading #. */
function toInputColor(value) {
    return '#' + String(value).replace(/^#/, '');
}

function toStoredColor(value) {
    return String(value).replace(/^#/, '').toUpperCase();
}

async function save(patch) {
    Object.assign(settings, patch);
    await saveSettings(patch);
}

function setRowsVisible(ids, visible) {
    ids.forEach(function (id) {
        $(id).hidden = !visible;
    });
}

const COLOR_ROWS = ['background_color_row', 'text_color_row', 'links_color_row', 'visited_links_color_row'];
const FONT_ROWS = ['fontSelection', 'fontSizeRow'];

function applySampleColors() {
    const sample = $('sampleBlock');
    sample.style.backgroundColor = toInputColor(settings.background_color);
    sample.style.color = toInputColor(settings.text_color);
    $('link').style.color = toInputColor(settings.links_color);
    $('visited_link').style.color = toInputColor(settings.visited_links_color);
}

function applySampleFont() {
    const sample = $('sampleBlock');
    const size = parseInt(settings.FontSize, 10) || 0;
    sample.style.fontFamily = settings.DefaultBrowserFont ? '' : cssFontFamily(settings.OverrideFontName);
    sample.style.fontSize = settings.DefaultBrowserFont ? '' : (size === 0 ? '12pt' : size + 'pt');
}

function displayColoredMessage(element, message, colorCode) {
    element.style.color = colorCode;
    element.textContent = message;
}

/* ---------------------------------------------------------------- colors */

function initColors() {
    ['background_color', 'text_color', 'links_color', 'visited_links_color'].forEach(function (id) {
        const input = $(id);
        input.value = toInputColor(settings[id]);
        input.addEventListener('input', async function () {
            await save({[id]: toStoredColor(input.value)});
            applySampleColors();
        });
    });

    $('browserColorDefault').addEventListener('change', async function () {
        setRowsVisible(COLOR_ROWS, false);
        await save({DefaultBrowserColor: true});
    });
    $('browserColorOverride').addEventListener('change', async function () {
        setRowsVisible(COLOR_ROWS, true);
        await save({DefaultBrowserColor: false});
    });

    $('browserColorDefault').checked = Boolean(settings.DefaultBrowserColor);
    $('browserColorOverride').checked = !settings.DefaultBrowserColor;
    setRowsVisible(COLOR_ROWS, !settings.DefaultBrowserColor);
    applySampleColors();
}

/* ----------------------------------------------------------------- fonts */

function fontEntry(name, removable, index) {
    const entry = document.createElement('div');
    entry.className = removable ? 'UserFontDiv' : 'SingleFontDiv';
    entry.style.fontFamily = cssFontFamily(name);

    const label = document.createElement('div');
    label.className = 'customFontInnerDiv';
    label.textContent = name;
    label.addEventListener('click', function () {
        setFont(name);
    });
    entry.appendChild(label);

    if (removable) {
        const remove = document.createElement('div');
        remove.className = 'customFontRemove';
        remove.textContent = '×';
        remove.title = 'Remove this font';
        remove.addEventListener('click', function (event) {
            event.stopPropagation();
            removeCustomFont(index);
        });
        entry.appendChild(remove);
        const clear = document.createElement('div');
        clear.className = 'clear';
        entry.appendChild(clear);
    }
    return entry;
}

function buildFontSelector() {
    const container = document.createElement('div');
    container.className = 'FontsContainer';

    settings.CustomFonts.forEach(function (name, index) {
        container.appendChild(fontEntry(name, true, index));
    });
    FONTS.filter(detectFont).forEach(function (name) {
        container.appendChild(fontEntry(name, false));
    });

    const selector = $('fontSelector');
    selector.textContent = '';
    selector.appendChild(container);
}

function buildFontSizeSelector() {
    const select = document.createElement('select');
    select.id = 'fontSize';
    select.name = 'fontSize';

    const auto = document.createElement('option');
    auto.value = '0';
    auto.textContent = 'Web page font size';
    select.appendChild(auto);

    for (let size = 1; size <= 32; size++) {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = size + ' pt';
        select.appendChild(option);
    }

    select.value = String(parseInt(settings.FontSize, 10) || 0);
    select.addEventListener('change', function () {
        setFontSize(select.value);
    });

    $('fontSizeContainer').textContent = '';
    $('fontSizeContainer').appendChild(select);
}

async function setFont(name) {
    $('default_font').textContent = name;
    $('default_font').style.fontFamily = cssFontFamily(name);
    await save({OverrideFontName: name});
    applySampleFont();
}

async function setFontSize(size) {
    await save({FontSize: String(size)});
    applySampleFont();
}

async function addCustomFont() {
    const input = $('userCustomFont');
    const message = $('userFontMessage');
    const name = input.value.trim();

    if (name === '' || !detectFont(name)) {
        displayColoredMessage(message, 'Sorry, font not detected.', 'red');
        return;
    }
    if (settings.CustomFonts.indexOf(name) === -1) {
        await save({CustomFonts: settings.CustomFonts.concat([name])});
        buildFontSelector();
    }
    input.value = '';
    displayColoredMessage(message, 'Font successfully added!', 'green');
}

async function removeCustomFont(index) {
    const fonts = settings.CustomFonts.slice();
    fonts.splice(index, 1);
    await save({CustomFonts: fonts});
    buildFontSelector();
}

function toggleFontSelector() {
    const selector = $('fontSelector');
    const setter = $('fontSetter');
    const show = selector.hidden;
    selector.hidden = !show;
    setter.hidden = !show;
    $('fontSelectorBtn').textContent = show ? '(Hide font selection)' : '(Use another font)';
}

function initFonts() {
    detectFont = createFontDetector();

    $('default_font').textContent = String(settings.OverrideFontName).replace(/^['"]|['"]$/g, '');
    $('default_font').style.fontFamily = cssFontFamily(settings.OverrideFontName);
    buildFontSelector();
    buildFontSizeSelector();

    $('fontSelectorBtn').addEventListener('click', toggleFontSelector);
    $('addUserCustomFont').addEventListener('click', addCustomFont);
    $('userCustomFont').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            addCustomFont();
        }
    });

    $('browserFontDefault').addEventListener('change', async function () {
        setRowsVisible(FONT_ROWS, false);
        await save({DefaultBrowserFont: true});
        applySampleFont();
    });
    $('browserFontOverride').addEventListener('change', async function () {
        setRowsVisible(FONT_ROWS, true);
        await save({DefaultBrowserFont: false});
        applySampleFont();
    });

    $('browserFontDefault').checked = Boolean(settings.DefaultBrowserFont);
    $('browserFontOverride').checked = !settings.DefaultBrowserFont;
    setRowsVisible(FONT_ROWS, !settings.DefaultBrowserFont);
    applySampleFont();
}

/* -------------------------------------------------------------- switches */

function initSwitch(defaultId, overrideId, key) {
    $(defaultId).checked = Boolean(settings[key]);
    $(overrideId).checked = !settings[key];
    $(defaultId).addEventListener('change', function () {
        save({[key]: true});
    });
    $(overrideId).addEventListener('change', function () {
        save({[key]: false});
    });
}

async function init() {
    settings = await getSettings();
    initColors();
    initFonts();
    initSwitch('showImageDefault', 'showImageOverride', 'ShowImage');
    initSwitch('showFlashDefault', 'showFlashOverride', 'ShowFlash');

    $('editShortcuts').addEventListener('click', function () {
        chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
    });
}

init();
