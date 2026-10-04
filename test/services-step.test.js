import test from 'node:test';
import assert from 'node:assert/strict';

import { findServicesStep, pickService, refreshedBody, serviceLabel, dueForRefresh } from '../src/services-step.js';
import { extractServices } from '../src/bodies.js';

const PORTLET = 'https://portal.minv.sk/wps/portal/x/pw/Z7_40C/res/id=available-offices-service-date/=/?tida=0';

const TREE = JSON.stringify({
  services: [
    {
      name: 'Dočasné útočisko',
      id: '242',
      serviceList: [
        { id: 'aaa11111', name: 'Registrácia dočasného útočiska' },
        { id: 'bbb22222', name: 'Žiadosť o vydanie dokladu' },
      ],
    },
    { name: 'Termíny na oddelenia', id: '217', serviceList: [{ id: 'ccc33333', name: 'Biosnímanie' }] },
  ],
});

// What the DATE endpoint answers: the same `services` key, no serviceList.
const DATES = JSON.stringify({ services: [{ branchPublicId: 'BA', officeName: 'Bratislava', dates: ['18.09.2026'] }] });

const BODY = 'data=%7B%22serviceBranchID%22%3A%22aaa11111%22%2C%22authValue%22%3A%22false%22%7D';

const entry = (over = {}) => ({
  url: 'https://portal.minv.sk/wps/portal/x/pw/Z7_40C/res/id=reservation/=/?tida=0',
  method: 'POST',
  postData: 'reservation=%7B%22x%22%3A1%7D&tida=0&csrfToken=87448ac3&lang=sk',
  requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://portal.minv.sk/wps/x' },
  responseBody: TREE,
  ...over,
});

test('finds the request whose answer listed the services', () => {
  const step = findServicesStep([entry({ responseBody: '<html>' }), entry()]);
  assert.ok(step);
  assert.match(step.url, /res\/id=reservation/);
  assert.equal(step.method, 'POST');
  assert.match(step.body, /csrfToken=87448ac3/, 'the step carries its own token in the body');
  assert.equal(step.referer, 'https://portal.minv.sk/wps/x');
});

test('the date endpoint is never mistaken for the services step', () => {
  assert.equal(findServicesStep([entry({ url: PORTLET, responseBody: DATES })]), null);
});

test('takes the newest services step, not the first', () => {
  const older = entry({ postData: 'reservation=old' });
  const newer = entry({ postData: 'reservation=new' });
  assert.equal(findServicesStep([older, newer]).body, 'reservation=new');
});

test('a step with no request body cannot be replayed, so it is not offered', () => {
  assert.equal(findServicesStep([entry({ postData: '' })]), null);
});

test('third-party json is never the services step', () => {
  assert.equal(findServicesStep([entry({ url: 'https://www.google.com/complete/search' })]), null);
});

test('junk in, null out', () => {
  assert.equal(findServicesStep([]), null);
  assert.equal(findServicesStep(null), null);
  assert.equal(findServicesStep([null, 42, {}]), null);
});

test('the service is picked by name, because the ids are reissued', () => {
  const services = extractServices(TREE);
  const picked = pickService(services, 'registracia', 'gone-stale');
  assert.equal(picked.id, 'aaa11111');
});

test('a matching name wins over the previous id', () => {
  const services = extractServices(TREE);
  assert.equal(pickService(services, 'Biosnimanie', 'aaa11111').id, 'ccc33333');
});

test('with no name to go on, the previous id is the fallback', () => {
  assert.equal(pickService(extractServices(TREE), '', 'bbb22222').id, 'bbb22222');
  assert.equal(pickService(extractServices(TREE), '', 'not-there'), null);
});

test('the refreshed body points at the new id and changes nothing else', () => {
  const out = refreshedBody(BODY, TREE, 'Žiadosť o vydanie');
  assert.equal(out.service.id, 'bbb22222');
  assert.equal(out.body, 'data=%7B%22serviceBranchID%22%3A%22bbb22222%22%2C%22authValue%22%3A%22false%22%7D');
  assert.equal(out.body.replace('bbb22222', 'aaa11111'), BODY);
});

test('an answer with no services in it yields null, never a guess', () => {
  assert.equal(refreshedBody(BODY, DATES, 'registracia'), null);
  assert.equal(refreshedBody(BODY, '{}', 'registracia'), null);
  assert.equal(refreshedBody(BODY, '<html>', 'registracia'), null);
});

test('a name that matches nothing keeps polling the same service, byte for byte', () => {
  const out = refreshedBody(BODY, TREE, 'Vodičský preukaz');
  assert.equal(out.body, BODY, 'the id it was already watching is still on offer');
  assert.equal(out.service.id, 'aaa11111');
});

test('once the id is reissued, an unmatched name leaves the body alone', () => {
  const reissued = TREE.replace('aaa11111', 'zzz99999');
  assert.equal(refreshedBody(BODY, reissued, 'Vodičský preukaz'), null);
});

test('the label is group and name, falling back to the bare id', () => {
  assert.equal(serviceLabel({ id: 'x', group: 'G', name: 'N' }), 'G / N');
  assert.equal(serviceLabel({ id: 'x', group: '', name: 'N' }), 'N');
  assert.equal(serviceLabel({ id: 'x', group: '', name: '' }), 'x');
  assert.equal(serviceLabel(null), null);
});

test('a refresh is due only once the configured number of calls is spent', () => {
  assert.equal(dueForRefresh({ callsSinceRefresh: 2 }, 3), false);
  assert.equal(dueForRefresh({ callsSinceRefresh: 3 }, 3), true);
  assert.equal(dueForRefresh({ callsSinceRefresh: 9 }, 3), true);
  assert.equal(dueForRefresh({}, 3), false);
});

test('a non-positive interval switches the refresh off, rather than firing every call', () => {
  assert.equal(dueForRefresh({ callsSinceRefresh: 9 }, 0), false);
  assert.equal(dueForRefresh({ callsSinceRefresh: 9 }, -1), false);
  assert.equal(dueForRefresh({ callsSinceRefresh: 9 }, NaN), false);
});
