// Loads the real extension in Chrome and drives it the way a user does.
//
// The unit-level test injects the stylesheet and agent.js into a page itself,
// so it never exercises the service worker: the stylesheet a tab already has,
// navigations, sub frames and the storage writes the options page makes on
// every `input` event are all its business, and that is where a tab can end up
// with a stylesheet nothing is able to remove any more.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportLaunchFailure } from './browser.mjs';

const PORT = 8127;
// What gets loaded into the browser. The release gate points this at `build/`,
// the directory that is actually packed: an import that was never added to the
// staging list works perfectly from the source root and is simply missing from
// what ships, and only loading what ships can tell.
const EXTENSION = process.env.EXTENSION_DIR
    ? path.resolve(process.env.EXTENSION_DIR)
    : fileURLToPath(new URL('..', import.meta.url));

/**
 * Branded Google Chrome refuses `--load-extension`, so this test needs a
 * Chromium build: $CHROME_UNBRANDED, or one of the browsers Playwright and
 * Puppeteer download into the user's cache.
 */
function findBrowser() {
    const candidates = [];
    if (process.env.CHROME_UNBRANDED) {
        candidates.push(process.env.CHROME_UNBRANDED);
    }
    const caches = [
        process.env.LOCALAPPDATA &&
            path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
        path.join(os.homedir(), '.cache', 'ms-playwright'),
        path.join(os.homedir(), '.cache', 'puppeteer')
    ].filter(Boolean);
    for (const cache of caches) {
        let entries;
        try {
            entries = fs.readdirSync(cache).sort().reverse();
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (!/^chrom/.test(entry) || /headless_shell/.test(entry)) {
                continue;
            }
            for (const inner of [
                'chrome-win64',
                'chrome-win',
                'chrome-linux',
                'chrome-mac'
            ]) {
                for (const binary of [
                    'chrome.exe',
                    'chrome',
                    'Chromium.app/Contents/MacOS/Chromium'
                ]) {
                    candidates.push(path.join(cache, entry, inner, binary));
                }
            }
        }
    }
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const CHROME = findBrowser();
if (!CHROME) {
    const how =
        'Point $CHROME_UNBRANDED at one, or run `npx playwright install chromium`.';
    if (process.env.REQUIRE_BROWSER) {
        console.log(
            'FAIL  integration test: no Chromium that accepts --load-extension was'
        );
        console.log(
            '      found, and $REQUIRE_BROWSER says this one had to run. ' + how
        );
        process.exit(1);
    }
    console.log(
        'SKIP  integration test: no Chromium that accepts --load-extension was found.'
    );
    console.log('      ' + how);
    process.exit(0);
}

const FRAME = `<!doctype html><html><body style="background:#ffffff;color:#111">
<p id="p">framed</p>
<div id="frameOverlay" style="position:absolute;inset:0"></div>
</body></html>`;

// A page that asks the browser to prerender another one. The prerendered page
// is a page of its own inside the same tab, with its own top level frame.
const SPECULATE = `<!doctype html><html><body style="background:#ffffff;color:#111">
<h1 id="h">speculating</h1>
<script type="speculationrules">
{"prerender": [{"urls": ["/prerendered"]}]}
</script>
</body></html>`;

const PRERENDERED = `<!doctype html><html><body style="background:#ffffff;color:#111">
<h1 id="h">prerendered</h1>
<iframe id="f" src="/frame" width="300" height="120"></iframe>
</body></html>`;

const PAGE = `<!doctype html><html><body style="background:#ffffff;color:#111">
<h1 id="h">page</h1>
<div id="solid" style="background:#ffffff">solid</div>
<div id="overlay" style="position:absolute;inset:0"></div>
<iframe id="f" src="/frame" width="300" height="120"></iframe>
<div id="widget"></div>
<script>
  const root = document.getElementById('widget').attachShadow({mode: 'open'});
  root.innerHTML = '<style>span{color:#0f0f0f;background:#fff;font-family:Times}</style>' +
      '<span id="shadowText">sidebar entry</span>';
</script>
</body></html>`;

// A document with more elements than one flush of the agent measures.
const BIG = `<!doctype html><html><body style="background:#ffffff;color:#111">
<div id="big"></div>
<script>
  const parts = [];
  for (let i = 0; i < 9000; i++) {
    parts.push('<div id="big' + i + '"' + (i % 2 ? ' style="background:#fff"' : '') + '>x</div>');
  }
  document.getElementById('big').innerHTML = parts.join('');
</script>
</body></html>`;

// A document that replaces itself as soon as it has committed. The extension
// sees a commit for it and starts working on it, and by the time that work runs
// the frame holds another document.
const REDIRECT = `<!doctype html><html><body style="background:#ffffff;color:#111">
<script>location.replace('/plain');</script>
</body></html>`;

const PLAIN = `<!doctype html><html><body style="background:#ffffff;color:#111">
<p id="p">plain</p>
</body></html>`;

const server = http
    .createServer((req, res) => {
        const body = req.url.startsWith('/frame')
            ? FRAME
            : req.url.startsWith('/big')
              ? BIG
              : req.url.startsWith('/redirect')
                ? REDIRECT
                : req.url.startsWith('/plain')
                  ? PLAIN
                  : req.url.startsWith('/speculate')
                    ? SPECULATE
                    : req.url.startsWith('/prerendered')
                      ? PRERENDERED
                      : PAGE;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(body);
    })
    .listen(PORT);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-int-'));
const chrome = spawn(
    CHROME,
    [
        '--headless=new',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        '--no-first-run',
        '--no-default-browser-check',
        `http://localhost:${PORT}/`
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }
);
reportLaunchFailure(chrome, CHROME, () => server.close());
console.log(`      (extension loaded from ${EXTENSION})`);

let nextId = 0;
const pending = new Map();
// What the browser says about pages it was asked to prerender, by url. A page
// being prerendered is not in the target list and cannot be attached to, so
// this is the only way to know whether one exists.
const prerenders = new Map();
let buffer = Buffer.alloc(0);
chrome.stdio[4].on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
        const raw = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === 'Preload.prerenderStatusUpdated') {
            prerenders.set(msg.params.key.url, msg.params.status);
        }
    }
});
function send(method, params = {}, sessionId) {
    const id = ++nextId;
    const m = { id, method, params };
    if (sessionId) m.sessionId = sessionId;
    chrome.stdio[3].write(JSON.stringify(m) + '\0');
    return new Promise((r) => pending.set(id, r));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(sessionId, expression) {
    const r = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
    );
    if (r.result.exceptionDetails) {
        throw new Error(
            JSON.stringify(r.result.exceptionDetails.exception).slice(0, 300)
        );
    }
    return r.result.result.value;
}

