import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {
    retryAfterMs,
    retryDelay,
    RETRY_INTERVAL,
    RATE_LIMIT_BASE,
    RATE_LIMIT_MAX,
    RATE_LIMIT_MIN,
} from '../lib/retry.js';

describe('retryAfterMs', () => {
    test('seconds, an http date, absent, garbage', () => {
        assert.equal(retryAfterMs({'retry-after': '120'}), 120000);
        assert.equal(retryAfterMs({'Retry-After': ['7']}), 7000);
        const now = Date.parse('2026-09-15T20:52:45Z');
        assert.equal(retryAfterMs({'retry-after': 'Tue, 15 Sep 2026 21:22:45 GMT'}, now), 30 * 60 * 1000);
        assert.equal(retryAfterMs({'retry-after': 'Tue, 15 Sep 2026 20:00:00 GMT'}, now), 0);
        assert.equal(retryAfterMs({}), null);
        assert.equal(retryAfterMs(undefined), null);
        assert.equal(retryAfterMs({'retry-after': ''}), null);
        assert.equal(retryAfterMs({'retry-after': 'soon'}), null);
    });
});

describe('retryDelay', () => {
    test('unreachable controller: the fixed interval, capped by the poll interval', () => {
        assert.equal(retryDelay({interval: 60000}), RETRY_INTERVAL);
        assert.equal(retryDelay({status: 502, interval: 60000}), RETRY_INTERVAL);
        assert.equal(retryDelay({interval: 5000}), 5000);
        assert.equal(retryDelay(), RETRY_INTERVAL);
    });

    test('429 without Retry-After backs off from 5 minutes, doubling, capped at 30', () => {
        assert.equal(retryDelay({status: 429, attempt: 1, interval: 60000}), RATE_LIMIT_BASE);
        assert.equal(retryDelay({status: 429, attempt: 2, interval: 60000}), 2 * RATE_LIMIT_BASE);
        assert.equal(retryDelay({status: 429, attempt: 3, interval: 60000}), 4 * RATE_LIMIT_BASE);
        assert.equal(retryDelay({status: 429, attempt: 4, interval: 60000}), RATE_LIMIT_MAX);
        assert.equal(retryDelay({status: 429, attempt: 9, interval: 60000}), RATE_LIMIT_MAX);
        assert.equal(retryDelay({status: 429, retryAfter: null, interval: 60000}), RATE_LIMIT_BASE);
    });

    test('429 with Retry-After honours it, but not below the minimum', () => {
        assert.equal(retryDelay({status: 429, retryAfter: 120000, attempt: 3, interval: 60000}), 120000);
        assert.equal(retryDelay({status: 429, retryAfter: 1000, interval: 60000}), RATE_LIMIT_MIN);
        assert.equal(retryDelay({status: 429, retryAfter: 0, interval: 60000}), RATE_LIMIT_MIN);
    });
});
