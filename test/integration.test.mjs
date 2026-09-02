// Loads the real extension in Chrome and drives it the way a user does.
//
// The unit-level test injects the stylesheet and agent.js into a page itself,
// so it never exercises the service worker: the stylesheet a tab already has,
// navigations, sub frames and the storage writes the options page makes on
// every `input` event are all its business, and that is where a tab can end up
// with a stylesheet nothing is able to remove any more.
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PORT = 8127;
const EXTENSION = fileURLToPath(new URL('..', import.meta.url));

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
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
        path.join(os.homedir(), '.cache', 'ms-playwright'),
        path.join(os.homedir(), '.cache', 'puppeteer')
    ].filter(Boolean);
    for (const cache of caches) {
        let entries = [];
        try {
            entries = fs.readdirSync(cache).sort().reverse();
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (!/^chrom/.test(entry) || /headless_shell/.test(entry)) {
                continue;
            }
            for (const inner of ['chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac']) {
                for (const binary of ['chrome.exe', 'chrome', 'Chromium.app/Contents/MacOS/Chromium']) {
                    candidates.push(path.join(cache, entry, inner, binary));
                }
            }
        }
    }
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const CHROME = findBrowser();
if (!CHROME) {
    console.log('SKIP  integration test: no Chromium that accepts --load-extension was found.');
    console.log('      Point $CHROME_UNBRANDED at one, or run `npx playwright install chromium`.');
    process.exit(0);
}

const FRAME = `<!doctype html><html><body style="background:#ffffff;color:#111">
<p id="p">framed</p>
<div id="frameOverlay" style="position:absolute;inset:0"></div>
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

const server = http.createServer((req, res) => {
    const body = req.url.startsWith('/frame') ? FRAME :
        req.url.startsWith('/big') ? BIG :
        req.url.startsWith('/redirect') ? REDIRECT :
        req.url.startsWith('/plain') ? PLAIN : PAGE;
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(body);
}).listen(PORT);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-int-'));
const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--no-first-run',
    '--no-default-browser-check',
    `http://localhost:${PORT}/`
], {stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']});

let nextId = 0;
const pending = new Map();
let buffer = Buffer.alloc(0);
chrome.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
        const raw = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
});
function send(method, params = {}, sessionId) {
    const id = ++nextId;
    const m = {id, method, params};
    if (sessionId) m.sessionId = sessionId;
    chrome.stdio[3].write(JSON.stringify(m) + '\0');
    return new Promise(r => pending.set(id, r));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evaluate(sessionId, expression) {
    const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
    if (r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception).slice(0, 300));
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
    const {result: {sessionId}} = await send('Target.attachToTarget', {targetId: target.targetId, flatten: true});
    await send('Runtime.enable', {}, sessionId);
    return sessionId;
}

