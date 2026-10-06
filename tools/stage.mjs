// Builds the directory that gets packed, rather than packing the one we work
// in.
//
// The extension root holds things that are not the extension: the tests, the
// tools, the editor's project file. None of it runs once installed, and that is
// exactly what makes it worth leaving out: a reviewer at the store, or anyone
// auditing what was shipped, cannot tell dormant code from live code by reading
// it, and every kilobyte of it has to be accounted for by hand.
//
// So the list below is an allowlist. Something new in the extension has to be
// added to it to be shipped, which fails loudly - a missing file is a broken
// extension - where a denylist fails silently, by shipping whatever nobody
// thought of.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'build');

/** Every file the installed extension is made of, and nothing else. */
const SHIPPED = [
    'manifest.json',
    // Not code, but the attribution `libs/font_detect.js` is kept under has to
    // travel with what it attributes.
    'THIRD_PARTY_NOTICES.md',
    'background.js',
    'agent.js',
    'offscreen.html',
    'offscreen.js',
    'options.html',
    'options.js',
    'popup.html',
    'popup.js',
    'common/css.js',
    'common/migration.js',
    'common/record.js',
    'common/settings.js',
    'common/sync.js',
    'libs/font_detect.js',
    'css/options.css',
    'css/pop_up.css',
    'icons/colors_icons.png',
    'icons/colors_icons_64.png',
    'icons/colors_icons_grey.png',
    'icons/optionsBackground.jpg',
    'icons/overrideSelection.jpg',
    'icons/popUpBackground.jpg',
    'icons/selectBackground.jpg'
];

fs.rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const file of SHIPPED) {
    const from = path.join(ROOT, file);
    if (!fs.existsSync(from)) {
        console.error(`missing: ${file}`);
        process.exit(1);
    }
    const to = path.join(OUT, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    bytes += fs.statSync(to).size;
}

// Whatever the manifest names has to be in the list, or the extension is
// staged broken: this catches the file added to the manifest and forgotten
// here.
const manifest = JSON.parse(
    fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')
);
const named = new Set();
(function collect(value) {
    if (typeof value === 'string') {
        if (/\.(js|html|css|png|jpg)$/.test(value)) {
            named.add(value);
        }
        return;
    }
    if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
    }
})(manifest);
const missing = [...named].filter(function (file) {
    return !fs.existsSync(path.join(OUT, file));
});
if (missing.length) {
    console.error(
        'the manifest names files that were not staged: ' + missing.join(', ')
    );
    process.exit(1);
}

console.log(
    `staged ${SHIPPED.length} files (${Math.round(bytes / 1024)} kB) in build/`
);
console.log('`npm run release` is what turns it into the ZIP the store takes.');
