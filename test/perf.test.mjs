// Guards the cost of the styling on a busy page.
//
// A selector can be correct and still be unusable: a `:has()` chain walking up
// from every <video> once made Chrome spend two hundred times longer
// recalculating styles on a page with a live chat, which is what made sites
// like Twitch feel sluggish. This measures the browser's own style
// recalculation time, and the extension's own script time, with and without it,
// on a page shaped like one: a chat appending and dropping nodes, a container
// flipping classes the way a player shows its controls, an inline style
// changing every frame, and - the shape that gets handed to the page agent in
// the largest pieces - hundreds of separate subtrees appearing at once and
// hundreds of separate elements being restyled at once.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    findChrome,
    connectBrowser,
    browserArgs,
    skipWithoutChrome
} from './browser.mjs';
import { DEFAULTS } from '../common/settings.js';
import { buildCss, buildShadowCss } from '../common/css.js';

const CHROME = findChrome();
if (!CHROME) {
    skipWithoutChrome('performance test');
}
const PORT = 8126;
const WINDOW = 6000;
// The regression this guards against was measured in seconds, not milliseconds.
const MAX_EXTRA_RECALC_SECONDS = 1;
// The agent's own work - observer callbacks, walking the DOM, thousands of
// getComputedStyle() calls - is not style recalculation and would not show up
// in the metric above.
const MAX_EXTRA_SCRIPT_SECONDS = 1.5;

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
  // Hundreds of separate subtrees at once: each one is a root of its own for
  // anything watching the document.
  const burstHost = document.createElement('div');
  document.body.appendChild(burstHost);
  // More at once than one flush of the agent will take on, so the deferring is
  // exercised rather than just present.
  setInterval(() => {
    burstHost.textContent = '';
    const batch = document.createDocumentFragment();
    for (let i = 0; i < 8000; i++) {
      const item = document.createElement('div');
      item.className = 'card';
      item.innerHTML = '<span>burst ' + i + '</span>';
      batch.appendChild(item);
    }
    burstHost.appendChild(batch);
  }, 1500);
  // And hundreds of separate elements restyled at once.
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  setInterval(() => { cards.forEach(c => c.classList.toggle('lit')); }, 250);
  let w = 0;
  const tick = () => { volume.style.width = (30 + (w++ % 60)) + 'px'; requestAnimationFrame(tick); };
  tick();
</script>
</body></html>`;

const server = http
    .createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE);
    })
    .listen(PORT);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perf-'));
const chrome = spawn(
    CHROME,
    [
        '--headless=new',
        ...browserArgs(),
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        '--window-size=1280,900',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `http://localhost:${PORT}/`
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }
);
const connection = connectBrowser(chrome, CHROME, {
    onFailure: () => server.close()
});
const { send } = connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
    const r = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
    );
    if (r.result.exceptionDetails)
        throw new Error(
            JSON.stringify(r.result.exceptionDetails.exception).slice(0, 300)
        );
    return r.result.result.value;
}
async function costSeconds(sessionId) {
    const r = await send('Performance.getMetrics', {}, sessionId);
    const value = (name) => r.result.metrics.find((m) => m.name === name).value;
    return {
        recalc: value('RecalcStyleDuration'),
        script: value('ScriptDuration')
    };
}

let failed = false;
try {
    await sleep(2500);
    let page = null;
    for (let i = 0; i < 30 && !page; i++) {
        const t = await send('Target.getTargets');
        page = (t.result.targetInfos || []).find(
            (x) => x.type === 'page' && x.url.startsWith('http://localhost')
        );
        if (!page) await sleep(400);
    }
    const {
        result: { sessionId }
    } = await send('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Performance.enable', {}, sessionId);
    await sleep(2000);

    const baseStart = await costSeconds(sessionId);
    await sleep(WINDOW);
    const baseEnd = await costSeconds(sessionId);

    await evaluate(
        sessionId,
        `(() => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(buildCss(DEFAULTS))};
        document.documentElement.appendChild(s);
    })()`
    );
    await evaluate(
        sessionId,
        fs.readFileSync(
            fileURLToPath(new URL('../agent.js', import.meta.url)),
            'utf8'
        )
    );
    await evaluate(
        sessionId,
        `window.__changeColorsAgent.setCss(${JSON.stringify(buildShadowCss(DEFAULTS))})`
    );
    await sleep(2000);

    const styledStart = await costSeconds(sessionId);
    await sleep(WINDOW);
    const styledEnd = await costSeconds(sessionId);

    const results = [];
    function report(what, baseline, styled, budget) {
        const extra = styled - baseline;
        console.log(
            `${what} over ${WINDOW / 1000}s: ` +
                `${baseline.toFixed(3)}s without the extension, ${styled.toFixed(3)}s with it ` +
                `(+${extra.toFixed(3)}s)`
        );
        const ok = extra < budget;
        results.push(ok);
        console.log(
            (ok ? 'PASS  ' : 'FAIL  ') + `extra ${what} stays under ${budget}s`
        );
    }
    report(
        'style recalculation',
        baseEnd.recalc - baseStart.recalc,
        styledEnd.recalc - styledStart.recalc,
        MAX_EXTRA_RECALC_SECONDS
    );
    report(
        'script time',
        baseEnd.script - baseStart.script,
        styledEnd.script - styledStart.script,
        MAX_EXTRA_SCRIPT_SECONDS
    );
    failed = results.includes(false);
} catch (e) {
    console.log('FAIL  perf run -> ' + e);
    failed = true;
} finally {
    connection.dispose();
    chrome.kill();
    server.close();
    process.exit(failed ? 1 : 0);
}
