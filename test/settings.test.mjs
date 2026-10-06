// Checks what the override buttons promise against what they do.
//
// Two things went wrong here before. A page turned on individually stayed on
// however hard the popup was pressed afterwards, because any inclusion beat any
// exclusion - so "no global override on this page" changed a list and nothing
// else. And a change is a read, an edit and a write of a whole list, so two of
// them at once lost one of the two.
//
// chrome.storage.local is stubbed, so this runs in node alone.

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
 * A stub of chrome.storage.local. `delay` is how long a get and a set take:
 * anything above zero is enough for two overlapping read-modify-writes to read
 * the same thing, which is the race being tested for.
 */
let stored = {};
let delay = 0;
const wait = () => new Promise((resolve) => setTimeout(resolve, delay));
globalThis.chrome = {
    storage: {
        local: {
            async get(defaults) {
                await wait();
                const out = {};
                for (const [key, value] of Object.entries(defaults || {})) {
                    out[key] = key in stored ? stored[key] : value;
                }
                return out;
            },
            async set(patch) {
                await wait();
                Object.assign(stored, JSON.parse(JSON.stringify(patch)));
            }
        }
    }
};

const {
    DEFAULTS,
    getOverrideState,
    getSettings,
    isScope,
    requestOverrideChange,
    setOverride,
    toggleOverride,
    updateSettings
} = await import('../src/common/settings.js');

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

function reset(patch) {
    stored = Object.assign(
        {},
        JSON.parse(JSON.stringify(DEFAULTS)),
        patch || {}
    );
}

async function state(url) {
    return getOverrideState(await getSettings(), url || URL_A);
}

/* ------------------------------------------------- what each scope decides */

reset({ OverrideAll: true });
check(
    'the global override reaches a page nothing is said about',
    (await state()).active,
    true
);

reset({ OverrideAll: true, NotOverridenDomains: ['example.com'] });
check(
    'a domain set not to override beats the global setting',
    (await state()).active,
    false
);

reset({
    OverrideAll: false,
    OverridenDomains: ['example.com'],
    NotOverridenPages: [URL_A]
});
check(
    'and a page set not to override beats its domain',
    (await state()).active,
    false
);
check(
    'while the rest of the domain keeps it',
    (await state(URL_B)).active,
    true
);

reset({
    OverrideAll: true,
    OverridenPages: [URL_A],
    NotOverridenPages: [URL_A]
});
check(
    'a page saved by an older version as both is read as not overridden',
    (await state()).active,
    false
);

/* ------------------------------------- the button does what its label says */

// The reported release blocker: a page turned on while the global override was
// off, then switched off again once the global override was on.
reset();
await toggleOverride('page', URL_A);
check(
    'turning a page on with no global override overrides it',
    (await state()).active,
    true
);
await toggleOverride('all', URL_A);
check(
    'and turning the global override on leaves it on',
    (await state()).active,
    true
);
await toggleOverride('page', URL_A);
check(
    'and the page can then be turned off again',
    (await state()).active,
    false
);
check(
    'with nothing of the old inclusion left behind',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[], [URL_A]]
);
await toggleOverride('page', URL_A);
check(
    'and pressing it once more puts it back to what the global setting says',
    (await state()).active,
    true
);
check(
    'leaving the page on neither list, so the global setting still reaches it',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[], []]
);

reset({ OverrideAll: true, OverridenDomains: ['example.com'] });
await toggleOverride('domain', URL_A);
check(
    'a domain turned off while its inclusion is stale is really off',
    (await state()).active,
    false
);
check(
    'and is on neither domain list twice',
    [stored.OverridenDomains, stored.NotOverridenDomains],
    [[], ['example.com']]
);

reset({ OverrideAll: false, NotOverridenPages: [URL_A] });
await toggleOverride('page', URL_A);
check(
    'a page turned on while excluded comes off the exclusion list',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[URL_A], []]
);

// A page is written down only while it disagrees with its domain, and what was
// said about it explicitly is not taken back by a change to a wider scope.
reset({ OverridenDomains: ['example.com'] });
await toggleOverride('page', URL_A);
check(
    'a page turned off under an overridden domain is off',
    (await state()).active,
    false
);
check(
    'and is written down, because it disagrees with its domain',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[], [URL_A]]
);
await toggleOverride('domain', URL_A);
check(
    'turning the domain off leaves the rest of it off',
    (await state(URL_B)).active,
    false
);
await toggleOverride('domain', URL_A);
check(
    'and turning it back on does not undo what was said about the page',
    (await state()).active,
    false
);
check(
    'while the rest of the domain comes back on',
    (await state(URL_B)).active,
    true
);

