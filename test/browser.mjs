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
        found.push(
            path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')
        );
        found.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
    found.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    found.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    for (const binary of [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser'
    ]) {
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
    return (
        candidates().find(function (candidate) {
            try {
                return fs.statSync(candidate).isFile();
            } catch (e) {
                return false;
            }
        }) || null
    );
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
        console.log(
            '      $REQUIRE_BROWSER says this one had to run. Point $CHROME at one.'
        );
        process.exit(1);
    }
    console.log(`SKIP  ${what}: no Chrome or Chromium was found.`);
    console.log('      Point $CHROME at one.');
    process.exit(0);
}

/**
 * Linux CI runners may prohibit Chromium's user-namespace sandbox. Disable it
 * only there, for browsers that load the local test fixtures.
 */
export function browserArgs(env = process.env, platform = process.platform) {
    return env.CI && platform === 'linux' ? ['--no-sandbox'] : [];
}

/** Bounded DevTools pipe transport shared by all browser tests. */
export function connectBrowser(
    child,
    chromePath,
    {
        timeoutMs = 30000,
        totalTimeoutMs = 300000,
        onEvent = () => {},
        onFailure = () => {},
        log = console.error
    } = {}
) {
    let nextId = 0;
    let buffer = Buffer.alloc(0);
    let stderr = '';
    let failure = null;
    const pending = new Map();
    log(`Browser: ${chromePath}`);
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
    });
    function fail(reason) {
        if (failure) return;
        failure = new Error(reason);
        log(`FAIL  ${reason}${stderr ? '\nChromium stderr:\n' + stderr : ''}`);
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(failure);
        }
        pending.clear();
    }
    child.on('error', (error) =>
        fail(`Could not start ${chromePath}: ${error.message}`)
    );
    child.on('exit', (code, signal) =>
        fail(`Chromium exited (code=${code}, signal=${signal})`)
    );
    child.stdio[3].on('error', (error) =>
        fail(`DevTools write pipe: ${error.message}`)
    );
    child.stdio[4].on('error', (error) =>
        fail(`DevTools read pipe: ${error.message}`)
    );
    child.stdio[4].on('end', () => fail('Chromium closed its DevTools pipe'));
    child.stdio[4].on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(0)) !== -1) {
            const raw = buffer.subarray(0, end).toString();
            buffer = buffer.subarray(end + 1);
            let message;
            try {
                message = JSON.parse(raw);
            } catch {
                fail('Invalid JSON from Chromium DevTools');
                return;
            }
            const request = pending.get(message.id);
            if (request) {
                clearTimeout(request.timer);
                pending.delete(message.id);
                if (message.error)
                    request.reject(
                        new Error(`${request.method}: ${message.error.message}`)
                    );
                else request.resolve(message);
            } else if (message.method) onEvent(message);
        }
    });
    const deadline =
        totalTimeoutMs > 0
            ? setTimeout(() => {
                  fail(`Browser test exceeded ${totalTimeoutMs / 1000}s`);
                  child.kill();
                  onFailure();
                  process.exit(1);
              }, totalTimeoutMs)
            : null;
    deadline?.unref();
    function send(method, params = {}, sessionId) {
        if (failure) return Promise.reject(failure);
        const id = ++nextId;
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => fail(`DevTools ${method} timed out after ${timeoutMs}ms`),
                timeoutMs
            );
            pending.set(id, { resolve, reject, timer, method });
            child.stdio[3].write(JSON.stringify(message) + '\0', (error) => {
                if (error) fail(`DevTools ${method}: ${error.message}`);
            });
        });
    }
    function dispose() {
        clearTimeout(deadline);
        if (!failure) failure = new Error('Browser connection disposed');
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(failure);
        }
        pending.clear();
    }
    return { send, dispose };
}
