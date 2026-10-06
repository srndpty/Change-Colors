# Third party notices

This extension includes work by other people. Each is listed with the notice it
carries, what was changed, and - where the record is not clean - what is still
open.

## Font detection - `libs/font_detect.js`

Source location: `src/libs/font_detect.js` in the repository;
`libs/font_detect.js` in the packaged extension.

The file arrived with this notice, and still carries it word for word:

    JavaScript code to detect available availability of a
    particular font in a browser using JavaScript and CSS.

    Author : Lalit Patel
    Website: http://www.lalit.org/lab/jsoncookies
    License: Creative Commons Attribution-ShareAlike 2.5
             http://creativecommons.org/licenses/by-sa/2.5/
    Version: 0.15
             changed comparision font to serif from sans-serif,
             as in FF3.0 font of child element didn't fallback
             to parent element if the font is missing.
    Updated: 09 July 2009 10:52pm

That notice is what this copy is used under. CC BY-SA 2.5 asks that the work
keep its author credit, that the license be identified, and that a copy of the
license or its URI travel with it: the notice above does all three, the URI
being the one it names.

### What was changed

- Written as an ES module. The original set two globals, `fonts` and
  `Detector`; this exports `FONTS` and `createFontDetector()`.
- The comparison is measured once, when the detector is built, rather than on
  every call.
- The font list has been edited since 0.15: the names that appeared twice in it
  (Andale Mono, Comic Sans MS, Papyrus, Tahoma) appear once, and Segoe UI was
  added.
- What is measured is unchanged: one span of `mmmmmmmmmml` at 72px, compared
  against `serif` - which is the change 0.15 itself is - with a font counted as
  present when its width or height differs.

This file stays under CC BY-SA 2.5, and the changes above are published under
that same license, as ShareAlike requires. The license attaches to this work,
not to the extension around it: nothing else here is derived from it.

### What is not settled

Two things in that notice do not line up with what the author published later,
and neither can be resolved from inside this repository:

- **The website line points at the wrong page.** `lalit.org/lab/jsoncookies` is
  the author's JSON cookies work. The font detector's own page is
  `lalit.org/lab/javascript-css-font-detect/`. The line appears to be the
  author's own copy-and-paste slip in the 2009 release; it is kept as it is
  because changing a notice is not something a downstream copy should do
  unilaterally.
- **Later versions carry a different license.** Versions 0.2 (March 2012) and
  0.3 (March 2012) of the same work are published under the Apache License 2.0,
  and 0.3 compares against three base fonts rather than one. This copy is 0.15,
  from 2009, whose notice says CC BY-SA 2.5.

Before publishing, one of these should happen:

1. Check the author's page for what 0.15 was released under, and correct this
   notice if it disagrees; or
2. replace this file with 0.3 under the Apache License 2.0, include
   `LICENSES/Apache-2.0.txt`, add it to the staging list in `tools/stage.mjs`,
   and re-run `npm run release` - which drops the ShareAlike question
   altogether, at the cost of a third-party file to re-test.

Until one of those is done, what ships is a faithful copy of the notice this
file came with, which is the honest position but not a verified one.

## Everything else

The rest of this extension is a fork of
[Strav/Change-Colors](https://github.com/Strav/Change-Colors), used with the
original author's permission, given directly rather than through a public
license. See "License and provenance" in the README - and keep that
correspondence, because it is the whole of the record.

Version 3.0.0 dropped the two libraries the Manifest V2 version shipped -
jQuery and the jscolor color picker - so neither needs a notice.
