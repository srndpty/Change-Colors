# Change Colors

Chrome extension that restyles web pages with your own background, text and link
colors, your own font, and optional hiding of images and plugin objects.

Original source: https://github.com/Strav/Change-Colors

## Release notes

### 3.0.0 - Manifest V3

The extension was stuck on Manifest V2 and stopped being distributable. It now
runs on Manifest V3, with the same features and the same settings.

- Manifest V3: the background page became a service worker, `page_action` became
  `action`, and host access moved to `host_permissions`.
- Settings moved from `localStorage` (not available to a service worker) to
  `chrome.storage.local`. Settings saved by version 2.x are copied over once, on
  update, through an offscreen document.
- Styling is applied with `chrome.scripting.insertCSS` while the document
  commits, instead of by messaging a content script. There is no content script
  in the package any more, and the stylesheet lands before the first paint; sub
  frames are still covered.
- Keyboard shortcuts use the `commands` API instead of a key handler injected in
  every page. The defaults are unchanged (Ctrl+Shift+P / D / G); Chrome may
  refuse a default that collides with one of its own, in which case set it at
  `chrome://extensions/shortcuts` - the options page links there.
- SPA navigations (`history.pushState`) are now noticed, so per-page overrides
  apply on sites like YouTube without a reload.
- Fixed: **anything a site stacked on top of its own content disappeared or
  covered what was underneath**. Painting an opaque background on every element
  also painted the see-through layers a page puts over its content, so videos
  turned into a black rectangle, hero banners into flat dark boxes, and menu
  entries (YouTube's sidebar) had their labels hidden by the invisible ripple
  layer sitting over them. `agent.js` now measures each element's own
  background, with the extension's rules held off for the length of the
  measurement, and tags the see-through ones so the stylesheet clears them
  again. Painting first and clearing afterwards keeps a page readable even
  where the agent cannot run.
- Fixed: **CSS background images were wiped out**, which turned hero banners
  into flat dark rectangles. Background images now follow the "Show images?"
  option, so they are kept by default and only removed when you turn images off.
- Fixed: **text inside shadow DOM kept its own color** and became unreadable on
  the dark background - whole parts of a page (YouTube's sidebar and its filter
  chips, for example) looked blank. A document stylesheet never crosses a shadow
  boundary, so `agent.js` now adopts the same rules, rewritten around `:host`,
  into every shadow root, nested ones included.
- Fixed: a site's own `!important` declaration on an id or class selector used to
  win against the extension, leaving patches of unreadable text. The generated
  selectors carry specificity padding now.
- Fixed: with "use web pages colors" enabled, the generated stylesheet started
  with the string `undefined` and the whole first rule was dropped.
- Fixed invalid declarations in the generated CSS: `text-shadow: 0` is now
  `text-shadow: none`, and `-webkit-text-fill-color: none` is now
  `currentcolor`, so sites that set a text fill color no longer defeat the text
  color you picked.
- Fixed: a sub frame navigating made the extension evaluate the override rules
  against the frame's URL instead of the page's.
- Fixed: removing a custom font from the options page deleted the wrong entries.
- The options page no longer needs jQuery or the jscolor picker (which relied on
  `eval`, forbidden under Manifest V3). It uses native color inputs, and those
  two libraries were dropped from the package.

### 2.244

- Migrated to manifest v2.
- Reduce flashing when navigate to other website.

## Layout

| Path                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `manifest.json`      | Manifest V3 declaration                                    |
| `background.js`      | Service worker: decides and injects the styling            |
| `common/settings.js` | Settings model, override rules, stylesheet generation      |
| `popup.html/.js`     | Toolbar popup: per page, per domain and global override    |
| `options.html/.js`   | Preferences                                                |
| `offscreen.html/.js` | One-shot reader for version 2.x settings in `localStorage` |
| `common/css.js`      | Stylesheet generation, for the document and for shadow roots |
| `agent.js`           | Styles shadow trees and tags background images, injected on demand |
| `libs/font_detect.js`| Detects which fonts the system has                         |
| `test/css.test.mjs`  | Runs the generated CSS through headless Chrome             |

## Development

Load the folder as an unpacked extension from `chrome://extensions` with
developer mode enabled.

The stylesheet is checked against a real layout in headless Chrome:

```
npm test
```

Set `CHROME` if Chrome is not at the default Windows install path.
