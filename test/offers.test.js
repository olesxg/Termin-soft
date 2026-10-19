import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSlovakDate, parseOffers, rankOffers, formatOffers } from '../src/offers.js';

// The exact answer that reached the phone on 2026-10-04, unreadable as it was.
const SAMPLE = JSON.stringify([
  {
    officeName: 'OCP Michalovce, pracovisko Snina',
    officeCity: 'Snina',
    officeStreet: 'Partizánska 1057',
    branchPublicId: '357d86a30cc9acce45d696bdfc148250770c5220ecf7a81f2ab984e304baac32',
    dates: ['20.10.2026'],
  },
]);

const TWO_OFFICES = JSON.stringify({
  services: [
    { officeName: 'OCP Snina', officeCity: 'Snina', branchPublicId: 'a', dates: ['20.10.2026', '22.10.2026'] },
    { officeName: 'OCP Košice', officeCity: 'Košice', branchPublicId: 'b', dates: ['27.10.2026'] },
  ],
});

const NOW = new Date('2026-10-05T09:00:00Z');

test('slovak dates parse, and nonsense does not', () => {
  assert.equal(parseSlovakDate('20.10.2026').getUTCDate(), 20);
  assert.equal(parseSlovakDate('1. 9. 2026').getUTCMonth(), 8);
  assert.equal(parseSlovakDate('32.10.2026'), null, 'a day that does not exist must not roll over');
  assert.equal(parseSlovakDate('2026-10-20'), null);
  assert.equal(parseSlovakDate(''), null);
  assert.equal(parseSlovakDate(undefined), null);
});

test('every office/date pair is flattened out of the answer', () => {
  const offers = parseOffers(TWO_OFFICES, NOW);
  assert.equal(offers.length, 3);
  assert.deepEqual(offers.map((o) => o.date), ['20.10.2026', '22.10.2026', '27.10.2026']);
});

test('the weekday and the distance are what make it readable', () => {
  const [offer] = parseOffers(SAMPLE, NOW);
  assert.equal(offer.city, 'Snina');
  assert.equal(offer.weekday, 'вт', '20.10.2026 is a Tuesday — the day this service is actually taken');
  assert.equal(offer.daysAway, 15);
});

test('the preferred city is ranked first even when it is further off', () => {
  const ranked = rankOffers(parseOffers(TWO_OFFICES, NOW), 'košice');
  assert.equal(ranked[0].city, 'Košice');
  assert.equal(ranked[1].date, '20.10.2026', 'the rest stay sorted by how soon they are');
});

test('with no preference, soonest wins', () => {
  const ranked = rankOffers(parseOffers(TWO_OFFICES, NOW), '');
  assert.deepEqual(ranked.map((o) => o.date), ['20.10.2026', '22.10.2026', '27.10.2026']);
});

test('the alert says city, date, weekday and how soon', () => {
  const lines = formatOffers(SAMPLE, { prefer: 'Košice', now: NOW });
  assert.equal(lines[0], '  SNINA — 20.10.2026 (вт) — через 15 дн.');
  assert.match(lines[1], /Košice — немає/, 'say the preferred city is absent rather than leave it to be guessed');
});

test('the preferred city is starred when it is there', () => {
  const lines = formatOffers(TWO_OFFICES, { prefer: 'Košice', now: NOW });
  assert.match(lines[0], /^★ KOŠICE/);
  assert.equal(lines.filter((l) => l.includes('немає')).length, 0);
});

test('a slot today is named as today, not as "in 0 days"', () => {
  const today = JSON.stringify([{ officeCity: 'Košice', branchPublicId: 'b', dates: ['05.10.2026'] }]);
  assert.match(formatOffers(today, { now: NOW })[0], /СЬОГОДНІ/);
});

test('a long list is cut, and says how much was cut', () => {
  const many = JSON.stringify([{ officeCity: 'Snina', dates: Array.from({ length: 9 }, (_, i) => `${10 + i}.11.2026`) }]);
  const lines = formatOffers(many, { now: NOW, max: 6 });
  assert.equal(lines.length, 7);
  assert.match(lines[6], /ще 3/);
});

test('an unreadable answer yields nothing, so the caller keeps the raw payload', () => {
  assert.deepEqual(formatOffers('<html>', { now: NOW }), []);
  assert.deepEqual(formatOffers('{}', { now: NOW }), []);
  assert.deepEqual(formatOffers('[]', { now: NOW }), []);
  assert.deepEqual(formatOffers(undefined, { now: NOW }), []);
});

test('a date the portal wrote in some other shape still lists, without a guessed weekday', () => {
  const odd = JSON.stringify([{ officeCity: 'Snina', dates: ['2026-10-20'] }]);
  const [offer] = parseOffers(odd, NOW);
  assert.equal(offer.weekday, '');
  assert.equal(offer.daysAway, null);
  assert.match(formatOffers(odd, { now: NOW })[0], /SNINA — 2026-10-20/);
});

import { isNewDay, alertHeadline } from '../src/offers.js';

test('a date at the far end of the horizon is a newly opened day', () => {
  const [offer] = parseOffers(SAMPLE, new Date('2026-09-28T20:00:00Z')); // 20.10 is 22 days on
  assert.equal(isNewDay(offer), true);
});

test('a date a day or two away is a single returned time', () => {
  const near = JSON.stringify([{ officeCity: 'Snina', dates: ['15.09.2026'] }]);
  const [offer] = parseOffers(near, new Date('2026-09-14T07:30:00Z'));
  assert.equal(isNewDay(offer), false);
});

test('the headline says which of the two it is', () => {
  assert.match(alertHeadline(SAMPLE, { now: new Date('2026-09-28T20:00:00Z') }), /НОВИЙ ДЕНЬ/);
  const near = JSON.stringify([{ officeCity: 'Snina', dates: ['15.09.2026'] }]);
  assert.match(alertHeadline(near, { now: new Date('2026-09-14T07:30:00Z') }), /окремий час/);
});

test('one new day among leftovers still makes it the batch', () => {
  const mixed = JSON.stringify([{ officeCity: 'Snina', dates: ['20.10.2026', '01.10.2026'] }]);
  assert.match(alertHeadline(mixed, { now: new Date('2026-09-28T20:00:00Z') }), /НОВИЙ ДЕНЬ/);
});

test('an unreadable answer gets no headline rather than a wrong one', () => {
  assert.equal(alertHeadline('<html>'), null);
  assert.equal(alertHeadline('[]'), null);
});

test('a date in some other format is never called the batch', () => {
  const odd = JSON.stringify([{ officeCity: 'Snina', dates: ['2026-10-20'] }]);
  assert.match(alertHeadline(odd, { now: new Date('2026-09-28T20:00:00Z') }), /окремий час/);
});