const results = [];
function check(name, actual, expected) {
    const ok = actual === expected;
    results.push(ok);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  -> got ${actual}, expected ${expected}`));
}

const WHITE = 'rgb(255, 255, 255)';
const DARK = 'rgb(8, 8, 8)';
const CLEAR = 'rgba(0, 0, 0, 0)';
const TEXT = 'rgb(232, 232, 232)';

try {
    await sleep(3000);
    const worker = await findTarget(x => x.type === 'service_worker' && x.url.endsWith('/background.js'));
    if (!worker) {
        const t = await send('Target.getTargets');
        throw new Error('the extension service worker never showed up: ' +
            (t.result.targetInfos || []).map(x => x.type + ' ' + x.url).join(' | '));
    }
    const workerSession = await attach(worker);

    // Everything the popup and the options page do is a write to storage.
    const settings = patch => evaluate(workerSession,
        `chrome.storage.local.set(${JSON.stringify(patch)})`);

    const pageTarget = await findTarget(x => x.type === 'page' && x.url.startsWith('http://localhost'));
    let sessionId = await attach(pageTarget);
    const bg = expression => evaluate(sessionId, `getComputedStyle(${expression}).backgroundColor`);
    const FRAME_DOC = "document.getElementById('f').contentDocument";
    const frameBg = id => bg(`${FRAME_DOC}.getElementById(${JSON.stringify(id)})`);
    const frameBodyBg = () => bg(`${FRAME_DOC}.body`);

    check('page starts unstyled', await bg('document.body'), WHITE);

    await settings({OverrideAll: true});
    await sleep(1500);
    check('turning the override on styles the open page', await bg('document.body'), DARK);
    check('and the elements inside it', await bg('document.getElementById("solid")'), DARK);
    check('and clears what has no background of its own',
        await bg('document.getElementById("overlay")'), CLEAR);
    check('and the sub frame', await frameBodyBg(), DARK);

    /* ------------------------------------------------- navigating with a frame */

    await evaluate(sessionId, 'location.href = "/?second"');
    await sleep(2500);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('second')));
    check('a new document is styled', await bg('document.body'), DARK);
    check('its sub frame is styled too', await frameBodyBg(), DARK);
    check('the sub frame is measured as well', await frameBg('frameOverlay'), CLEAR);

    /* --------------------------------------------------- rapid storage writes */

    // The options page writes on every `input` event: dragging a color picker
    // sends a burst like this one. Each write makes the worker swap the tab's
    // stylesheet for a new one, and a swap that overlaps with the next leaves a
    // stylesheet behind that can never be removed again.
    await evaluate(workerSession, `(async () => {
        for (let i = 0; i < 40; i++) {
            chrome.storage.local.set({background_color: (0x101010 + i * 0x010101).toString(16)});
        }
        await chrome.storage.local.set({background_color: '112233'});
    })()`);
    await sleep(3000);
    check('the last color of a burst of writes is the one that applies',
        await bg('document.body'), 'rgb(17, 34, 51)');

    await settings({OverrideAll: false});
    await sleep(2000);
    check('turning the override off leaves no stylesheet behind',
        await bg('document.body'), WHITE);
    check('and none in the sub frame either', await frameBodyBg(), WHITE);

    /* ------------------------------------------- a document larger than a flush */

    await settings({OverrideAll: true, background_color: '080808'});
    await sleep(500);
    await evaluate(sessionId, 'location.href = "/big"');
    await sleep(4000);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('/big')));
    check('the far end of a 9000 element document is painted',
        await bg('document.getElementById("big8999")'), DARK);
    check('the far end of a 9000 element document is measured',
        await bg('document.getElementById("big8998")'), CLEAR);

    /* ----------------------------------------------------- a font-only override */

    // No color override: the stylesheet only changes the font, and shadow trees
    // still need the agent to carry it across the boundary.
    await evaluate(sessionId, 'location.href = "/?fonts"');
    await sleep(1000);
    await settings({DefaultBrowserColor: true, DefaultBrowserFont: false, OverrideFontName: 'Georgia'});
    await sleep(2500);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('fonts')));
    check('a font-only override keeps the page colors',
        await evaluate(sessionId, 'getComputedStyle(document.body).backgroundColor'), WHITE);
    check('a font-only override reaches into a shadow tree', await evaluate(sessionId,
        'getComputedStyle(document.getElementById("widget").shadowRoot.getElementById("shadowText")).fontFamily'),
        'Georgia, sans-serif');

    await settings({DefaultBrowserColor: false});
    await sleep(2000);
    check('the color override comes back on the same page',
        await evaluate(sessionId, 'getComputedStyle(document.body).color'), TEXT);

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
    await settings({background_color: '445566'});
    await sleep(4000);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('/plain')));
    check('a document that replaced another is left alone if it is excluded',
        await evaluate(sessionId, 'getComputedStyle(document.body).backgroundColor'), WHITE);
    check('and its elements too',
        await evaluate(sessionId, 'getComputedStyle(document.getElementById("p")).backgroundColor'), CLEAR);

    /* ------------------------------------------ back into a restored document */

    // A document coming back from the back/forward cache commits again with the
    // id it already had, and it still holds the stylesheet it was left with. It
    // is not a new document: what it has to be given is the difference, and
    // what it was left with has to stay removable - a stylesheet forgotten
    // while it is still in a page is one nothing can take out again.
    await settings({OverrideAll: true, NotOverridenPages: [], background_color: '080808'});
    await sleep(1500);
    await evaluate(sessionId, 'location.href = "/?cached"');
    await sleep(2500);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('cached')));
    check('the page to be cached is styled', await bg('document.body'), DARK);
    await evaluate(sessionId, 'window.__cacheMarker = 1');

    await evaluate(sessionId, 'location.href = "/plain"');
    await sleep(2000);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('/plain')));
    // The colors change while the page sits in the cache.
    await settings({background_color: '223344'});
    await sleep(1500);
    await evaluate(sessionId, 'history.back()');
    await sleep(3000);
    sessionId = await attach(await findTarget(x => x.type === 'page' && x.url.includes('cached')));
    console.log('      (the document came back ' +
        (await evaluate(sessionId, 'window.__cacheMarker === 1') ?
            'from the back/forward cache)' : 'freshly loaded, not from the cache)'));
    check('a document coming back gets the colors chosen while it was away',
        await bg('document.body'), 'rgb(34, 51, 68)');

    await settings({OverrideAll: false});
    await sleep(2000);
    check('and the stylesheet it was left with is still removable',
        await bg('document.body'), WHITE);
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
