import test from 'node:test';
import assert from 'node:assert/strict';

import { nextAlignedTime, alignedDelayMs, minuteOffsetOf } from '../src/schedule.js';

const at = (h, m, s, ms = 0) => new Date(2026, 7, 27, h, m, s, ms);
const hms = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

const OPTS = { minuteMod: 10, minuteOffset: 8, second: 58 };

test('it lands on the next minute ending in 8, at the chosen second', () => {
  assert.equal(hms(nextAlignedTime(at(23, 1, 54), OPTS)), '23:08:58');
});

test('a mark just missed rolls to the next cycle, not back', () => {
  assert.equal(hms(nextAlignedTime(at(23, 8, 59), OPTS)), '23:18:58');
});

test('one second before the mark waits that single second', () => {
  assert.equal(alignedDelayMs(at(23, 8, 57), OPTS), 1000);
});

test('the mark itself is not returned again — it must be strictly in the future', () => {
  assert.equal(hms(nextAlignedTime(at(23, 8, 58), OPTS)), '23:18:58');
});

test('it crosses the hour boundary', () => {
  assert.equal(hms(nextAlignedTime(at(23, 59, 30), OPTS)), '0:08:58');
});

test('sub-second time does not overshoot the upcoming mark', () => {
  assert.equal(alignedDelayMs(at(23, 8, 57, 250), OPTS), 750);
});

test('minuteMod 1 marks every minute', () => {
  assert.equal(hms(nextAlignedTime(at(23, 4, 10), { minuteMod: 1, minuteOffset: 0, second: 30 })), '23:04:30');
});

test('alignment off returns null so the caller falls back to the interval', () => {
  assert.equal(nextAlignedTime(at(23, 1, 0), { minuteMod: 0 }), null);
  assert.equal(alignedDelayMs(at(23, 1, 0), { minuteMod: 0 }), null);
});

test('an offset larger than the modulus still resolves', () => {
  assert.equal(hms(nextAlignedTime(at(23, 1, 0), { minuteMod: 10, minuteOffset: 28, second: 5 })), '23:08:05');
});

test('a hit teaches the offset to camp on next time', () => {
  assert.equal(minuteOffsetOf(at(23, 8, 12), 10), 8);
  assert.equal(minuteOffsetOf(at(23, 43, 46), 10), 3);
  assert.equal(minuteOffsetOf(at(23, 0, 1), 10), 0);
});

test('the learned offset feeds straight back into the next mark', () => {
  const hit = at(23, 8, 12);
  const offset = minuteOffsetOf(hit, 10);
  assert.equal(hms(nextAlignedTime(hit, { minuteMod: 10, minuteOffset: offset, second: 0 })), '23:18:00');
});

test('no offset to learn when alignment is off', () => {
  assert.equal(minuteOffsetOf(at(23, 8, 0), 0), null);
});
