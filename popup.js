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
 *
 * What is sent is where the button is going, not "turn it around". The service
 * worker can save the change and be stopped before its answer reaches us, and
 * an unanswered message is not proof that nothing happened - so what is sent
 * has to be a thing that can be said twice.
 */
function setButton(id, label, scope, active) {
    const button = document.getElementById(id);
    button.textContent = label;
    button.onclick = async function () {
        // A change is read, altered and written back. The service worker does
        // them one at a time; this keeps a second press from being queued
        // against what is still on screen.
        setBusy(true);
        document.getElementById('failed').hidden = true;
        try {
            await requestOverrideChange(scope, currentTab.url, active);
        } catch (e) {
            // The change is only ever made in the service worker, so that all
            // of them are made one at a time. Making this one here instead
            // would be the second writer that was got rid of - so nothing is
            // written, and the buttons go back to showing what is actually
            // stored.
            document.getElementById('failed').hidden = false;
        }
        try {
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
        'page', !state.active);
    setButton('domainOverriden',
        state.domainActive ? 'Remove override on this domain' : 'Apply override on this domain',
        'domain', !state.domainActive);
    setButton('overrideAll',
        state.OverrideAll ? 'Remove override on all pages' : 'Apply override on all pages',
        'all', !state.OverrideAll);
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
