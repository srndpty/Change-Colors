// The release gate: everything that has to be true before a ZIP is uploaded to
// the Chrome Web Store, in one run that stops at the first thing that is not.
//
// What the store takes is a ZIP with the manifest at its root - not a CRX, and
// not the directory this is run from. So the last steps here build that ZIP out
// of `build/`, which `stage` fills from an allowlist, and print the hash of it:
// what was uploaded has to be tied to a commit afterwards, and "the build I ran
// that day" is not a tie.
//
// The step that matters most is the integration test being pointed at `build/`.
// The staging list can be complete as far as the manifest is concerned and
// still miss a module some other module imports; loaded from the source root
// that extension works perfectly, and only the staged one is broken. So the
// browser is given the staged one, and $REQUIRE_BROWSER says a run that found
// no browser is a failure rather than a skip - at this point, "the tests did
// not fail" has to mean "the tests ran".
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeZip} from './zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');

function run(what, file, extraEnv) {
    console.log(`\n=== ${what}`);
    const result = spawnSync(process.execPath, [file], {
        cwd: ROOT,
        stdio: 'inherit',
        env: Object.assign({}, process.env, {REQUIRE_BROWSER: '1'}, extraEnv || {})
    });
    if (result.status !== 0) {
        console.error(`\nrelease stopped: ${what} failed`);
        process.exit(1);
    }
}

function fail(message) {
    console.error(`\nrelease stopped: ${message}`);
    process.exit(1);
}

/* ------------------------------------------------- what is being released */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
console.log(`=== version\npackage.json ${pkg.version}, manifest.json ${manifest.version}`);
if (pkg.version !== manifest.version) {
    fail('package.json and manifest.json disagree about the version');
}
if (!/^\d+\.\d+(\.\d+)?(\.\d+)?$/.test(manifest.version)) {
    fail(`the store will not take "${manifest.version}" as a version`);
}

/* --------------------------------------------------------------- the tests */

run('what a tab knows', 'test/record.test.mjs');
run('the override rules', 'test/settings.test.mjs');
run('the 2.x migration', 'test/migration.test.mjs');
run('the stylesheet in a real layout', 'test/css.test.mjs');
run('the extension, loaded from the source', 'test/integration.test.mjs');
run('what the styling costs a busy page', 'test/perf.test.mjs');

/* ------------------------------------------------------------- the package */

run('staging what ships', 'tools/stage.mjs');
run('the extension, loaded from build/', 'test/integration.test.mjs',
    {EXTENSION_DIR: BUILD});

const files = [];
(function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort(function (a, b) {
        return a.name < b.name ? -1 : 1;
    })) {
        const full = path.join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walk(full, name);
        } else {
            files.push({name: name, path: full});
        }
    }
})(BUILD, '');

if (!files.some(function (file) {
    return file.name === 'manifest.json';
})) {
    fail('build/ has no manifest.json at its root');
}

fs.mkdirSync(DIST, {recursive: true});
const zip = path.join(DIST, `change-colors-${manifest.version}.zip`);
writeZip(zip, files);

const bytes = fs.readFileSync(zip);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'});
const dirty = spawnSync('git', ['status', '--porcelain'], {cwd: ROOT, encoding: 'utf8'});

console.log(`\n=== the package
${path.relative(ROOT, zip)}
${files.length} files, ${Math.round(bytes.length / 1024)} kB
sha256 ${hash}
commit ${(commit.stdout || '').trim() || 'unknown'}${(dirty.stdout || '').trim() ? ' (with uncommitted changes)' : ''}

Upload that file at https://chrome.google.com/webstore/devconsole - Package,
"Upload new package". The manifest is at the root of it, which is what the
store expects; a CRX is for loading one by hand, not for the store.

One thing this cannot check: Chrome turns prerendering off for a tab with
DevTools attached, so the prerendered-page case skipped above has to be walked
through by hand - npm run demo:prerender prints the steps.`);
