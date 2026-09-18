import test from 'node:test';
import assert from 'node:assert/strict';

import { firstOffer, SELECTORS, prepareBooking, parseCookieHeader, recordRequests } from '../src/booking.js';

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
    // Two steps wait now: the office radio only exists after the human has
    // done the CAPTCHA and SMS, so it is waited for like the time list is.
    waitForSelector: async (sel) =>
      guard(String(sel).includes('vyberPracoviska') ? 'waitOffice' : 'waitTime'),
    locator: () => ({ first: () => ({ check: async () => guard('time') }) }),
    screenshot: async () => guard('screenshot'),
  };
};

test('it selects office, date and time — and never presses Continue', async () => {
  const page = fakePage();
  const result = await prepareBooking(page, firstOffer(REAL_SAMPLE));
  assert.deepEqual(result, { ok: true, step: 'ready' });
  assert.deepEqual(page.calls, ['focus', 'waitOffice', 'office', 'date', 'waitTime', 'time']);
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
  // The wait comes before the check now, and nothing after office runs.
  assert.deepEqual(page.calls, ['focus', 'waitOffice', 'office']);
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

test('the office wait is long enough to cover a CAPTCHA and an SMS', async () => {
  // The window opens at step one, so the radio appears only after the human has
  // authenticated. A five-second wait — the old behaviour — meant the pre-fill
  // never had a chance and everything was left to be retyped under time pressure.
  const seen = [];
  const page = {
    bringToFront: async () => {},
    waitForSelector: async (sel, opts) => {
      seen.push({ sel, timeout: opts?.timeout });
      throw new Error('not there yet');
    },
    check: async () => {},
    selectOption: async () => {},
    locator: () => ({ first: () => ({ check: async () => {} }) }),
  };

  await prepareBooking(page, firstOffer(REAL_SAMPLE));
  assert.equal(seen.length, 1);
  assert.match(seen[0].sel, /vyberPracoviska/);
  assert.ok(seen[0].timeout >= 60_000, `waited only ${seen[0].timeout}ms — too short for a CAPTCHA`);
});

test('the office wait timeout is configurable', async () => {
  let got = null;
  const page = {
    bringToFront: async () => {},
    waitForSelector: async (sel, opts) => { got = opts?.timeout; throw new Error('stop'); },
    check: async () => {},
    selectOption: async () => {},
    locator: () => ({ first: () => ({ check: async () => {} }) }),
  };

  await prepareBooking(page, firstOffer(REAL_SAMPLE), { officeTimeoutMs: 1234 });
  assert.equal(got, 1234);
});

/** Minimal Playwright doubles: one response, delivered to the 'response' handler. */
const responseDouble = ({ url, status = 200, method = 'POST', postData = '', body = '{}' }) => ({
  url: () => url,
  status: () => status,
  text: async () => body,
  request: () => ({
    method: () => method,
    resourceType: () => 'xhr',
    allHeaders: async () => ({ cookie: 'JSESSIONID=x' }),
    postData: () => postData,
  }),
});

const recordingPage = () => {
  const handlers = {};
  return { on: (ev, fn) => { handlers[ev] = fn; }, fire: (resp) => handlers.response(resp) };
};

const fsDouble = () => {
  const lines = [];
  return { lines, appendFileSync: (_f, line) => lines.push(JSON.parse(line)) };
};

test('the booking window records the resource id and payload', async () => {
  // This is what makes auto-booking possible at all: the reservation request has
  // never been seen, and pressing Pokračovať reveals it even if the race is lost.
  const page = recordingPage();
  const fs = fsDouble();
  recordRequests(page, 'log.jsonl', { fs });

  await page.fire(responseDouble({
    url: 'https://portal.minv.sk/wps/portal/x/res/id=reservation-create/=/?tida=0',
    postData: 'data=%7B%22branchPublicId%22%3A%22abc%22%7D',
    body: '{"code":"200"}',
  }));

  assert.equal(fs.lines.length, 1);
  assert.equal(fs.lines[0].resourceId, 'reservation-create');
  assert.equal(fs.lines[0].method, 'POST');
  assert.match(fs.lines[0].postData, /branchPublicId/);
  assert.equal(fs.lines[0].responseBody, '{"code":"200"}');
});

test('calls to anything but the portal are not recorded', async () => {
  const page = recordingPage();
  const fs = fsDouble();
  recordRequests(page, 'log.jsonl', { fs });

  await page.fire(responseDouble({ url: 'https://www.google-analytics.com/collect' }));
  assert.equal(fs.lines.length, 0);
});

test('a failing write never breaks a booking in progress', async () => {
  const page = recordingPage();
  recordRequests(page, 'log.jsonl', {
    fs: { appendFileSync: () => { throw new Error('disk full'); } },
  });

  await page.fire(responseDouble({ url: 'https://portal.minv.sk/wps/portal/x/res/id=whatever/=/' }));
  // Reaching here without throwing is the assertion.
  assert.ok(true);
});
