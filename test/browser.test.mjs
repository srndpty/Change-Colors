import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserArgs, connectBrowser } from './browser.mjs';

function fixture() {
    const child = new EventEmitter();
    child.stdio = Array.from({ length: 5 }, () => new PassThrough());
    child.stdout = child.stdio[1];
    child.stderr = child.stdio[2];
    const logs = [];
    const connection = connectBrowser(child, 'fake-chromium', {
        timeoutMs: 25,
        totalTimeoutMs: 0,
        log: (value) => logs.push(value)
    });
    return { child, connection, logs };
}

test('DevTools responses can arrive in separate pipe chunks', async () => {
    const { child, connection } = fixture();
    const result = connection.send('Target.getTargets');
    child.stdio[4].write('{"id":1,"res');
    child.stdio[4].write('ult":{"targetInfos":[]}}\0');
    assert.deepEqual((await result).result.targetInfos, []);
    connection.dispose();
});

test('missing response rejects all requests and includes stderr', async () => {
    const { child, connection, logs } = fixture();
    child.stderr.write('sandbox startup failed');
    await Promise.all([
        assert.rejects(connection.send('Target.getTargets'), /timed out/),
        assert.rejects(connection.send('Runtime.enable'), /timed out/)
    ]);
    assert.match(logs.join('\n'), /sandbox startup failed/);
    await assert.rejects(connection.send('Runtime.enable'), /timed out/);
    connection.dispose();
});

test('early browser exit rejects pending and future commands', async () => {
    const { child, connection } = fixture();
    const result = assert.rejects(
        connection.send('Target.getTargets'),
        /code=1/
    );
    child.emit('exit', 1, null);
    await result;
    await assert.rejects(connection.send('Runtime.enable'), /code=1/);
    connection.dispose();
});

test('spawn errors and pipe closure fail immediately', async () => {
    for (const event of ['error', 'end']) {
        const { child, connection } = fixture();
        const result = assert.rejects(
            connection.send('Target.getTargets'),
            /Could not start|closed/
        );
        if (event === 'error') child.emit('error', new Error('ENOENT'));
        else child.stdio[4].emit('end');
        await result;
        connection.dispose();
    }
});

test('protocol errors identify the failed command', async () => {
    const { child, connection } = fixture();
    const result = assert.rejects(
        connection.send('Runtime.enable'),
        /Runtime.enable: unsupported/
    );
    child.stdio[4].write('{"id":1,"error":{"message":"unsupported"}}\0');
    await result;
    connection.dispose();
});

test('sandbox is disabled only in Linux CI', () => {
    assert.deepEqual(browserArgs({ CI: 'true' }, 'linux'), ['--no-sandbox']);
    assert.deepEqual(browserArgs({}, 'linux'), []);
    assert.deepEqual(browserArgs({ CI: 'true' }, 'win32'), []);
});
