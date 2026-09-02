/**
 * Carries the settings of the Manifest V2 version over to storage.
 *
 * That version kept them in the background page's localStorage, which a service
 * worker cannot read. An offscreen document can, so one is opened once to copy
 * them across.
 *
 * "Once" means once it has worked. The document reports what it found - an
 * empty object if there was nothing there - so a report and a failure to get
 * one are different things, and only a report ends the migration. What comes
 * across is only what has not been set since. A creation
 * that failed, an offscreen document already in use, or a report that never
 * came leaves it to be tried again on the next browser start; marking it done
 * in those cases would throw away the settings of everyone it happened to.
 */

const REPORT_TIMEOUT = 5000;

/**
 * Listens for the offscreen document's report.
 *
 * The listener has to be in place before the document is created, because it
 * reports as soon as its script runs. `cancel()` is there for when the document
 * never opens: without it the listener and its timer would sit in the service
 * worker until the timeout ran out, keeping it awake for a report that cannot
 * come. It resolves with what was reported, or null.
 */
function waitForReport(timeoutMs) {
    let stop;
    const promise = new Promise(function (resolve) {
        function listener(request) {
            if (request && request.action === 'legacySettings') {
                stop(request.data);
            }
        }
        const timer = setTimeout(function () {
            stop(null);
        }, timeoutMs);
        chrome.runtime.onMessage.addListener(listener);
        stop = function (value) {
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            // Resolving an already resolved promise does nothing, which is what
            // makes cancelling after a report harmless.
            resolve(value);
        };
    });
    return {promise: promise, cancel: function () {
        stop(null);
    }};
}

async function run(timeoutMs) {
    const flag = await chrome.storage.local.get({legacyMigrationDone: false});
    if (flag.legacyMigrationDone) {
        return;
    }
    let legacy = null;
    // Listening starts before the document exists: it reports as soon as its
    // script runs, so there is no window in which the report could be missed.
    const reported = waitForReport(timeoutMs);
    try {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['LOCAL_STORAGE'],
            justification: 'Read settings saved by the previous Manifest V2 version.'
        });
        legacy = await reported.promise;
    } catch (e) {
        // No offscreen support, or the document already exists.
    } finally {
        reported.cancel();
        try {
            await chrome.offscreen.closeDocument();
        } catch (e) {
            // Never opened.
        }
    }

    if (legacy === null || typeof legacy !== 'object') {
        // Nothing was read. Leave the flag alone and try again another time.
        return;
    }

    // Only settings that have never been set here are taken over. A migration
    // that failed is retried later, and in between the user may well have set
    // preferences of their own - overwriting those with values from a version
    // they have replaced would lose settings just as surely as the failure this
    // retry exists for.
    const current = await chrome.storage.local.get(null);
    const patch = {legacyMigrationDone: true};
    for (const [key, value] of Object.entries(legacy)) {
        if (!(key in current)) {
            patch[key] = value;
        }
    }
    await chrome.storage.local.set(patch);
}

// One migration at a time: onInstalled and onStartup can both reach this, and
// two offscreen documents cannot exist at once.
let migrating = null;

export function migrateLegacySettings(timeoutMs) {
    if (!migrating) {
        migrating = run(timeoutMs === undefined ? REPORT_TIMEOUT : timeoutMs)
            .finally(function () {
                migrating = null;
            });
    }
    return migrating;
}
