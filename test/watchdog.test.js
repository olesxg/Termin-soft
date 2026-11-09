import test from 'node:test';
import assert from 'node:assert/strict';

import { nextAttemptDelay } from '../src/watchdog.js';

const MIN = 60_000;

test('an attempt that ran its course is retried after the long wait', () => {
  assert.deepEqual(nextAttemptDelay(15 * MIN, 0), { delayMs: 30 * MIN, quickStreak: 0 });
});

test('a window that broke within seconds is retried soon', () => {
  // The 2026-11-08 failure: six seconds from opening to giving up.
  assert.deepEqual(nextAttemptDelay(6_000, 0), { delayMs: 2 * MIN, quickStreak: 1 });
});

test('quick retries stop after three, so a broken browser does not flash all night', () => {
  let streak = 0;
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    const next = nextAttemptDelay(5_000, streak);
    streak = next.quickStreak;
    delays.push(next.delayMs / MIN);
  }
  assert.deepEqual(delays, [2, 2, 2, 30, 30]);
});

test('a slow attempt resets the streak', () => {
  const afterQuick = nextAttemptDelay(5_000, 2);
  assert.equal(afterQuick.quickStreak, 3);
  assert.deepEqual(nextAttemptDelay(10 * MIN, afterQuick.quickStreak), { delayMs: 30 * MIN, quickStreak: 0 });
});

test('the intervals are configurable', () => {
  assert.deepEqual(nextAttemptDelay(10 * MIN, 0, { retryMs: 45 * MIN }), { delayMs: 45 * MIN, quickStreak: 0 });
  assert.deepEqual(nextAttemptDelay(1_000, 0, { quickRetryMs: 30_000 }), { delayMs: 30_000, quickStreak: 1 });
});
