/**
 * Reads the settings the Manifest V2 version stored in localStorage and hands
 * them to the service worker, which cannot access localStorage itself.
 */
import {DEFAULTS} from './common/settings.js';

function readLegacySettings() {
    const legacy = {};
    Object.keys(DEFAULTS).forEach(function (key) {
        const raw = localStorage.getItem(key);
        if (raw === null) {
            return;
        }
        try {
            let value = JSON.parse(raw);
            if (typeof DEFAULTS[key] === 'string' && typeof value === 'number') {
                value = String(value);
            }
            if (value !== null && typeof value === typeof DEFAULTS[key] &&
                Array.isArray(value) === Array.isArray(DEFAULTS[key])) {
                legacy[key] = value;
            }
        } catch (e) {
            // Not something we wrote - ignore it.
        }
    });
    return legacy;
}

// The service worker does not answer, so the rejected "port closed" promise is
// expected and ignored.
chrome.runtime.sendMessage({action: 'legacySettings', data: readLegacySettings()}).catch(function () {});