async function findTarget(match) {
    for (let i = 0; i < 40; i++) {
        const t = await send('Target.getTargets');
        const found = (t.result.targetInfos || []).find(match);
        if (found) return found;
        await sleep(500);
    }
    return null;
}

async function attach(target) {
    const {
        result: { sessionId }
    } = await send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true
    });
    await send('Runtime.enable', {}, sessionId);
    return sessionId;
}

/**
 * Attaches to the page showing `url`, and to the document it is showing now.
 *
 * A tab keeps its target across a navigation, so attaching to it during one can
 * leave a session still talking to the document being replaced - which, having
 * been styled a moment ago, answers every question with the old page's colors
 * and never changes. Asking that session where it is is what tells the two
 * apart.
 */
async function openPage(match, timeout = 15000) {
    const until = Date.now() + timeout;
    for (;;) {
        const target = await findTarget(
            (x) => x.type === 'page' && x.url.includes(match)
        );
        if (target) {
            const session = await attach(target);
            try {
                const here = await evaluate(session, 'location.href');
                if (here.includes(match)) {
                    return session;
                }
            } catch (e) {
                // The document went away underneath us; look again.
            }
        }
        if (Date.now() > until) {
            throw new Error('no page showing ' + match);
        }
        await sleep(250);
    }
}

/**
 * Waits for something to reach a value, up to a deadline, and returns whatever
 * it last saw. What is being asserted is where the extension settles: the work
 * is queued behind everything else the tab is doing, so a fixed wait either
 * makes the test slow or makes it flake.
 */
async function settles(read, expected, timeout = 8000) {
    const until = Date.now() + timeout;
    let seen;
    for (;;) {
        seen = await read();
        if (
            JSON.stringify(seen) === JSON.stringify(expected) ||
            Date.now() > until
        ) {
            return seen;
        }
        await sleep(250);
    }
}

const results = [];
function check(name, actual, expected) {
    const ok = Array.isArray(expected)
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : actual === expected;
    results.push(ok);
    console.log(
        (ok ? 'PASS  ' : 'FAIL  ') +
            name +
            (ok ? '' : `  -> got ${actual}, expected ${expected}`)
    );
}

