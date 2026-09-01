// Checks the stylesheet produced by buildCss() against a real Chrome layout:
// the page must be recolored, and a video plus everything stacked on top of it
// must stay transparent so the video is not painted over.
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULTS, buildCss} from '../common/settings.js';
import {fileURLToPath} from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8124;

const PAGE = `<!doctype html><html><head><style>
#deep { background: #ffffff; }
</style></head><body style="background:#ffffff;color:#111">
<h1 id="h">hello</h1>
<div id="outer" style="background:#fff"><div id="mid" style="background:#fff">
  <div id="player" style="position:relative;width:320px;height:180px;background:#fff">
    <video id="v" width="320" height="180" style="background:#fff"></video>
    <div id="overlay" style="position:absolute;inset:0;background:#ffffff"></div>
  </div>
</div></div>
<div id="menu" style="background:#ffffff">dropdown</div>
<div id="hero" style="width:400px;height:200px;background-image:url(/hero.gif);background-size:cover;background-color:#fff">
  <h2 id="heroText" style="background:#ffffff">headline over the banner</h2>
</div>
<div id="placeholder" style="width:400px;height:200px;background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==);background-color:#fff"><span id="placeholderText">lazy</span></div>
<img id="img" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
<a id="a" href="https://example.com/">link</a>
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

    const settings = Object.assign({}, DEFAULTS, {DefaultBrowserFont: false, OverrideFontName: 'Georgia', FontSize: '14'});
    const css = buildCss(settings);

    const parsed = await evaluate(sessionId, `(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        return style.sheet.cssRules.length;
    })()`);
    check('every rule in the generated stylesheet parses', parsed, css.split('}').length - 1);

    const bg = id => evaluate(sessionId, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);
    const color = id => evaluate(sessionId, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).color`);

    check('body background', await evaluate(sessionId, 'getComputedStyle(document.body).backgroundColor'), 'rgb(8, 8, 8)');
    check('heading text color', await color('h'), 'rgb(232, 232, 232)');
    check('link color', await color('a'), 'rgb(46, 121, 219)');
    check('unrelated element stays opaque', await bg('menu'), 'rgb(8, 8, 8)');
    check('font override applied', await evaluate(sessionId, 'getComputedStyle(document.body).fontFamily'), 'Georgia, sans-serif');
    check('font size override applied', await evaluate(sessionId, 'getComputedStyle(document.body).fontSize'), '18.6667px');

    check('video element transparent', await bg('v'), 'rgba(0, 0, 0, 0)');
    check('overlay above the video transparent', await bg('overlay'), 'rgba(0, 0, 0, 0)');
    check('player container transparent', await bg('player'), 'rgba(0, 0, 0, 0)');
    check('grandparent of the video transparent', await bg('mid'), 'rgba(0, 0, 0, 0)');
    check('great-grandparent of the video transparent', await bg('outer'), 'rgba(0, 0, 0, 0)');

    const heroImage = await evaluate(sessionId, 'getComputedStyle(document.getElementById("hero")).backgroundImage');
    check('hero background image survives', heroImage.startsWith('url('), true);

    // Before marker.js runs, the headline is painted over the banner.
    check('headline over the banner is opaque without the marker', await bg('heroText'), 'rgb(8, 8, 8)');

    const markerSource = fs.readFileSync(fileURLToPath(new URL('../marker.js', import.meta.url)), 'utf8');
    await evaluate(sessionId, markerSource);
    await sleep(1200);

    check('banner is marked', await evaluate(sessionId,
        'document.getElementById("hero").hasAttribute("data-changecolors-bgimage")'), true);
    check('headline over the banner becomes transparent', await bg('heroText'), 'rgba(0, 0, 0, 0)');
    check('lazy-loading placeholder is not marked', await evaluate(sessionId,
        'document.getElementById("placeholder").hasAttribute("data-changecolors-bgimage")'), false);
    check('content outside a banner stays opaque', await bg('menu'), 'rgb(8, 8, 8)');

    // Dynamically added banners are picked up by the observer.
    await evaluate(sessionId, `(() => {
        const el = document.createElement('div');
        el.id = 'late';
        el.style.cssText = 'width:400px;height:200px;background-image:url(/hero.gif);background-size:cover';
        el.innerHTML = '<span id="lateText" style="background:#fff">late</span>';
        document.body.appendChild(el);
    })()`);
    await sleep(1200);
    check('banner added after load is marked', await bg('lateText'), 'rgba(0, 0, 0, 0)');

    await evaluate(sessionId, 'window.__changeColorsMarker.stop()');
    check('stopping the marker removes its attributes', await evaluate(sessionId,
        'document.querySelectorAll("[data-changecolors-bgimage]").length'), 0);
    await evaluate(sessionId, markerSource);
    await sleep(1200);

    // Hiding images must still work.
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
