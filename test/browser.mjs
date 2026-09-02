// Finding a browser to run the layout and performance tests in.
//
// These two only need a browser that speaks the DevTools protocol, branded
// Chrome included, but they must say so when there is none rather than trying
// to start a path that happens to be this machine's. A hard-coded Windows path
// spawned on Linux fails with ENOENT from inside child_process, which is not a
// result: the test has neither passed nor failed, and only saying "skipped"
// tells the difference.
import fs from 'node:fs';
import path from 'node:path';

function candidates() {
    const found = [];
    if (process.env.CHROME) {
        found.push(process.env.CHROME);
    }
    const programFiles = [
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)'],
        process.env.LOCALAPPDATA
    ].filter(Boolean);
    for (const base of programFiles) {
        found.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        found.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
    found.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    found.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    for (const binary of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        found.push(path.join('/usr/bin', binary));
        found.push(path.join('/usr/local/bin', binary));
        found.push(path.join('/snap/bin', binary));
    }
    return found;
}

/**
 * A browser that exists, or null. `$CHROME` is taken as given if it names
 * something that exists, and reported as missing if it does not - a typo there
 * should not quietly fall through to another browser.
 */
export function findChrome() {
    if (process.env.CHROME) {
        return fs.existsSync(process.env.CHROME) ? process.env.CHROME : null;
    }
    return candidates().find(function (candidate) {
        try {
            return fs.statSync(candidate).isFile();
        } catch (e) {
            return false;
        }
    }) || null;
}

/**
 * Says why there is nothing to run and leaves without failing - unless
 * $REQUIRE_BROWSER says a run that checked nothing is not an outcome anybody
 * asked for. The release gate sets it: "the tests did not fail" and "the tests
 * ran" are the same sentence only if there was a browser to run them in.
 */
export function skipWithoutChrome(what) {
    if (process.env.REQUIRE_BROWSER) {
        console.log(`FAIL  ${what}: no Chrome or Chromium was found, and`);
        console.log('      $REQUIRE_BROWSER says this one had to run. Point $CHROME at one.');
        process.exit(1);
    }
    console.log(`SKIP  ${what}: no Chrome or Chromium was found.`);
    console.log('      Point $CHROME at one.');
    process.exit(0);
}

/**
 * Turns a browser that cannot be started into a stated failure. Without this
 * the process dies on an unhandled 'error' event, or - worse - waits for a
 * target that will never appear.
 */
export function reportLaunchFailure(child, chromePath, onFailure) {
    child.on('error', function (error) {
        console.log(`FAIL  could not start ${chromePath} -> ${error.message}`);
        if (onFailure) {
            onFailure();
        }
        process.exit(1);
    });
}
