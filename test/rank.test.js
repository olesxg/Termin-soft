import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreRequest, countDates } from '../src/rank.js';
import { PORTAL_NO_SLOTS_PHRASES } from '../src/detect.js';

// Every ECU AJAX call hits this one WebSphere portlet URL; only the body differs.
const PORTLET = 'https://portal.minv.sk/wps/portal/domov/ecu/ecu_elektronicke_sluzby/ecu-vysys/!ut/p/a1/pZFBb4JAEIV';

/**
 * The wizard's page-fragment loader. Its HTML embeds the portal's whole error
 * dictionary, so it mentions "voľný termín" more often than the real endpoint
 * does — this is the request that used to win the ranking by mistake.
 */
const jspFragment = {
  resourceType: 'xhr',
  method: 'POST',
  url: PORTLET,
  responseContentType: 'text/html;charset=UTF-8',
  postData: 'jsp=main1&lang=sk',
  responseBody: `<div>noAvailableSlots: 'Vo zvolenom dátume nie je prístupný žiaden voľný termín.',
    noDatesAvailable: 'Nie sú momentálne dostupné žiadne termíny. Skúste to prosím neskôr.',
    checkLimitReservation: 'Vybraný termín rezervácie je obsadený. Vyberte nový termín.',
    missDate: 'Pre zvolené pracovisko nie je k dispozícii žiadna voľná rezervácia.'</div>`,
};

const dateEndpoint = {
  resourceType: 'xhr',
  method: 'POST',
  url: PORTLET,
  responseContentType: 'application/json',
  postData: 'reservation=%7B%22office%22%3A%22BA%22%7D&tida=0&csrfToken=87448ac3&lang=sk',
  responseBody: JSON.stringify({
    dates: [{ date: '2026-08-14' }, { date: '2026-08-15' }, { date: '2026-08-18' }],
  }),
};

const analytics = {
  resourceType: 'xhr',
  method: 'POST',
  url: 'https://www.google-analytics.com/j/collect?v=1',
  responseContentType: 'text/plain',
  postData: '',
  responseBody: '2,cG-NTV7T9TQ13',
};

test('the date endpoint outranks the jsp page fragment', () => {
  const endpoint = scoreRequest(dateEndpoint, PORTAL_NO_SLOTS_PHRASES);
  const fragment = scoreRequest(jspFragment, PORTAL_NO_SLOTS_PHRASES);
  assert.ok(
    endpoint > fragment,
    `date endpoint (${endpoint}) must beat the jsp fragment (${fragment})`,
  );
});

test('an empty date list still outranks the jsp fragment', () => {
  // Mid-poll the endpoint legitimately answers "nothing free" — it must stay
  // the top candidate, otherwise capture picks the wrong URL on a quiet day.
  const empty = {
    ...dateEndpoint,
    responseBody: JSON.stringify({ dates: [], message: 'Nie sú momentálne dostupné žiadne termíny. Skúste to prosím neskôr.' }),
  };
  assert.ok(scoreRequest(empty, PORTAL_NO_SLOTS_PHRASES) > scoreRequest(jspFragment, PORTAL_NO_SLOTS_PHRASES));
});

test('analytics noise ranks below everything', () => {
  const noise = scoreRequest(analytics, PORTAL_NO_SLOTS_PHRASES);
  assert.ok(noise < scoreRequest(dateEndpoint, PORTAL_NO_SLOTS_PHRASES));
  assert.ok(noise < scoreRequest(jspFragment, PORTAL_NO_SLOTS_PHRASES));
});

test('the landing document does not win', () => {
  const doc = {
    resourceType: 'document',
    method: 'GET',
    url: 'https://pes.minv.sk/wps/wcm/connect/sk/site/main/Rezervacny-system/',
    responseContentType: 'text/html',
    postData: '',
    responseBody: 'Vyberte si agendu a termín vašej návštevy. Voľné termíny sú vyznačené.',
  };
  assert.ok(scoreRequest(doc, PORTAL_NO_SLOTS_PHRASES) < scoreRequest(dateEndpoint, PORTAL_NO_SLOTS_PHRASES));
});

test('countDates handles both Slovak and ISO formats', () => {
  assert.equal(countDates('2026-08-14 and 14. 8. 2026 and 15.08.2026'), 3);
  assert.equal(countDates('2026-08-14 2026-08-14'), 1, 'duplicates collapse');
  assert.equal(countDates(''), 0);
  assert.equal(countDates(undefined), 0);
});
