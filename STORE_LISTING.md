# Chrome Web Store listing

What goes in the dashboard, and where each field comes from. This file is not
shipped; `npm run stage` does not copy it.

Some of the listing comes out of the package and some is typed into the
dashboard. The ones that come out of the package cannot be edited there, so a
change to them means a new ZIP:

| Field in the store   | Comes from                                |
| -------------------- | ----------------------------------------- |
| Title                | `manifest.json` `name`                    |
| Summary              | `manifest.json` `description`             |
| Version              | `manifest.json` `version`                 |
| Description          | typed into the dashboard - the text below |
| Privacy answers      | typed into the dashboard - the text below |
| Privacy policy URL   | typed into the dashboard - see PRIVACY.md |

## Description

Replace the existing description wholesale. The old one announces the 2023
removal of Manifest V2 extensions, recommends a different extension, and asks
for a maintainer; none of that is true any more.

```
Change Colors customizes the appearance of web pages for easier and more comfortable reading.

Features:
• Choose custom background, text, link, and visited-link colors
• Choose a preferred font and font size
• Show or hide images and embedded content
• Apply settings globally, by domain, or to a single page
• Toggle overrides from the toolbar or with keyboard shortcuts
• Works with frames, dynamic pages, and open Shadow DOM

Version 3.0 has been rebuilt for Manifest V3 and includes major reliability, compatibility, and performance improvements.

Change Colors processes page URLs and page styling information locally only to apply your settings. It does not send browsing data or page content to the developer or any third party. It contains no advertising, analytics, or remote code.
```

## Single purpose

```
Customize the appearance of web pages by applying user-selected colors, fonts, and content-visibility settings.
```

## Permission justifications

The extension asks for four permissions and one host permission. `tabs` was
removed in 3.0.0 - it is not needed to read a tab's URL when the extension
already has host access to that tab - so its justification field disappears
once this package is uploaded. The old text there
(`updatePageActionWithBackgroundOnly`) describes something that no longer
exists; do not carry it over.

**storage**

```
Stores the user's color, font, image-display, and per-page/per-domain override preferences locally. It also keeps temporary per-tab styling records so injected styles can be removed safely.
```

**scripting**

```
Injects and removes locally generated CSS and a packaged helper script on pages where styling is enabled, including frames and open Shadow DOM.
```

**webNavigation**

```
Detects page and frame navigations, back/forward-cache restores, prerender activation, and single-page application URL changes so styling is applied to the correct document and removed when no longer requested.
```

**offscreen**

```
Used during the Manifest V2 to Manifest V3 upgrade to read legacy settings from extension localStorage and migrate them once to chrome.storage.local.
```

**Host permission (`<all_urls>`)**

```
Required to apply the user's selected appearance settings to websites they visit and to support the global, per-domain, and per-page override features. URLs and page styling information are processed locally and are not transmitted to the developer or any third party.
```

## Data usage

What the extension handles locally still counts as handling it, so it is
declared. Declaring it is not saying it is sent anywhere; the privacy policy is
where "locally only" is stated.

* **Web history** - yes. The current URL, and the page URLs and domains the user
  puts on the override lists.
* **Website content** - yes. The DOM, computed styles and open shadow trees are
  read to decide what to paint and what to leave alone.
* **User activity** - no. Clicks, keystrokes and scrolling are not recorded.
* **Personally identifiable information, health, financial, authentication,
  personal communications, location** - no.
* Do not select the option that says no user data is handled.
* Certify the Limited Use disclosures. Each is true of this extension: the data
  is used only for the user-facing feature, is not sold, is not used for
  advertising or creditworthiness, and is not transferred except as the policy
  allows.

**Remote code: "No, I am not using remote code."** The extension loads no script
from anywhere but the package, and uses no `eval`. The stylesheet it builds is
generated from the user's own settings, which is data rather than code.
