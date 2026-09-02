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
     turns prerendering off.

  2. Open http://localhost:${PORT}/prerendered once, and in the extension's
     popup choose "No global override on this page" so this URL is excluded.
     Turn the override on for everything else ("Apply override on all pages").

  3. On chrome://extensions, click "Service Worker" under Change Colors to open
     its console, and paste:

     self.__commits = [];
     chrome.webNavigation.onCommitted.addListener(d => self.__commits.push(
         {url: d.url, frameId: d.frameId, frameType: d.frameType,
          lifecycle: d.documentLifecycle, documentId: d.documentId}));

  4. In the window, go to http://localhost:${PORT}/speculate and wait a few
     seconds. It should be styled.

  5. Back in the service worker console:

     copy(JSON.stringify(self.__commits, null, 1))

     A line with "lifecycle": "prerender" means the browser prerendered the
     page. If there is none, the browser decided not to - try clicking the link
     once first, then going Back and repeating, or check that Preloading is on
     in chrome://settings/performance.

  6. With that document's id from step 5, ask what the extension made of it:

     const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
     const key = 'injected:' + tab.id;
     const record = (await chrome.storage.session.get(key))[key];
     record.pages['<the prerendered documentId>'];

     It must be that same documentId - the prerendered page is a page of its
     own. If it comes back as the id of the page on screen, the prerendered page
     was read as a sub frame of it and given its styling, which is the bug this
     checks for.

  7. Click through to the prerendered page. It must still be white, sub frame
     included, and the popup must show the override as off for it.

Ctrl+C to stop.
`);
