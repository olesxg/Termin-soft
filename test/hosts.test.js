import test from 'node:test';
import assert from 'node:assert/strict';

import { isThirdPartyHost } from '../src/hosts.js';
import { scoreRequest } from '../src/rank.js';
import { parseSessions } from '../src/sessions.js';
import { PORTAL_NO_SLOTS_PHRASES } from '../src/detect.js';

test('the portal is not third-party; Google and friends are', () => {
  assert.equal(isThirdPartyHost('https://portal.minv.sk/wps/portal/x'), false);
  assert.equal(isThirdPartyHost('https://pes.minv.sk/'), false);
  assert.equal(isThirdPartyHost('http://127.0.0.1:8092/x'), false, 'local fakes must still work');

  assert.equal(isThirdPartyHost('https://www.google.com/complete/search?q=a'), true);
  assert.equal(isThirdPartyHost('https://encrypted-tbn0.gstatic.com/x'), true);
  assert.equal(isThirdPartyHost('https://region1.google-analytics.com/g/collect'), true);
  assert.equal(isThirdPartyHost('https://api.ipify.org/?format=json'), true);
});

test('a host that merely contains the name is not matched', () => {
  assert.equal(isThirdPartyHost('https://google.com.evil.sk/x'), false);
  assert.equal(isThirdPartyHost('https://notgoogle.com/x'), false);
});

test('junk input does not throw', () => {
  for (const bad of ['', 'not a url', null, undefined]) {
    assert.equal(isThirdPartyHost(bad), false);
  }
});

test('the Google response that once won the ranking now cannot', () => {
  // Real shape: JSON, an XHR, dates and Slovak words in the trending payload.
  const suggest = {
    resourceType: 'xhr',
    method: 'GET',
    url: 'https://www.google.com/complete/search?client=chrome&q=termin',
    responseContentType: 'application/json',
    postData: '',
    responseBody: `)]}'\n[[["voľné termíny",0,[3,143]],["01.09.2026",0,[3]],["02.09.2026",0,[3]],["03.09.2026",0,[3]]]]`,
  };
  const portal = {
    resourceType: 'xhr',
    method: 'POST',
    url: 'https://portal.minv.sk/wps/portal/x/res/id=available-offices-service-date/=/?tida=0',
    responseContentType: 'application/json',
    postData: 'data=%7B%22serviceBranchID%22%3A%22abc%22%7D',
    responseBody: '{"services":[]}',
  };
  assert.ok(scoreRequest(suggest, PORTAL_NO_SLOTS_PHRASES) < 0, 'must never be a candidate');
  assert.ok(scoreRequest(portal, PORTAL_NO_SLOTS_PHRASES) > scoreRequest(suggest, PORTAL_NO_SLOTS_PHRASES));
});

test('a pooled session pointing off-portal is skipped, and says why', () => {
  const { sessions, skipped } = parseSessions([
    { label: 's1 22:55', url: 'https://www.google.com/complete/search', cookie: 'a=b', method: 'GET' },
    { label: 's2 17:24', url: 'https://portal.minv.sk/wps/portal/x', cookie: 'c=d', method: 'POST' },
  ]);
  assert.equal(sessions.length, 1, 'only the portal session survives');
  assert.equal(sessions[0].label, 's2 17:24');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /google\.com.*not the portal/);
});
