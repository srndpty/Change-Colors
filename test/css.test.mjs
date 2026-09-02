// Checks the generated stylesheet and agent.js against a real Chrome layout:
// the page must be recolored, while everything a site stacks on top of its own
// content - video overlays, banner headlines, ripple layers over a menu entry -
// must stay see-through instead of covering what is underneath.
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findChrome, reportLaunchFailure, skipWithoutChrome} from './browser.mjs';
import {DEFAULTS} from '../common/settings.js';
import {buildCss, buildShadowCss} from '../common/css.js';

const CHROME = findChrome();
if (!CHROME) {
    skipWithoutChrome('css test');
}
const PORT = 8124;

const PAGE = `<!doctype html><html><head><style>
/* The kind of declaration that used to beat the extension. */
#stubborn { color: #0f0f0f !important; background-color: #ffffff !important; }
/* The kind of rule that gives a descendant a background when an ancestor's
   class changes - a theme switch, an expanded menu. */
.dark #themed { background-color: #ffffff; }
</style></head><body style="background:#ffffff;color:#111">
<h1 id="h">hello</h1>

<div id="outer" style="background:#fff"><div id="mid" style="background:#fff">
  <div id="player" style="position:relative;width:320px;height:180px;background:#fff">
    <video id="v" width="320" height="180"></video>
    <div id="videoOverlay" style="position:absolute;inset:0"></div>
  </div>
</div></div>

<div id="menu" style="background:#ffffff">dropdown</div>
<!-- A site that happens to use one of the ids the specificity padding names.
     The padding must count for specificity without leaving anything out. -->
<div id="changecolors-a" style="background:#ffffff">a site's own element</div>
<div id="stubborn">styled with !important by the site</div>

<div id="hero" style="position:relative;width:400px;height:200px;background-image:url(/hero.gif);background-size:cover">
  <h2 id="heroText">headline over the banner</h2>
</div>

<!-- A menu entry with a transparent ripple layer stacked on top of its label. -->
<div id="entry" style="position:relative;width:200px;height:40px">
  <span id="entryLabel">Home</span>
  <div id="ripple" style="position:absolute;inset:0"></div>
</div>

<div id="scrim" style="background:rgba(255,255,255,0.5)">translucent</div>
<!-- Colors a site writes in a modern syntax: getComputedStyle gives them back
     as oklch(), not as rgb(). -->
<div id="modern" style="background: oklch(0.85 0.1 240)">modern color</div>
<div id="modernScrim" style="background: oklch(0.85 0.1 240 / 0.4)">modern translucent</div>
<div id="dynamic">dynamic background</div>

<!-- A background a descendant only gets through an ancestor's class... -->
<div id="theme"><div id="themed">themed</div></div>
<!-- ...or through an inherited custom property. -->
<div id="varHost" style="--surface: transparent"><div id="varChild" style="background: var(--surface)">var</div></div>

<img id="img" src="/hero.gif" width="200" height="120" />
<a id="a" href="https://example.com/">link</a>

<div id="widget"></div>
<script>
  // A component built with shadow DOM, styled the way a light-theme design
  // system does it. A document stylesheet cannot reach inside.
  const host = document.getElementById('widget');
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = '<style>:host{background:#fff}span{color:#0f0f0f;background:#ffffff}' +
      '#shadowOverlay{display:block;height:10px}</style>' +
      '<span id="shadowText">sidebar entry</span>' +
      '<i id="shadowOverlay"></i><div id="nested"></div>';
  const nestedHost = root.getElementById('nested');
  const nestedRoot = nestedHost.attachShadow({mode: 'open'});
  nestedRoot.innerHTML = '<style>b{color:#0f0f0f;background:#fff}</style><b id="nestedText">nested</b>';
</script>
</body></html>`;

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const server = http.createServer((req, res) => {
    if (req.url === '/hero.gif') {
        res.writeHead(200, {'Content-Type': 'image/gif'});
        res.end(PIXEL);
        return;
    }
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(PAGE);
}).listen(PORT);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-css-'));
const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    `http://localhost:${PORT}/`
], {stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']});
reportLaunchFailure(chrome, CHROME, () => server.close());

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
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception));
    return r.result.result.value;
}

