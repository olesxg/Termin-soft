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

import { parseWaveTimes, nextWaveTime, waveDelayMs } from '../src/schedule.js';

test('wave times parse, with or without seconds', () => {
  const { times, bad } = parseWaveTimes('14:45, 22:40:30, 08:00');
  assert.deepEqual(bad, []);
  assert.deepEqual(times.map((t) => t.label), ['08:00', '14:45', '22:40:30'], 'sorted by clock');
  assert.equal(times[2].second, 30);
});

test('a time that is not a time is named, not dropped in silence', () => {
  const { times, bad } = parseWaveTimes('14:45, обід, 25:00, 12:70');
  assert.equal(times.length, 1);
  assert.deepEqual(bad, ['обід', '25:00', '12:70']);
});

test('the next wave is the next one today, or the first tomorrow', () => {
  const { times } = parseWaveTimes('14:45, 22:40');
  const morning = nextWaveTime(new Date('2026-10-07T09:00:00'), times);
  assert.equal(morning.getHours(), 14);

  const evening = nextWaveTime(new Date('2026-10-07T20:00:00'), times);
  assert.equal(evening.getHours(), 22);

  const night = nextWaveTime(new Date('2026-10-07T23:00:00'), times);
  assert.equal(night.getDate(), 8, 'past the last wave, the next is tomorrow');
  assert.equal(night.getHours(), 14);
});

test('the lead puts the first call before the release, not after it', () => {
  const { times } = parseWaveTimes('14:45');
  const at = nextWaveTime(new Date('2026-10-07T09:00:00'), times, 10_000);
  assert.equal(at.getMinutes(), 44);
  assert.equal(at.getSeconds(), 50);
});

test('a wave whose lead has already passed rolls to the next one', () => {
  const { times } = parseWaveTimes('14:45');
  const at = nextWaveTime(new Date('2026-10-07T14:44:55'), times, 10_000);
  assert.equal(at.getDate(), 8, 'the lead for today is gone — do not fire late');
});

test('no waves configured means nothing to wait for', () => {
  assert.equal(nextWaveTime(new Date(), [], 0), null);
  assert.equal(waveDelayMs(new Date(), [], 0), null);
});

test('the delay is positive and matches the instant', () => {
  const { times } = parseWaveTimes('14:45');
  const now = new Date('2026-10-07T14:00:00');
  assert.equal(waveDelayMs(now, times, 0), 45 * 60_000);
});

import { waveMinutes } from '../src/schedule.js';
import { parseDayList } from '../src/windows.js';

test('one known wave fixes the phase of the whole grid', () => {
  const { times } = parseWaveTimes('14:45');
  const minutes = waveMinutes(times, 20);
  assert.equal(minutes.length, 72, '20-minute grid = 72 waves a day');
  assert.equal(minutes.includes(14 * 60 + 45), true);
  assert.equal(minutes.includes(14 * 60 + 25), true);
  assert.equal(minutes.includes(15 * 60 + 5), true);
  assert.equal(minutes.includes(14 * 60 + 50), false, ':50 is off the grid');
});

test('without an interval the times are taken literally', () => {
  const { times } = parseWaveTimes('14:45, 22:40');
  assert.deepEqual(waveMinutes(times, 0), [22 * 60 + 40, 14 * 60 + 45].sort((a, b) => a - b));
});

test('the grid walks forward wave by wave', () => {
  const { times } = parseWaveTimes('14:45');
  const opts = { everyMin: 20 };
  const first = nextWaveTime(new Date('2026-10-07T14:30:00'), times, 0, opts);
  assert.equal(first.getHours(), 14);
  assert.equal(first.getMinutes(), 45);

  const second = nextWaveTime(new Date('2026-10-07T14:46:00'), times, 0, opts);
  assert.equal(second.getMinutes(), 5);
  assert.equal(second.getHours(), 15);
});

test('a release that only runs on Wednesdays skips the rest of the week', () => {
  const { times } = parseWaveTimes('14:45');
  const opts = { everyMin: 20, days: parseDayList('wed') };

  // Thursday 2026-10-08 -> the next release is Wednesday 2026-10-14.
  const at = nextWaveTime(new Date('2026-10-08T09:00:00'), times, 0, opts);
  assert.equal(at.getDay(), 3);
  assert.equal(at.getDate(), 14);
  assert.equal(at.getHours(), 0, 'the first wave of that day, not the anchor hour');
  assert.equal(at.getMinutes(), 5);
});

test('on the release day itself the next wave is minutes away, not days', () => {
  const { times } = parseWaveTimes('14:45');
  const at = nextWaveTime(new Date('2026-10-07T14:30:00'), times, 0, { everyMin: 20, days: parseDayList('wed') });
  assert.equal(at.getDate(), 7);
  assert.equal(at.getMinutes(), 45);
});

test('the lead applies to the grid too', () => {
  const { times } = parseWaveTimes('14:45');
  const at = nextWaveTime(new Date('2026-10-07T14:30:00'), times, 10_000, { everyMin: 20 });
  assert.equal(at.getMinutes(), 44);
  assert.equal(at.getSeconds(), 50);
});
