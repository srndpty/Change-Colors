import {getSettings, getOverrideState, isSupportedUrl, toggleFlag, toggleListEntry} from './common/settings.js';

let currentTab = null;

function setButton(id, label, onClick) {
    const button = document.getElementById(id);
    button.textContent = label;
    button.onclick = async function () {
        await onClick();
        await render();
    };
}

async function render() {
    const settings = await getSettings();
    const state = getOverrideState(settings, currentTab.url);

    if (state.OverrideAll) {
        // While the global override is on, the page and domain buttons manage
        // the exclusion lists instead.
        if (state.NotOverridenPages) {
            setButton('pageOverriden', 'Global override on this page', function () {
                return toggleListEntry('NotOverridenPages', state.url);
            });
        } else {
            setButton('pageOverriden', 'No global override on this page', function () {
                return toggleListEntry('NotOverridenPages', state.url);
            });
        }
        if (state.NotOverridenDomains) {
            setButton('domainOverriden', 'Global override on this domain', function () {
                return toggleListEntry('NotOverridenDomains', state.domain);
            });
        } else {
            setButton('domainOverriden', 'No global override on this domain', function () {
                return toggleListEntry('NotOverridenDomains', state.domain);
            });
        }
        setButton('overrideAll', 'Remove override on all pages', function () {
            return toggleFlag('OverrideAll');
        });
    } else {
        setButton('pageOverriden',
            state.OverridenPages ? 'Remove override on this page' : 'Apply override on this page',
            function () {
                return toggleListEntry('OverridenPages', state.url);
            });
        setButton('domainOverriden',
            state.OverridenDomains ? 'Remove override on this domain' : 'Apply override on this domain',
            function () {
                return toggleListEntry('OverridenDomains', state.domain);
            });
        setButton('overrideAll', 'Apply override on all pages', function () {
            return toggleFlag('OverrideAll');
        });
    }
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
