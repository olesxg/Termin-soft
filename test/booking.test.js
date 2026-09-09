import test from 'node:test';
import assert from 'node:assert/strict';

import { firstOffer, SELECTORS, prepareBooking, parseCookieHeader } from '../src/booking.js';

const REAL_SAMPLE = JSON.stringify([
  {
    officeName: 'OCP Michalovce, pracovisko Snina',
    officeCity: 'Snina',
    officeStreet: 'Partizánska 1057',
    branchPublicId: '357d86a30cc9acce45d696bdfc148250770c5220ecf7a81f2ab984e304baac32',
    dates: ['18.09.2026'],
  },
]);

test('the office id from the API is the id the radio carries', () => {
  const offer = firstOffer(REAL_SAMPLE);
  assert.equal(offer.date, '18.09.2026');
  assert.equal(
    SELECTORS.office(offer.branchPublicId),
    'input#input-vyberPracoviska-357d86a30cc9acce45d696bdfc148250770c5220ecf7a81f2ab984e304baac32',
  );
});

test('a {services:[...]} wrapper works as well as a bare array', () => {
  assert.equal(firstOffer(`{"services":${REAL_SAMPLE}}`).date, '18.09.2026');
});

test('an office with no dates is skipped for one that has them', () => {
  const sample = JSON.stringify([
    { officeName: 'empty', branchPublicId: 'aaa', dates: [] },
    { officeName: 'real', branchPublicId: 'bbb', dates: ['01.10.2026'] },
  ]);
  assert.deepEqual(firstOffer(sample), { branchPublicId: 'bbb', date: '01.10.2026', officeName: 'real' });
});

test('unfamiliar shapes give null rather than throwing', () => {
  assert.equal(firstOffer('not json'), null);
  assert.equal(firstOffer('{}'), null);
  assert.equal(firstOffer('[]'), null);
  assert.equal(firstOffer(JSON.stringify([{ officeName: 'no id', dates: ['1.1.2026'] }])), null);
});

/** Minimal page double — records the calls prepareBooking makes, in order. */
const fakePage = (failAt = null) => {
  const calls = [];
  const guard = (name) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} exploded`);
  };
  return {
    calls,
    bringToFront: async () => guard('focus'),
    check: async () => guard('office'),
    selectOption: async () => guard('date'),
    waitForSelector: async () => guard('waitTime'),
    locator: () => ({ first: () => ({ check: async () => guard('time') }) }),
    screenshot: async () => guard('screenshot'),
  };
};

test('it selects office, date and time — and never presses Continue', async () => {
  const page = fakePage();
  const result = await prepareBooking(page, firstOffer(REAL_SAMPLE));
  assert.deepEqual(result, { ok: true, step: 'ready' });
  assert.deepEqual(page.calls, ['focus', 'office', 'date', 'waitTime', 'time']);
});

test('a failure is reported, not thrown — the alarm must still fire', async () => {
  const result = await prepareBooking(fakePage('date'), firstOffer(REAL_SAMPLE));
  assert.equal(result.ok, false);
  assert.equal(result.step, 'date');
  assert.match(result.detail, /exploded/);
});

test('it stops at the first failing step and does not carry on', async () => {
  const page = fakePage('office');
  await prepareBooking(page, firstOffer(REAL_SAMPLE));
  assert.deepEqual(page.calls, ['focus', 'office']);
});

test('the Cookie header splits into name/value pairs', () => {
  const parsed = parseCookieHeader('JSESSIONID=abc123; _ga=GA1.2.3; csrftoken=xyz');
  assert.deepEqual(parsed, [
    { name: 'JSESSIONID', value: 'abc123' },
    { name: '_ga', value: 'GA1.2.3' },
    { name: 'csrftoken', value: 'xyz' },
  ]);
});

test('a value containing = survives intact', () => {
  assert.deepEqual(parseCookieHeader('t=a=b=c'), [{ name: 't', value: 'a=b=c' }]);
});

test('junk segments are dropped rather than producing empty cookies', () => {
  assert.deepEqual(parseCookieHeader('; ;  ; a=1;;'), [{ name: 'a', value: '1' }]);
  assert.deepEqual(parseCookieHeader(''), []);
  assert.deepEqual(parseCookieHeader(null), []);
  assert.deepEqual(parseCookieHeader('=novalue'), []);
});
