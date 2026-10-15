// UTF-8 that was read as CP932 and saved again is still valid UTF-8, so a
// decode check never sees it. The store listing lost its six bullets that way,
// and the prerender demo lost both ellipses in its example. These name the
// characters that have to stay.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const read = (path) =>
    new TextDecoder('utf-8', { fatal: true }).decode(
        readFileSync(fileURLToPath(new URL(path, import.meta.url)))
    );

test('store copy and the prerender example keep their original characters', () => {
    const listing = read('../docs/STORE_LISTING.md');
    const demo = read('./prerender-demo.mjs');

    assert.equal(
        (listing.match(/^\u2022 /gm) || []).length,
        6,
        'Store listing must retain six Unicode bullets'
    );
    assert.ok(
        demo.includes('["ABC\u2026", "ABC\u2026"]'),
        'Prerender example must retain both ellipses'
    );
    assert.doesNotMatch(
        listing + demo,
        /\u7ab6[\uff62\uff66]/u,
        'Known mojibake must be absent'
    );
});
