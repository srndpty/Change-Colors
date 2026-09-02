# Third party notices

This extension includes the following work by other people. Each is listed with
the license it was released under and what was changed.

## Font detection — `libs/font_detect.js`

    JavaScript code to detect availability of a particular font in a browser
    using JavaScript and CSS.

    Author : Lalit Patel
    Website: http://www.lalit.org/lab/jsoncookies
    License: Creative Commons Attribution-ShareAlike 2.5
             http://creativecommons.org/licenses/by-sa/2.5/
    Version: 0.15

Changes: rewritten as an ES module (`export`s instead of a global) for the
Manifest V3 version, and the list of font names moved into an exported
constant. The detection itself - the three fallback fonts, the measured span,
the comparison of widths and heights - is unchanged.

This file remains under CC BY-SA 2.5. The license requires that it keep this
attribution and that changes to it be shared under the same license; both are
satisfied by this notice and by the header the file itself carries.

Nothing else in the extension is derived from it, and the rest of the extension
is not covered by CC BY-SA 2.5 - the license attaches to the work it was
applied to.

## Everything else

The rest of this extension is a fork of
[Strav/Change-Colors](https://github.com/Strav/Change-Colors), used with the
original author's permission, given directly. See "License and provenance" in
the README.

Version 3.0.0 dropped the two libraries the Manifest V2 version shipped -
jQuery and the jscolor color picker - so no notice is needed for either.