const results = [];
function check(name, actual, expected) {
    const ok = actual === expected;
    results.push(ok);
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  -> got ${actual}, expected ${expected}`));
}

const DARK = 'rgb(8, 8, 8)';
const CLEAR = 'rgba(0, 0, 0, 0)';
const TEXT = 'rgb(232, 232, 232)';

try {
    await sleep(3000);
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
        const t = await send('Target.getTargets');
        page = (t.result.targetInfos || []).find(x => x.type === 'page' && x.url.startsWith('http://localhost'));
        if (!page) await sleep(500);
    }
    const {result: {sessionId}} = await send('Target.attachToTarget', {targetId: page.targetId, flatten: true});
    await send('Runtime.enable', {}, sessionId);

    const bg = id => evaluate(sessionId, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);
    const color = id => evaluate(sessionId, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).color`);

    const settings = Object.assign({}, DEFAULTS, {DefaultBrowserFont: false, OverrideFontName: 'Georgia', FontSize: '14'});
    const css = buildCss(settings);

    const parsed = await evaluate(sessionId, `(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        return style.sheet.cssRules.length;
    })()`);
    check('every rule in the generated stylesheet parses', parsed, css.split('}').length - 1);

    /* --------------------------------------------- stylesheet on its own */

    check('body background', await evaluate(sessionId, 'getComputedStyle(document.body).backgroundColor'), DARK);
    check('heading text color', await color('h'), TEXT);
    check('link color', await color('a'), 'rgb(46, 121, 219)');
    check('site !important rule on an id is overridden', await color('stubborn'), TEXT);
    check('site !important background on an id is overridden', await bg('stubborn'), DARK);
    check('font override applied', await evaluate(sessionId, 'getComputedStyle(document.body).fontFamily'), 'Georgia, sans-serif');
    check('font size override applied', await evaluate(sessionId, 'getComputedStyle(document.body).fontSize'), '18.6667px');
    check('hero background image survives',
        (await evaluate(sessionId, 'getComputedStyle(document.getElementById("hero")).backgroundImage')).startsWith('url('), true);
    // Without the agent everything is painted, which is what keeps a page
    // readable when the agent cannot run.
    check('without the agent, elements are painted', await bg('ripple'), DARK);
    // Media itself is never painted, even in that fallback.
    check('video element is never painted', await bg('v'), CLEAR);

    /* ------------------------------------------------------- with the agent */

    const agentSource = fs.readFileSync(fileURLToPath(new URL('../agent.js', import.meta.url)), 'utf8');
    await evaluate(sessionId, agentSource);
    await evaluate(sessionId, `window.__changeColorsAgent.setCss(${JSON.stringify(buildShadowCss(settings))})`);
    await sleep(1000);

    check('transparent overlay over a label is cleared', await bg('ripple'), CLEAR);
    check('transparent overlay over a video is cleared', await bg('videoOverlay'), CLEAR);
    check('video element stays unpainted', await bg('v'), CLEAR);
    check('a player container with its own background keeps one', await bg('player'), DARK);
    check('the label under it keeps its color', await color('entryLabel'), TEXT);
    check('headline over a banner is cleared', await bg('heroText'), CLEAR);
    check('element with a solid background keeps the chosen one', await bg('menu'), DARK);
    check('an element whose id the specificity padding names is overridden too',
        await bg('changecolors-a'), DARK);
    check('and its text as well', await color('changecolors-a'), TEXT);
    check('translucent overlay is cleared', await bg('scrim'), CLEAR);
    check('a solid background written as oklch() is kept, not cleared', await bg('modern'), DARK);
    check('a translucent oklch() background is cleared', await bg('modernScrim'), CLEAR);
    check('body keeps the chosen background', await evaluate(sessionId, 'getComputedStyle(document.body).backgroundColor'), DARK);

    // A change shortly after the initial scan must not be lost. This guards a
    // previous throttle that skipped the mutation without retrying it later.
    await evaluate(sessionId, 'document.getElementById("dynamic").style.backgroundColor = "#fff"');
    await sleep(400);
    check('a newly assigned inline background is remeasured', await bg('dynamic'), DARK);
    await evaluate(sessionId, 'document.getElementById("dynamic").style.removeProperty("background-color")');
    await sleep(400);
    check('removing an inline background makes the element clear again', await bg('dynamic'), CLEAR);

    // Dynamically added content is measured too.
    await evaluate(sessionId, `(() => {
        const el = document.createElement('div');
        el.id = 'late';
        el.innerHTML = '<span id="lateSolid" style="background:#fff">solid</span>' +
            '<span id="lateClear">no background</span>';
        document.body.appendChild(el);
    })()`);
    await sleep(800);
    check('content added later, with a background, is painted', await bg('lateSolid'), DARK);
    check('content added later, without one, is cleared', await bg('lateClear'), CLEAR);

    /* -------------------------------------------- more at once than a flush */

    // A page can hand the agent an unbounded amount of work in one go, in three
    // shapes: subtrees to walk, elements to look at again, and shadow roots
    // found while walking. Each is capped, and what is not taken on is left
    // where it waits rather than copied out and back - which is why what the
    // draining loops looked at is counted as well as what they took.
    //
    // A flush runs to completion, so the marks are read from the agent rather
    // than sampled from outside.
    const agentPending = reset => evaluate(sessionId,
        `JSON.stringify(window.__changeColorsAgent.pending(${reset ? 'true' : 'false'}))`);
    const idle = async (timeout = 20000) => {
        const until = Date.now() + timeout;
        for (;;) {
            const state = JSON.parse(await agentPending(false));
            if ((state.roots === 0 && state.elements === 0 && state.walks === 0) ||
                    Date.now() > until) {
                return state;
            }
            await sleep(100);
        }
    };

    await idle();
    await agentPending(true);

    const ROOTS = 20000;
    await evaluate(sessionId, `(() => {
        // Added straight to the body, so each one is a root of its own to
        // anything watching the document rather than one subtree with many
        // children in it.
        const batch = document.createDocumentFragment();
        for (let i = 0; i < ${ROOTS}; i++) {
            const item = document.createElement('div');
            item.className = 'flood';
            item.appendChild(document.createElement('span'));
            batch.appendChild(item);
        }
        document.body.appendChild(batch);
    })()`);
    const flood = await idle();

    check('no flush takes more subtrees off the waiting list than it may',
        flood.maxRootsFromPending <= flood.limits.rootsPerFlush, true);
    check('and it took the most it may', flood.maxRootsFromPending,
        flood.limits.rootsPerFlush);
    check('the ones it left are left where they wait, not looked at',
        flood.maxRootsSeen <= flood.limits.rootsPerFlush + 1, true);
    check('all of it is measured in the end', await evaluate(sessionId,
        `document.querySelectorAll('div.flood[data-changecolors-clear]').length`), ROOTS);

    /* ------------------------------------------ a flood of elements to recheck */

    // Restyling what is already there is the other way in: every one of these is
    // an element to look at again, not a subtree to walk.
    await agentPending(true);
    await evaluate(sessionId, `(() => {
        document.querySelectorAll('div.flood').forEach((el, i) => {
            el.style.backgroundColor = i % 2 ? '#123456' : '#654321';
        });
    })()`);
    const restyled = await idle();

    check('no flush takes on more elements than it may',
        restyled.maxElementsTaken <= restyled.limits.perFlush, true);
    check('and it took the most it may', restyled.maxElementsTaken,
        restyled.limits.perFlush);
    check('the ones it left are left where they wait, not looked at',
        restyled.maxElementsSeen <= restyled.limits.perFlush + 1, true);
    // Each of them now has a background of its own, so none of them is cleared.
    check('and every one of them is measured again in the end', await evaluate(sessionId,
        `document.querySelectorAll('div.flood:not([data-changecolors-clear])').length`),
        ROOTS);
    await evaluate(sessionId,
        `document.querySelectorAll('div.flood').forEach(el => el.remove())`);
    await idle();

    /* --------------------------------------- a flood of shadow roots in one go */

    // Shadow roots found while walking do not come off the waiting list at all;
    // they go straight into the queue. One subtree holding more of them than the
    // queue may hold is what says the limit is kept where they are queued.
    const HOSTS = 6000;
    await agentPending(true);
    await evaluate(sessionId, `(() => {
        const host = document.createElement('div');
        host.id = 'hosts';
        for (let i = 0; i < ${HOSTS}; i++) {
            const item = document.createElement('div');
            item.className = 'host';
            item.attachShadow({mode: 'open'}).innerHTML = '<span>shadow</span>';
            host.appendChild(item);
        }
        document.body.appendChild(host);
    })()`);
    const hosts = await idle();

    check('the queue of subtrees never grows past what it may hold',
        hosts.maxWalks <= hosts.limits.queuedWalks, true);
    check('and it really was pushed that far',
        hosts.maxWalks, hosts.limits.queuedWalks);
    check('every shadow tree in it is styled', await evaluate(sessionId, `(() => {
        const all = [...document.querySelectorAll('#hosts .host')];
        return all.filter(el => getComputedStyle(el.shadowRoot.querySelector('span')).color
            === 'rgb(232, 232, 232)').length;
    })()`), HOSTS);
    check('and nothing is left waiting',
        `${hosts.roots}/${hosts.elements}/${hosts.walks}`, '0/0/0');
    // Two shadow trees were on the page before this: the widget and the one
    // nested inside it.
    check('and every one of them is held, along with the two already there',
        `${hosts.styledRoots}/${hosts.observedRoots}`, `${HOSTS + 2}/${HOSTS + 2}`);

    // A sweep answers the removals that were known when it started. One that
    // happens while it runs - a host it has already walked past being taken out
    // of the page - is not one of them, and is only found by another pass. The
    // sweep started here has thousands of trees to walk and takes several
    // flushes to do it, so what is removed a moment later is behind it.
    const held = async (want, timeout = 20000) => {
        const until = Date.now() + timeout;
        for (;;) {
            const state = JSON.parse(await agentPending(false));
            if (state.styledRoots <= want || Date.now() > until) {
                return state;
            }
            await sleep(100);
        }
    };
    await evaluate(sessionId, `(() => {
        // A removal of something that is not a host, to set a sweep going.
        const decoy = document.createElement('div');
        document.body.appendChild(decoy);
        decoy.remove();
    })()`);
    await sleep(250);
    await evaluate(sessionId,
        `document.querySelector('#hosts .host').remove()`);
    const overtaken = await held(HOSTS + 1);
    check('a tree the sweep has already walked past is still let go of',
        overtaken.styledRoots, HOSTS + 1);

    // Holding a shadow tree means holding its host and everything under it. A
    // page that rebuilds its components - which is what a long-lived single
    // page application does all day - would hand the agent the whole history of
    // itself if what it holds were only ever added to.
    await evaluate(sessionId, `document.getElementById('hosts').remove()`);
    const dropped = await held(2);
    check('taking them out of the page makes the agent let go of them',
        `${dropped.styledRoots}/${dropped.observedRoots}`, '2/2');
    // And letting go of one is not losing it: a host put back in the page is
    // walked again like anything else added to it.
    await evaluate(sessionId, `(() => {
        const item = document.createElement('div');
        item.id = 'detachable';
        item.attachShadow({mode: 'open'}).innerHTML = '<span id="back">back</span>';
        window.__detached = item;
        document.body.appendChild(item);
    })()`);
    await sleep(600);
    await evaluate(sessionId, `document.getElementById('detachable').remove()`);
    await sleep(600);
    await evaluate(sessionId, 'document.body.appendChild(window.__detached)');
    await sleep(800);
    check('a shadow tree put back in the page is styled again', await evaluate(sessionId,
        `getComputedStyle(document.getElementById('detachable').shadowRoot.getElementById('back')).color`),
        TEXT);
    await evaluate(sessionId, `document.getElementById('detachable').remove()`);
    await sleep(600);

    check('and the trees still in the page are still styled',
        await evaluate(sessionId, `getComputedStyle(${'document.getElementById("widget").shadowRoot.getElementById("shadowText")'}).color`),
        TEXT);
    await idle();

    /* ----------------------------------------------------------- shadow DOM */

    const shadowText = 'document.getElementById("widget").shadowRoot.getElementById("shadowText")';
    const shadowOverlay = 'document.getElementById("widget").shadowRoot.getElementById("shadowOverlay")';
    const nestedText = 'document.getElementById("widget").shadowRoot.getElementById("nested").shadowRoot.getElementById("nestedText")';

    check('shadow tree text takes the chosen color',
        await evaluate(sessionId, `getComputedStyle(${shadowText}).color`), TEXT);
    check('shadow tree element with a background is painted',
        await evaluate(sessionId, `getComputedStyle(${shadowText}).backgroundColor`), DARK);
    check('shadow tree element without one is cleared',
        await evaluate(sessionId, `getComputedStyle(${shadowOverlay}).backgroundColor`), CLEAR);
    check('shadow host background is painted', await bg('widget'), DARK);
    check('nested shadow tree is styled too',
        await evaluate(sessionId, `getComputedStyle(${nestedText}).color`), TEXT);

    // Changes inside a shadow tree are invisible to an observer watching the
    // document, so each root found is watched itself.
    await evaluate(sessionId, `(() => {
        const root = document.getElementById('widget').shadowRoot;
        // Appended, not innerHTML +=, which would rebuild the nested host and
        // take its shadow root with it.
        const late = document.createElement('em');
        late.id = 'shadowLate';
        late.style.background = '#fff';
        const lateClear = document.createElement('u');
        lateClear.id = 'shadowLateClear';
        root.appendChild(late);
        root.appendChild(lateClear);
    })()`);
    await sleep(800);
    check('content added later inside a shadow tree, with a background, is painted',
        await evaluate(sessionId, 'getComputedStyle(document.getElementById("widget").shadowRoot.getElementById("shadowLate")).backgroundColor'), DARK);
    check('content added later inside a shadow tree, without one, is cleared',
        await evaluate(sessionId, 'getComputedStyle(document.getElementById("widget").shadowRoot.getElementById("shadowLateClear")).backgroundColor'), CLEAR);

    /* ------------------------------------------- restyling from an ancestor */

    check('a descendant with no background of its own starts cleared', await bg('themed'), CLEAR);
    await evaluate(sessionId, 'document.getElementById("theme").className = "dark"');
    await sleep(600);
    check('a class on an ancestor is remeasured down the subtree', await bg('themed'), DARK);
    await evaluate(sessionId, 'document.getElementById("theme").className = ""');
    await sleep(600);
    check('removing it clears the descendant again', await bg('themed'), CLEAR);

    check('a descendant reading an empty custom property starts cleared', await bg('varChild'), CLEAR);
    await evaluate(sessionId, 'document.getElementById("varHost").style.setProperty("--surface", "#ffffff")');
    await sleep(600);
    check('a custom property set on an ancestor is remeasured down the subtree', await bg('varChild'), DARK);

    /* ------------------------------------------------- more than one flush */

    // A subtree bigger than one flush's budget must be finished by the next
    // flush, not dropped: the last elements of a big page are exactly the ones
    // a "measure the first few thousand" implementation lost.
    await evaluate(sessionId, `(() => {
        const big = document.createElement('div');
        big.id = 'big';
        const parts = [];
        for (let i = 0; i < 9000; i++) {
            parts.push('<div id="big' + i + '"' +
                (i % 2 ? ' style="background:#fff"' : '') + '>x</div>');
        }
        big.innerHTML = parts.join('');
        document.body.appendChild(big);
    })()`);
    await sleep(3000);
    check('an element past the first flush, with a background, is painted', await bg('big8999'), DARK);
    check('an element past the first flush, without one, is cleared', await bg('big8998'), CLEAR);
    check('every element of a 9000 element subtree was measured', await evaluate(sessionId,
        'document.querySelectorAll("#big > div[data-changecolors-clear]").length'), 4500);
    await evaluate(sessionId, 'document.getElementById("big").remove()');

    /* ---------------------------------------------------------- turning off */

    await evaluate(sessionId, 'window.__changeColorsAgent.stop()');
    check('stopping the agent removes its attributes', await evaluate(sessionId,
        'document.querySelectorAll("[data-changecolors-clear],[data-changecolors-probe]").length'), 0);
    check('stopping the agent removes them inside shadow trees too', await evaluate(sessionId,
        'document.getElementById("widget").shadowRoot.querySelectorAll("[data-changecolors-clear],[data-changecolors-probe]").length'), 0);
    check('stopping the agent restores shadow tree colors',
        await evaluate(sessionId, `getComputedStyle(${shadowText}).color`), 'rgb(15, 15, 15)');

    /* ------------------------------------------- stopping right after starting */

    // The agent rescans the page 500ms, 2s and 5s in, to find shadow roots
    // attached after the first pass. Those must not come back to life after the
    // override is switched off - the page can have been handed to another agent
    // by then.
    await evaluate(sessionId, agentSource);
    await evaluate(sessionId, `window.__changeColorsAgent.setCss(${JSON.stringify(buildShadowCss(settings))})`);
    await evaluate(sessionId, 'window.__changeColorsAgent.stop()');
    await sleep(6000);
    check('an agent stopped before its delayed rescans stays stopped', await evaluate(sessionId,
        'document.querySelectorAll("[data-changecolors-clear],[data-changecolors-probe]").length'), 0);
    check('and leaves no stylesheet in a shadow tree behind',
        await evaluate(sessionId, `getComputedStyle(${shadowText}).color`), 'rgb(15, 15, 15)');
    check('and none in a nested one either',
        await evaluate(sessionId, `getComputedStyle(${nestedText}).color`), 'rgb(15, 15, 15)');

    /* -------------------------------------------------------- hiding images */

    const hidden = buildCss(Object.assign({}, DEFAULTS, {ShowImage: false}));
    await evaluate(sessionId, `(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(hidden)};
        document.head.appendChild(style);
    })()`);
    check('images can be hidden', await evaluate(sessionId, 'getComputedStyle(document.getElementById("img")).display'), 'none');
    check('hiding images also drops CSS background images',
        await evaluate(sessionId, 'getComputedStyle(document.getElementById("hero")).backgroundImage'), 'none');
} catch (e) {
    console.log('FAIL  test run -> ' + e);
    results.push(false);
} finally {
    chrome.kill();
    server.close();
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    process.exit(passed === results.length ? 0 : 1);
}
