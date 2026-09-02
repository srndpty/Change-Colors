import {
    getSettings,
    getOverrideState,
    isSupportedUrl,
    requestOverrideChange
} from './common/settings.js';

let currentTab = null;

/**
 * Every button says what pressing it will do, and pressing it does exactly
 * that. A label is worked out from what the page (or the domain) actually gets
 * in the end, not from one list it happens to be on, because the two used to
 * disagree: with the global override on, "no global override on this page"
 * added the page to the exclusion list and left an older per-page inclusion
 * sitting on top of it, so the page stayed overridden and the button offered
 * the same thing again.
 */
function setButton(id, label, scope) {
    const button = document.getElementById(id);
    button.textContent = label;
    button.onclick = async function () {
        // A change is read, altered and written back. The service worker does
        // them one at a time; this keeps a second press from being queued
        // against what is still on screen.
        setBusy(true);
        try {
            await requestOverrideChange(scope, currentTab.url);
            await render();
        } finally {
            setBusy(false);
        }
    };
}

function setBusy(busy) {
    document.querySelectorAll('#buttons button').forEach(function (button) {
        button.disabled = busy;
    });
}

async function render() {
    const state = getOverrideState(await getSettings(), currentTab.url);
    setButton('pageOverriden',
        state.active ? 'Remove override on this page' : 'Apply override on this page',
        'page');
    setButton('domainOverriden',
        state.domainActive ? 'Remove override on this domain' : 'Apply override on this domain',
        'domain');
    setButton('overrideAll',
        state.OverrideAll ? 'Remove override on all pages' : 'Apply override on all pages',
        'all');
}

async function init() {
    document.getElementById('openOptions').addEventListener('click', function (event) {
        event.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    currentTab = tab;
    if (!tab || !isSupportedUrl(tab.url)) {
        document.getElementById('buttons').hidden = true;
        document.getElementById('unsupported').hidden = false;
        return;
    }
    await render();
}

init();