/* ------------------------------------------------ saying it twice, and badly */

// The popup sends where it is going, not "turn it around", so that it can send
// it again when the service worker saves the change and is stopped before its
// answer gets out. Sending it again must change nothing.
reset({ OverrideAll: true });
await setOverride('page', URL_A, false);
const afterOnce = JSON.stringify(stored);
await setOverride('page', URL_A, false);
check(
    'asking for the same answer twice leaves the same answer',
    JSON.stringify(stored),
    afterOnce
);
check('and it is the answer that was asked for', (await state()).active, false);

await setOverride('page', URL_A, true);
check('and asking for the other one changes it', (await state()).active, true);

reset();
check('a scope nobody knows is not a scope', isScope('everything'), false);
const refused = await setOverride('everything', URL_A, true).then(
    () => 'saved',
    () => 'refused'
);
check(
    'and a change naming one is refused rather than taken for a page',
    refused,
    'refused'
);
check('leaving the settings as they were', stored.OverridenPages, []);

/* ------------------------------------------- what the popup does, and does not */

// Every change to the lists is made in the service worker, so that they are
// made one at a time. The popup asks; it never writes. A worker that does not
// answer is asked again - the message says what the answer should be, so asking
// twice is safe - and if it still does not answer, the popup says so rather
// than writing beside the worker.
function stubMessaging(answers) {
    const sent = [];
    chrome.runtime = {
        async sendMessage(message) {
            sent.push(message);
            const answer =
                answers[Math.min(sent.length - 1, answers.length - 1)];
            if (answer === 'unreachable') {
                throw new Error('Could not establish connection.');
            }
            return answer;
        }
    };
    return sent;
}

reset();
let sent = stubMessaging([{ ok: true }]);
await requestOverrideChange('page', URL_A, true);
check(
    'the popup sends the answer it wants, not "turn it around"',
    JSON.stringify(sent),
    JSON.stringify([
        { action: 'setOverride', scope: 'page', url: URL_A, active: true }
    ])
);
check('and writes nothing itself', stored.OverridenPages, []);

sent = stubMessaging(['unreachable', 'unreachable', { ok: true }]);
await requestOverrideChange('page', URL_A, true);
check('a worker that cannot be reached is asked again', sent.length, 3);
check(
    'with the same message every time',
    sent.every((m) => m.active === true && m.scope === 'page'),
    true
);

stubMessaging(['unreachable']);
const gaveUp = await requestOverrideChange('page', URL_A, true).then(
    () => 'saved',
    () => 'told the caller'
);
check(
    'a worker that never answers is not worked around locally',
    gaveUp,
    'told the caller'
);
check(
    'and the settings are left exactly as they were',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[], []]
);

sent = stubMessaging([{ ok: false }]);
const sentBack = await requestOverrideChange('page', URL_A, true).then(
    () => 'saved',
    () => 'told the caller'
);
check('a change the worker refuses is not sent again', sent.length, 1);
check(
    'and is reported rather than retried for ever',
    sentBack,
    'told the caller'
);
delete chrome.runtime;

/* --------------------------------------------- two changes at the same time */

delay = 5;
reset();
await Promise.all([
    toggleOverride('page', URL_A),
    toggleOverride('page', URL_B)
]);
check('two pages turned on at once are both turned on', stored.OverridenPages, [
    URL_A,
    URL_B
]);

reset();
await Promise.all([
    toggleOverride('page', URL_A),
    toggleOverride('page', URL_A)
]);
check(
    'and two presses of the same button cancel out rather than one being lost',
    [stored.OverridenPages, stored.NotOverridenPages],
    [[], []]
);

reset();
const failed = updateSettings(function () {
    throw new Error('no');
}).then(
    () => 'resolved',
    () => 'rejected'
);
await toggleOverride('all', URL_A);
check(
    'a change that throws is reported to whoever made it',
    await failed,
    'rejected'
);
check(
    'and does not take the changes queued behind it with it',
    stored.OverrideAll,
    true
);
delay = 0;

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
