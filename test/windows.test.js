import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWindows, inWindow, nextWindowStart, weeklyMinutes } from '../src/windows.js';

const at = (text) => new Date(text);

test('a day range, a single day and an everyday window all parse', () => {
  const { windows, bad } = parseWindows('mon-fri 18:00-22:00, sat 09:00-12:00, 07:00-08:00');
  assert.deepEqual(bad, []);
  assert.equal(windows.length, 3);
  assert.deepEqual([...windows[0].days].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...windows[1].days], [6]);
  assert.equal(windows[2].days, null, 'no day given means every day');
});

test('a range that wraps the week is still a range', () => {
  const { windows } = parseWindows('fri-mon 20:00-22:00');
  assert.deepEqual([...windows[0].days].sort(), [0, 1, 5, 6]);
});

test('several days join with +', () => {
  const { windows } = parseWindows('tue+thu 07:00-09:00');
  assert.deepEqual([...windows[0].days].sort(), [2, 4]);
});

test('a typo is named, not silently dropped', () => {
  const { windows, bad } = parseWindows('mon 18:00-22:00, tomorrow 9-5, thu 25:00-26:00, fri 10:00-10:00');
  assert.equal(windows.length, 1);
  assert.deepEqual(bad, ['tomorrow 9-5', 'thu 25:00-26:00', 'fri 10:00-10:00']);
});

test('nothing configured means always open, never always shut', () => {
  assert.equal(inWindow(at('2026-10-05T03:00:00'), []), true);
  assert.equal(inWindow(at('2026-10-05T03:00:00'), null), true);
});

test('inside and outside a weekday window', () => {
  const { windows } = parseWindows('mon-fri 18:00-22:00');
  assert.equal(inWindow(at('2026-10-05T19:30:00'), windows), true, 'Monday evening');
  assert.equal(inWindow(at('2026-10-05T17:59:00'), windows), false);
  assert.equal(inWindow(at('2026-10-05T22:00:00'), windows), false, 'the end is exclusive');
  assert.equal(inWindow(at('2026-10-10T19:30:00'), windows), false, 'Saturday is not mon-fri');
});

test('a window running past midnight covers both sides of it', () => {
  const { windows } = parseWindows('mon 22:00-02:00');
  assert.equal(inWindow(at('2026-10-05T23:00:00'), windows), true, 'Monday night');
  assert.equal(inWindow(at('2026-10-06T01:00:00'), windows), true, 'Tuesday small hours still belong to Monday');
  assert.equal(inWindow(at('2026-10-06T03:00:00'), windows), false);
  assert.equal(inWindow(at('2026-10-07T01:00:00'), windows), false, 'Wednesday is not Monday night');
});

test('the next opening is found, including the one later the same day', () => {
  const { windows } = parseWindows('mon-fri 07:00-09:00, mon-fri 18:00-22:00');
  assert.equal(nextWindowStart(at('2026-10-05T03:00:00'), windows).getHours(), 7);
  assert.equal(nextWindowStart(at('2026-10-05T08:00:00'), windows).getHours(), 18, 'already inside one — the next is the evening');

  const overWeekend = nextWindowStart(at('2026-10-09T23:00:00'), windows);
  assert.equal(overWeekend.getDay(), 1, 'Friday night rolls to Monday');
  assert.equal(overWeekend.getHours(), 7);
});

test('no windows means no next opening to wait for', () => {
  assert.equal(nextWindowStart(at('2026-10-05T03:00:00'), []), null);
});

test('the weekly budget is what the schedule actually buys', () => {
  assert.equal(weeklyMinutes(parseWindows('mon-fri 18:00-22:00').windows), 5 * 4 * 60);
  assert.equal(weeklyMinutes(parseWindows('07:00-08:00').windows), 7 * 60);
  assert.equal(weeklyMinutes(parseWindows('mon 22:00-02:00').windows), 4 * 60, 'midnight is not a discontinuity');
});