const WHITE = 'rgb(255, 255, 255)';
const DARK = 'rgb(8, 8, 8)';
const CLEAR = 'rgba(0, 0, 0, 0)';
const TEXT = 'rgb(232, 232, 232)';

try {
    await sleep(3000);
    const worker = await findTarget(
        (x) => x.type === 'service_worker' && x.url.endsWith('/background.js')
    );
    if (!worker) {
        const t = await send('Target.getTargets');
        throw new Error(
            'the extension service worker never showed up: ' +
                (t.result.targetInfos || [])
                    .map((x) => x.type + ' ' + x.url)
                    .join(' | ')
        );
    }
    const workerSession = await attach(worker);
    const loadedName = await evaluate(
        workerSession,
        'chrome.runtime.getManifest().name'
    );
    if (loadedName !== 'Change Colors') {
        throw new Error(
            `Unexpected extension "${loadedName}" in ${CHROME}. Set CHROME_UNBRANDED to a Chromium build that loads this extension.`
        );
    }

    // Explicitly create and activate the fixture tab; browser startup may leave
    // a welcome or blank tab active instead of the command-line URL.
    const fixture = await send('Target.createTarget', {
        url: `http://localhost:${PORT}/`
    });
    await send('Target.activateTarget', { targetId: fixture.result.targetId });
    await openPage(`http://localhost:${PORT}/`);

    // Everything the popup and the options page do is a write to storage.
    const settings = (patch) =>
        evaluate(
            workerSession,
            `chrome.storage.local.set(${JSON.stringify(patch)})`
        );

    // The extension's own view of which document a tab is holding. A document
    // restored from the back/forward cache keeps the id it had, which is what
    // lets work recorded for it still apply.
    const topDocumentId = () =>
        evaluate(
            workerSession,
            `(async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id});
        const top = frames.find(frame => frame.frameId === 0);
        return top ? top.documentId : null;
    })()`
        );

    // The extension asks for `<all_urls>` and nothing else that would let it
    // read a tab's URL, because a host permission for the page is already
    // enough - and the `tabs` permission, which the store reads as "sees every
    // page you are on", is not. Everything the extension decides starts from a
    // URL it read this way, so this is checked rather than believed.
    check(
        'the extension does not ask for the tabs permission',
        await evaluate(
            workerSession,
            'JSON.stringify(chrome.runtime.getManifest().permissions)'
        ).then((text) => JSON.parse(text).includes('tabs')),
        false
    );
    check(
        'and can still read the URL of a tab it has host access to',
        await evaluate(
            workerSession,
            `(async () => {
            const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
            return typeof tab.url === 'string' && tab.url.startsWith('http://localhost');
        })()`
        ),
        true
    );

    let sessionId = await openPage('http://localhost');
    const bg = (expression) =>
        evaluate(sessionId, `getComputedStyle(${expression}).backgroundColor`);
    const FRAME_DOC = "document.getElementById('f').contentDocument";
    const frameBg = (id) =>
        bg(`${FRAME_DOC}.getElementById(${JSON.stringify(id)})`);
    const frameBodyBg = () => bg(`${FRAME_DOC}.body`);

    check('page starts unstyled', await bg('document.body'), WHITE);

    await settings({ OverrideAll: true });
    await sleep(1500);
    check(
        'turning the override on styles the open page',
        await bg('document.body'),
        DARK
    );
    check(
        'and the elements inside it',
        await bg('document.getElementById("solid")'),
        DARK
    );
    check(
        'and clears what has no background of its own',
        await bg('document.getElementById("overlay")'),
        CLEAR
    );
    check('and the sub frame', await frameBodyBg(), DARK);

    /* ------------------------------------------------- navigating with a frame */

    await evaluate(sessionId, 'location.href = "/?second"');
    await sleep(2500);
    sessionId = await openPage('second');
    check('a new document is styled', await bg('document.body'), DARK);
    check('its sub frame is styled too', await frameBodyBg(), DARK);
    check(
        'the sub frame is measured as well',
        await frameBg('frameOverlay'),
        CLEAR
    );

    /* --------------------------------------------------- rapid storage writes */

    // The options page writes on every `input` event: dragging a color picker
    // sends a burst like this one. Each write makes the worker swap the tab's
    // stylesheet for a new one, and a swap that overlaps with the next leaves a
    // stylesheet behind that can never be removed again.
    await evaluate(
        workerSession,
        `(async () => {
        for (let i = 0; i < 40; i++) {
            chrome.storage.local.set({background_color: (0x101010 + i * 0x010101).toString(16)});
        }
        await chrome.storage.local.set({background_color: '112233'});
    })()`
    );
    await sleep(3000);
    check(
        'the last color of a burst of writes is the one that applies',
        await bg('document.body'),
        'rgb(17, 34, 51)'
    );

    await settings({ OverrideAll: false });
    await sleep(2000);
    check(
        'turning the override off leaves no stylesheet behind',
        await bg('document.body'),
        WHITE
    );
    check('and none in the sub frame either', await frameBodyBg(), WHITE);

    /* ------------------------------------------- a document larger than a flush */

    await settings({ OverrideAll: true, background_color: '080808' });
    await sleep(500);
    await evaluate(sessionId, 'location.href = "/big"');
    await sleep(4000);
    sessionId = await openPage('/big');
    check(
        'the far end of a 9000 element document is painted',
        await bg('document.getElementById("big8999")'),
        DARK
    );
    check(
        'the far end of a 9000 element document is measured',
        await bg('document.getElementById("big8998")'),
        CLEAR
    );

    /* ----------------------------------------------------- a font-only override */

    // No color override: the stylesheet only changes the font, and shadow trees
    // still need the agent to carry it across the boundary.
    await evaluate(sessionId, 'location.href = "/?fonts"');
    await sleep(1000);
    await settings({
        DefaultBrowserColor: true,
        DefaultBrowserFont: false,
        OverrideFontName: 'Georgia'
    });
    await sleep(2500);
    sessionId = await openPage('fonts');
    check(
        'a font-only override keeps the page colors',
        await evaluate(
            sessionId,
            'getComputedStyle(document.body).backgroundColor'
        ),
        WHITE
    );
    check(
        'a font-only override reaches into a shadow tree',
        await evaluate(
            sessionId,
            'getComputedStyle(document.getElementById("widget").shadowRoot.getElementById("shadowText")).fontFamily'
        ),
        'Georgia, sans-serif'
    );

    await settings({ DefaultBrowserColor: false });
    await sleep(2000);
    check(
        'the color override comes back on the same page',
        await evaluate(sessionId, 'getComputedStyle(document.body).color'),
        TEXT
    );

    /* ---------------------------------------- a document replaced right away */

    // The frame keeps its id across the redirect, so work queued for the first
    // document must not land in the one that replaced it - which is excluded
    // from the override and has to stay the way the site wrote it. The storage
    // write fires at the same time, queueing a sync that still carries the old
    // URL.
    await settings({
        OverrideAll: true,
        DefaultBrowserFont: true,
        NotOverridenPages: [`http://localhost:${PORT}/plain`]
    });
    await sleep(1000);
    await evaluate(sessionId, 'location.href = "/redirect"');
    await settings({ background_color: '445566' });
    await sleep(2000);
    sessionId = await openPage('/plain');
    check(
        'a document that replaced another is left alone if it is excluded',
        await settles(
            () =>
                evaluate(
                    sessionId,
                    'getComputedStyle(document.body).backgroundColor'
                ),
            WHITE
        ),
        WHITE
    );
    check(
        'and its elements too',
        await evaluate(
            sessionId,
            'getComputedStyle(document.getElementById("p")).backgroundColor'
        ),
        CLEAR
    );

    /* ------------------------------------------ back into a restored document */

    // A document coming back from the back/forward cache commits again with the
    // id it already had, and it still holds the stylesheet it was left with. It
    // is not a new document: what it has to be given is the difference, and
    // what it was left with has to stay removable - a stylesheet forgotten
    // while it is still in a page is one nothing can take out again.
    await settings({
        OverrideAll: true,
        NotOverridenPages: [],
        background_color: '080808'
    });
    await sleep(1500);
    await evaluate(sessionId, 'location.href = "/?cached"');
    await sleep(2500);
    sessionId = await openPage('cached');
    check('the page to be cached is styled', await bg('document.body'), DARK);
    await evaluate(sessionId, 'window.__cacheMarker = 1');
    const documentBefore = await topDocumentId();

    await evaluate(sessionId, 'location.href = "/plain"');
    await sleep(2000);
    sessionId = await openPage('/plain');
    // The colors change while the page sits in the cache.
    await settings({ background_color: '223344' });
    await sleep(1500);
    await evaluate(sessionId, 'history.back()');
    await sleep(3000);
    sessionId = await openPage('cached');
    // Everything below is about a *restored* document. A browser that reloaded
    // the page instead would pass the colour checks without ever exercising
    // that path, so this is asserted rather than reported.
    check(
        'the document really came back from the back/forward cache',
        await evaluate(sessionId, 'window.__cacheMarker === 1'),
        true
    );
    check(
        'and came back as the same document',
        await topDocumentId(),
        documentBefore
    );
    check(
        'a document coming back gets the colors chosen while it was away',
        await bg('document.body'),
        'rgb(34, 51, 68)'
    );

    await settings({ OverrideAll: false });
    await sleep(2000);
    check(
        'and the stylesheet it was left with is still removable',
        await bg('document.body'),
        WHITE
    );

    /* ------------------ back into a restored document with the override off */

    // Turning the override off while a page sits in the cache has to reach that
    // page when it comes back: the stylesheet in it, the one in its sub frame,
    // and the agent it was left running, which is what styles its shadow trees.
    const shadowColor = () =>
        evaluate(
            sessionId,
            'getComputedStyle(document.getElementById("widget").shadowRoot' +
                '.getElementById("shadowText")).color'
        );

    await settings({ OverrideAll: true, background_color: '080808' });
    await sleep(1500);
    await evaluate(sessionId, 'location.href = "/?agent"');
    await sleep(3000);
    sessionId = await openPage('agent');
    check(
        'the page about to be cached is styled',
        await bg('document.body'),
        DARK
    );
    check('its sub frame is styled', await frameBodyBg(), DARK);
    check('its shadow tree is styled', await shadowColor(), TEXT);
    await evaluate(sessionId, 'window.__cacheMarker = 1');

    await evaluate(sessionId, 'location.href = "/plain"');
    await sleep(2000);
    sessionId = await openPage('/plain');
    await settings({ OverrideAll: false });
    await sleep(1500);
    await evaluate(sessionId, 'history.back()');
    await sleep(3000);
    sessionId = await openPage('agent');
    check(
        'the document with the sub frame came back from the cache',
        await evaluate(sessionId, 'window.__cacheMarker === 1'),
        true
    );
    check(
        'a restored document loses the stylesheet it was left with',
        await bg('document.body'),
        WHITE
    );
    check('its sub frame loses its stylesheet too', await frameBodyBg(), WHITE);
    check(
        'and its shadow tree goes back to the site colors',
        await shadowColor(),
        'rgb(15, 15, 15)'
    );

    /* ------------------------- settings changes on a page that was restored */

    // Everything below happens on the restored page, with no navigation of any
    // kind: nothing commits, and the frame tree still does not list the sub
    // frame it came back with. A resync has to find it the same way the restore
    // did, or the page goes on with a stylesheet nothing is taking care of any
    // more.
    await settings({ OverrideAll: true, background_color: '080808' });
    await sleep(2000);
    check(
        'the override comes back on a restored page',
        await bg('document.body'),
        DARK
    );
    check('and on the sub frame it came back with', await frameBodyBg(), DARK);
    check('and in its shadow tree', await shadowColor(), TEXT);

    await settings({ background_color: '223344' });
    await sleep(2000);
    check(
        'a color change reaches the restored page',
        await bg('document.body'),
        'rgb(34, 51, 68)'
    );
    check('and its sub frame', await frameBodyBg(), 'rgb(34, 51, 68)');

    await settings({ OverrideAll: false });
    await sleep(2000);
    check(
        'and turning it off leaves nothing behind on either',
        [await bg('document.body'), await frameBodyBg()],
        [WHITE, WHITE]
    );

    /* ------------- a page the extension does not touch, and back to a cached one */

    // Moving to a page the extension leaves alone must not make it forget the
    // stylesheets it put in the pages behind it. Their text is the only thing
    // that can take them out again.
    await settings({ OverrideAll: true, background_color: '080808' });
    await sleep(1500);
    await evaluate(sessionId, 'location.href = "/?ignored"');
    await sleep(3000);
    sessionId = await openPage('ignored');
    check(
        'the page behind the untouched one is styled',
        await bg('document.body'),
        DARK
    );
    await evaluate(sessionId, 'window.__cacheMarker = 1');

    await evaluate(sessionId, 'location.href = "about:blank"');
    await sleep(2500);
    sessionId = await openPage('about:blank');
    await settings({ background_color: '445566' });
    await sleep(1500);
    await evaluate(sessionId, 'history.back()');
    await sleep(3000);
    sessionId = await openPage('ignored');
    check(
        'the document behind the untouched page came back from the cache',
        await evaluate(sessionId, 'window.__cacheMarker === 1'),
        true
    );
    await settings({ OverrideAll: false });
    await sleep(2000);
    check(
        'and the stylesheet it was left with survived the detour, and comes out',
        await bg('document.body'),
        WHITE
    );

    /* --------------------------------------------------- a prerendered page */

    // A page being prerendered lives in the same tab as the page on screen, and
    // its own top level frame does not have frame id 0. Read as a sub frame of
    // the page on screen, it would be given that page's decision - here, the
    // override that the prerendered URL is excluded from.
    //
    // Nothing here attaches to a page: Chrome turns prerendering off for a tab
    // that has DevTools attached, which is what this test would otherwise be.
    // The tab is driven through the extension's own APIs, and what is checked is
    // what the extension made of the prerendered page - the page it filed it
    // under, which is where the mistake would be.
    // What the browser tells the extension about the pages in this tab. The same
    // events the extension itself listens to, so this is evidence a page really
    // was prerendered rather than an assumption that one was.
    const watchCommits = () =>
        evaluate(
            workerSession,
            `(() => {
        self.__commits = [];
        self.__watch = d => self.__commits.push({
            url: d.url,
            frameId: d.frameId,
            frameType: d.frameType,
            lifecycle: d.documentLifecycle,
            documentId: d.documentId
        });
        chrome.webNavigation.onCommitted.addListener(self.__watch);
    })()`
        );
    const commits = () =>
        evaluate(workerSession, 'JSON.stringify(self.__commits)');
    const stopWatching = () =>
        evaluate(
            workerSession,
            'chrome.webNavigation.onCommitted.removeListener(self.__watch)'
        );

    const stateOfTab = () =>
        evaluate(
            workerSession,
            `(async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id});
        const top = frames.find(frame => frame.frameId === 0);
        const key = 'injected:' + tab.id;
        const record = (await chrome.storage.session.get(key))[key] || {pages: {}};
        return JSON.stringify({
            onScreenDocument: top ? top.documentId : null,
            pages: record.pages || {},
            showing: record.top,
            decided: Boolean((record.decisions || {})[top && top.documentId])
        });
    })()`
        );
    const goTo = (where) =>
        evaluate(
            workerSession,
            `(async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        await chrome.tabs.update(tab.id, {url: ${JSON.stringify('')} + ${JSON.stringify(where)}});
    })()`
        );

    await settings({
        OverrideAll: true,
        background_color: '080808',
        NotOverridenPages: [`http://localhost:${PORT}/prerendered`]
    });
    await sleep(1000);
    await watchCommits();
    await goTo(`http://localhost:${PORT}/speculate`);
    await sleep(6000);

    const seen = JSON.parse(await commits());
    await stopWatching();
    const prerenderCommit = seen.find(function (commit) {
        return (
            commit.lifecycle === 'prerender' &&
            commit.url.includes('/prerendered')
        );
    });

    if (!prerenderCommit) {
        console.log(
            'SKIP  this browser did not prerender the page, so what the ' +
                'extension made of a prerendered page was not checked. Commits seen: ' +
                JSON.stringify(
                    seen.map(
                        (c) =>
                            c.lifecycle +
                            ' ' +
                            c.frameType +
                            ' ' +
                            c.url.slice(-12)
                    )
                )
        );
    } else {
        console.log(
            '      (the prerendered page committed as frameId ' +
                prerenderCommit.frameId +
                ', frameType ' +
                prerenderCommit.frameType +
                ')'
        );
        const state = JSON.parse(await stateOfTab());
        check(
            'a prerendered page is filed as a page of its own',
            state.pages[prerenderCommit.documentId],
            prerenderCommit.documentId
        );
        check(
            'not as part of the page on screen',
            state.pages[prerenderCommit.documentId] === state.onScreenDocument,
            false
        );
        check(
            'and the page on screen is still the one the tab is showing',
            state.showing,
            state.onScreenDocument
        );
        check('with the decision taken for it', state.decided, true);
    }

    await goTo(`http://localhost:${PORT}/prerendered`);
    await sleep(3000);
    sessionId = await openPage('/prerendered');
    check(
        'and it is left alone once it is the page on screen',
        await bg('document.body'),
        WHITE
    );
    check('sub frame included', await frameBodyBg(), WHITE);
} catch (e) {
    console.log('FAIL  integration run -> ' + e);
    results.push(false);
} finally {
    chrome.kill();
    server.close();
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    process.exit(passed === results.length ? 0 : 1);
}
