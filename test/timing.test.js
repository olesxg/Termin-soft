import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventsFromExperiment, hitsFromLog, dedupe, tally, blindHours, asRanges, hotspots, verdict,
} from '../src/timing.js';

const row = (at, outcome = 'no-slots') => ({ kind: 'date', label: 's1', at, outcome });

test('only date checks become events, and junk is skipped', () => {
  const events = eventsFromExperiment([
    row('2026-10-05T08:00:00'),
    { kind: 'refresh', at: '2026-10-05T08:05:00', ok: true },
    { kind: 'date', at: 'not a date' },
    null,
    row('2026-10-05T09:00:00', 'SLOT'),
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[1].hit, true);
});

test('slot banners are read out of monitor.log, with their date', () => {
  const log = [
    '  *** SLOT AVAILABLE — GO BOOK IT NOW ***',
    '  detected at 2026-10-04T20:40:12.000Z',
    '[21:00:01] ping #3 — no slots',
    '  detected at 2026-09-28T19:05:00.000Z',
  ].join('\n');

  const hits = hitsFromLog(log);
  assert.equal(hits.length, 2);
  assert.equal(hits.every((h) => h.hit), true);
  assert.equal(hits[0].at.toISOString(), '2026-10-04T20:40:12.000Z');
});

test('a log with no banner yields nothing rather than throwing', () => {
  assert.deepEqual(hitsFromLog(''), []);
  assert.deepEqual(hitsFromLog(undefined), []);
  assert.deepEqual(hitsFromLog('detected at yesterday'), []);
});

test('the same slot in both sources is counted once', () => {
  const both = [
    ...eventsFromExperiment([row('2026-10-04T20:40:12.000Z', 'SLOT')]),
    ...hitsFromLog('detected at 2026-10-04T20:40:12.000Z'),
  ];
  assert.equal(both.length, 2);
  assert.equal(dedupe(both).length, 1);
});

test('checks land on the right weekday and hour', () => {
  const t = tally(eventsFromExperiment([row('2026-10-05T08:30:00'), row('2026-10-05T08:45:00', 'SLOT')]));
  assert.equal(t.totalChecks, 2);
  assert.equal(t.totalHits, 1);
  assert.equal(t.checks[1][8], 2, 'Monday 08:00');
  assert.equal(t.hits[1][8], 1);
});

test('hours nobody ever checked are the blind spots', () => {
  const t = tally(eventsFromExperiment([row('2026-10-05T08:30:00'), row('2026-10-06T22:00:00')]));
  const blind = blindHours(t);
  assert.equal(blind.includes(8), false);
  assert.equal(blind.includes(22), false);
  assert.equal(blind.includes(3), true);
  assert.equal(blind.length, 22);
});

test('blind hours collapse into ranges, and the night is one range', () => {
  assert.deepEqual(asRanges([1, 2, 3, 7, 8]), [[1, 3], [7, 8]]);
  assert.deepEqual(asRanges([5]), [[5, 5]]);
  assert.deepEqual(asRanges([]), []);

  const night = asRanges([0, 1, 2, 22, 23]);
  assert.deepEqual(night, [[22, 26]], '22:00 to 02:00 is one night, not two stray ends');
});

test('hotspots rank by slots found, then by how little it took', () => {
  const t = tally([
    { at: new Date('2026-10-06T22:00:00'), hit: true },
    { at: new Date('2026-10-06T22:30:00'), hit: true },
    { at: new Date('2026-10-05T08:00:00'), hit: true },
    { at: new Date('2026-10-05T08:30:00'), hit: false },
  ]);
  const spots = hotspots(t);
  assert.equal(spots[0].day, 2, 'Tuesday 22:00 had two');
  assert.equal(spots[0].hits, 2);
  assert.equal(spots[1].day, 1);
});

test('one slot is called an anecdote, not a schedule', () => {
  const t = tally([{ at: new Date('2026-10-06T22:00:00'), hit: true }, { at: new Date('2026-10-06T23:00:00'), hit: false }]);
  const out = verdict(t, hotspots(t));
  assert.equal(out.level, 'weak');
  assert.match(out.text, /анекдот/);
});

test('enough slots turn into an actual aim', () => {
  const events = [0, 1, 2].map((i) => ({ at: new Date(`2026-10-0${6 + i * 7 - i * 7}T22:0${i}:00`), hit: true }));
  const t = tally(events);
  const out = verdict(t, hotspots(t));
  assert.equal(out.level, 'usable');
  assert.match(out.text, /вт о 22:00/);
});

test('no checks and no slots are different answers', () => {
  assert.equal(verdict({ totalChecks: 0, totalHits: 0 }, []).level, 'none');
  assert.match(verdict({ totalChecks: 40, totalHits: 0 }, []).text, /Цілитись нема за чим/);
});
