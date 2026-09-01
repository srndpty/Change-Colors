// Guards the cost of the styling on a busy page.
//
// A selector can be correct and still be unusable: a `:has()` chain walking up
// from every <video> once made Chrome spend two hundred times longer
// recalculating styles on a page with a live chat, which is what made sites
// like Twitch feel sluggish. This measures the browser's own style
// recalculation time with and without the extension, on a page shaped like one:
// a chat appending and dropping nodes, a container flipping classes the way a
// player shows its controls, and an inline style changing every frame.
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULTS} from '../common/settings.js';
import {buildCss, buildShadowCss} from '../common/css.js';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8126;
const WINDOW = 6000;
// The regression this guards against was measured in seconds, not milliseconds.
const MAX_EXTRA_RECALC_SECONDS = 1;

const PAGE = `<!doctype html><html><head><style>
body { background:#fff; color:#111; font: 13px sans-serif; margin:0 }
.panel { background:#f5f5f5; padding:8px }
.msg { padding:2px 6px }
.msg .name { color:#6441a5; font-weight:bold }
.overlay { position:absolute; inset:0 }
.player { position:relative; width:640px; height:360px; background:#000 }
.hovered .controls { opacity:1 }
.controls { position:absolute; bottom:0; left:0; right:0; height:40px }
.card { background:#fff; border:1px solid #ddd; margin:4px; padding:6px }
</style></head><body>
<div id="app">
  <div id="player" class="player">
    <video id="v" width="640" height="360"></video>
    <div class="overlay" id="overlay"></div>
    <div class="controls"><div id="volume" style="width:50px;height:8px;background:#999"></div></div>
  </div>
  <div id="grid"></div>
  <div class="panel"><div id="chat"></div></div>
</div>
<script>
  const grid = document.getElementById('grid');
  for (let i = 0; i < 300; i++) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<span class="name">streamer ' + i + '</span><span> is live</span>';
    grid.appendChild(card);
  }
  const chat = document.getElementById('chat');
  const player = document.getElementById('player');
  const app = document.getElementById('app');
  const volume = document.getElementById('volume');
  let n = 0;
  setInterval(() => {
    for (let i = 0; i < 3; i++) {
      const line = document.createElement('div');
      line.className = 'msg';
      line.innerHTML = '<span class="name">user' + (n % 50) + '</span><span>: message ' + (n++) + '</span>';
      chat.appendChild(line);
    }
    while (chat.children.length > 120) chat.removeChild(chat.firstChild);
  }, 50);
  setInterval(() => { player.classList.toggle('hovered'); app.classList.toggle('active'); }, 100);
  let w = 0;
  const tick = () => { volume.style.width = (30 + (w++ % 60)) + 'px'; requestAnimationFrame(tick); };
  tick();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(PAGE);
}).listen(PORT);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perf-'));
const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--window-size=1280,900', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', `http://localhost:${PORT}/`
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
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception).slice(0, 300));
    return r.result.result.value;
}
async function recalcSeconds(sessionId) {
    const r = await send('Performance.getMetrics', {}, sessionId);
    return r.result.metrics.find(m => m.name === 'RecalcStyleDuration').value;
}

let failed = false;
try {
    await sleep(2500);
    let page = null;
    for (let i = 0; i < 30 && !page; i++) {
        const t = await send('Target.getTargets');
        page = (t.result.targetInfos || []).find(x => x.type === 'page' && x.url.startsWith('http://localhost'));
        if (!page) await sleep(400);
    }
    const {result: {sessionId}} = await send('Target.attachToTarget', {targetId: page.targetId, flatten: true});
    await send('Runtime.enable', {}, sessionId);
    await send('Performance.enable', {}, sessionId);
    await sleep(2000);

    const baseStart = await recalcSeconds(sessionId);
    await sleep(WINDOW);
    const baseline = await recalcSeconds(sessionId) - baseStart;

    await evaluate(sessionId, `(() => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(buildCss(DEFAULTS))};
        document.documentElement.appendChild(s);
    })()`);
    await evaluate(sessionId, fs.readFileSync(fileURLToPath(new URL('../agent.js', import.meta.url)), 'utf8'));
    await evaluate(sessionId, `window.__changeColorsAgent.setCss(${JSON.stringify(buildShadowCss(DEFAULTS))})`);
    await sleep(2000);

    const styledStart = await recalcSeconds(sessionId);
    await sleep(WINDOW);
    const styled = await recalcSeconds(sessionId) - styledStart;

    const extra = styled - baseline;
    console.log(`style recalculation over ${WINDOW / 1000}s: ` +
        `${baseline.toFixed(3)}s without the extension, ${styled.toFixed(3)}s with it ` +
        `(+${extra.toFixed(3)}s)`);
    failed = !(extra < MAX_EXTRA_RECALC_SECONDS);
    console.log((failed ? 'FAIL  ' : 'PASS  ') +
        `extra style recalculation stays under ${MAX_EXTRA_RECALC_SECONDS}s`);
} catch (e) {
    console.log('FAIL  perf run -> ' + e);
    failed = true;
} finally {
    chrome.kill();
    server.close();
    process.exit(failed ? 1 : 0);
}
