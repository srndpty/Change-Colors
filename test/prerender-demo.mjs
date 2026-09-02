// Serves the two pages needed to check by hand what the extension does with a
// page the browser prerenders.
//
// This cannot be automated here: Chrome turns prerendering off for any tab that
// has DevTools attached, and driving a browser from a test means attaching to
// it - the browser reports `PrerenderingDisabledByDevTools` and prerenders
// nothing. So the check has to happen in an ordinary window, with the extension
// loaded, and the observing done from the service worker's own console.
//
//   node test/prerender-demo.mjs
//
// The steps are printed when it starts.
import http from 'node:http';

const PORT = Number(process.env.PORT || 8131);

const SPECULATE = `<!doctype html><html><head><title>speculating</title></head>
<body style="background:#ffffff;color:#111">
<h1>This page asks the browser to prerender the next one</h1>
<p>The extension should style this page.</p>
<p><a href="/prerendered">go to the prerendered page</a></p>
<script type="speculationrules">
{"prerender": [{"urls": ["/prerendered"]}]}
</script>
</body></html>`;

const PRERENDERED = `<!doctype html><html><head><title>prerendered</title></head>
<body style="background:#ffffff;color:#111">
<h1>This page was prerendered</h1>
<p>Exclude this URL from the override: the extension should leave it white,
   before and after it comes on screen.</p>
<iframe src="/frame" width="320" height="90"></iframe>
</body></html>`;

const FRAME = `<!doctype html><html><body style="background:#ffffff;color:#111">
<p>a sub frame of the prerendered page</p>
</body></html>`;

http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(
        req.url.startsWith('/prerendered') ? PRERENDERED :
        req.url.startsWith('/frame') ? FRAME : SPECULATE
    );
}).listen(PORT);

console.log(`
Serving on http://localhost:${PORT}/

  1. Load this folder as an unpacked extension (chrome://extensions, developer
     mode on), in an ordinary window. Do not open DevTools on the pages: that
     turns prerendering off, and nothing will be prerendered at all.

  2. Open http://localhost:${PORT}/prerendered once, and in the extension's
     popup choose "No global override on this page" so this URL is excluded.
     Then "Apply override on all pages" for everything else.

  3. On chrome://extensions, click "Service Worker" under Change Colors to open
     its console. Everything below is pasted there.

     The extension's own record of the tab is what this reads, because it is in
     chrome.storage.session and survives the service worker being stopped and
     started again - which it will be, while you are switching windows. Start
     from a clean one:

     await chrome.storage.session.clear()

  4. In the browser window, go to http://localhost:${PORT}/speculate and wait a
     few seconds. It should be styled.

  5. Back in the service worker console. The tab is looked up by url, not by
     "the current window": a service worker is in no window, so Chrome answers
     that with the window that was focused last - which is the one you are
     typing this into.

     const tabs = await chrome.tabs.query({url: 'http://localhost:${PORT}/*'});
     const tab = tabs.find(t => t.url.includes('speculate')) || tabs[0];
     const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id});
     const onScreen = frames.find(f => f.frameId === 0).documentId;
     const live = new Set(frames.map(f => f.documentId));
     const key = 'injected:' + tab.id;
     const record = (await chrome.storage.session.get(key))[key];
     ({
         onScreen,
         filedUnder: record && record.pages,
         notOnScreen: record
             ? Object.entries(record.pages).filter(([id]) => !live.has(id))
             : 'nothing recorded for this tab - is the override on?'
     })

     \`notOnScreen\` is the documents of this tab that are not part of the page
     you are looking at. Since the record was cleared in step 3 and you have not
     gone Back, they can only be the page the browser prerendered.

       - empty: the browser did not prerender anything. Try clicking the link
         once, going Back, and repeating from step 3; or check that preloading
         is on in chrome://settings/performance.

       - an entry whose value is its own id, e.g. ["ABC…", "ABC…"]: correct. The
         prerendered page was filed as a page of its own, and got its own
         decision - the exclusion you set in step 2.

       - an entry whose value is the id in \`onScreen\`: the bug. The prerendered
         page was read as a sub frame of the page you are looking at, and given
         that page's styling.

  6. Click through to the prerendered page. It must still be white, sub frame
     included, and the popup must offer to apply the override to it rather than
     to remove it.

Ctrl+C to stop.
`);
