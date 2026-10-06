// Checks that the settings of the Manifest V2 version survive a migration that
// goes wrong.
//
// The failure this guards against loses user data silently: marking the
// migration done when nothing was actually read leaves the old settings in a
// localStorage nothing will look at again. Only a report from the offscreen
// document - even an empty one - may end it.
//
// The chrome APIs the migration uses are stubbed, so this runs in node alone.

const results = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(ok);
    console.log(
        (ok ? 'PASS  ' : 'FAIL  ') +
            name +
            (ok
                ? ''
                : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    );
}

/**
 * A stub of the parts of chrome the migration touches.
 * `report` says what the offscreen document does once it is created: an object
 * to report, or null to stay silent.
 */
function stubChrome({ stored = {}, createFails = false, report = null } = {}) {
    const listeners = new Set();
    const calls = { created: 0, closed: 0 };
    globalThis.chrome = {
        storage: {
            local: {
                async get(defaults) {
                    // null asks for everything that is stored, the way the real
                    // API does.
                    if (defaults === null || defaults === undefined) {
                        return Object.assign({}, stored);
                    }
                    const out = {};
                    for (const [key, value] of Object.entries(defaults)) {
                        out[key] = key in stored ? stored[key] : value;
                    }
                    return out;
                },
                async set(patch) {
                    Object.assign(stored, patch);
                }
            }
        },
        runtime: {
            onMessage: {
                addListener: (listener) => listeners.add(listener),
                removeListener: (listener) => listeners.delete(listener)
            }
        },
        offscreen: {
            async createDocument() {
                calls.created++;
                if (createFails) {
                    throw new Error(
                        'Only a single offscreen document may be created.'
                    );
                }
                if (report !== null) {
                    // The real document reports as soon as its script runs.
                    setTimeout(() => {
                        for (const listener of Array.from(listeners)) {
                            listener({
                                action: 'legacySettings',
                                data: report
                            });
                        }
                    }, 5);
                }
            },
            async closeDocument() {
                calls.closed++;
            }
        }
    };
    return { stored, calls, listeners };
}

// Imported once; the module keeps the "one migration at a time" promise.
const { migrateLegacySettings } = await import('../src/common/migration.js');
const TIMEOUT = 60;

/* ------------------------------------------------ the document never opens */

let env = stubChrome({ createFails: true, stored: {} });
await migrateLegacySettings(TIMEOUT);
check(
    'a migration that could not open a document is not marked done',
    env.stored.legacyMigrationDone,
    undefined
);
check('and nothing was written', Object.keys(env.stored), []);
check('the document is closed even so', env.calls.closed, 1);
check('and its listener is gone', env.listeners.size, 0);

/* -------------------------------------------------- the report never comes */

env = stubChrome({ report: null, stored: {} });
await migrateLegacySettings(TIMEOUT);
check(
    'a migration whose report never came is not marked done',
    env.stored.legacyMigrationDone,
    undefined
);
check('and nothing was written either', Object.keys(env.stored), []);
check('the listener is cleaned up after the timeout', env.listeners.size, 0);

/* ------------------------------------------------------- the retry that works */

env = stubChrome({
    report: { background_color: '112233', OverrideAll: true },
    stored: {}
});
await migrateLegacySettings(TIMEOUT);
check(
    'the retry carries the old settings over',
    env.stored.background_color,
    '112233'
);
check('and the rest of them', env.stored.OverrideAll, true);
check('and marks the migration done', env.stored.legacyMigrationDone, true);

/* ------------------------------------------- nothing to migrate is still done */

env = stubChrome({ report: {}, stored: {} });
await migrateLegacySettings(TIMEOUT);
check(
    'finding nothing to migrate counts as done',
    env.stored.legacyMigrationDone,
    true
);

/* --------------------------------------------------------- already migrated */

env = stubChrome({
    report: { background_color: 'ffffff' },
    stored: { legacyMigrationDone: true }
});
await migrateLegacySettings(TIMEOUT);
check('a migration already done opens no document', env.calls.created, 0);
check(
    'and does not overwrite current settings',
    env.stored.background_color,
    undefined
);

/* ------------------- settings written between a failure and its retry win */

// The retry exists so a failed migration does not lose the old settings. It
// must not lose the new ones instead: anything set here since is what the user
// chose most recently.
stubChrome({ createFails: true, stored: {} });
await migrateLegacySettings(TIMEOUT);
const chosen = stubChrome({
    report: { background_color: '112233', text_color: '445566' },
    stored: { background_color: 'abcdef' }
});
await migrateLegacySettings(TIMEOUT);
check(
    'a setting chosen since the failure is kept',
    chosen.stored.background_color,
    'abcdef'
);
check(
    'one the user never touched still comes across',
    chosen.stored.text_color,
    '445566'
);
check('and the migration is done', chosen.stored.legacyMigrationDone, true);

/* ------------------------------------------------------ two callers at once */

// onInstalled and onStartup can both reach this, and two offscreen documents
// cannot exist at once.
env = stubChrome({ report: { background_color: '445566' }, stored: {} });
await Promise.all([
    migrateLegacySettings(TIMEOUT),
    migrateLegacySettings(TIMEOUT)
]);
check('two callers at once open one document', env.calls.created, 1);
check(
    'and the settings still come across',
    env.stored.background_color,
    '445566'
);

/* ---------------------------------------------- a later call after a failure */

env = stubChrome({ createFails: true, stored: {} });
await migrateLegacySettings(TIMEOUT);
env.calls.createFails = false;
const retry = stubChrome({ report: { text_color: 'aabbcc' }, stored: {} });
await migrateLegacySettings(TIMEOUT);
check('a failed migration can be run again', retry.calls.created, 1);
check(
    'and the second attempt carries the settings over',
    retry.stored.text_color,
    'aabbcc'
);
check('and marks it done', retry.stored.legacyMigrationDone, true);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
