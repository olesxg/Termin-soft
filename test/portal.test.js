import test from 'node:test';
import assert from 'node:assert/strict';

import { readPortalStatus, backoffDelay } from '../src/portal.js';

// Both of these arrived with HTTP 200 from the live portal.
test('an expired session is reported in the body, not the status', () => {
  const s = readPortalStatus('{"code":"401"}');
  assert.equal(s.authFailed, true);
  assert.equal(s.callLimit, false);
  assert.equal(s.code, '401');
});

test('CALL_LIMIT is throttling, not an auth failure', () => {
  const s = readPortalStatus('{"code" : "500", "message" : "CALL_LIMIT"}');
  assert.equal(s.callLimit, true);
  assert.equal(s.authFailed, false, 'must not be mistaken for a dead session');
});

test('403 in the body also counts as rejected', () => {
  assert.equal(readPortalStatus('{"code":403}').authFailed, true, 'numeric code too');
});

test('a normal payload is neither', () => {
  const s = readPortalStatus('{"services":[]}');
  assert.equal(s.authFailed, false);
  assert.equal(s.callLimit, false);
  assert.equal(s.code, null);
});

test('a success code is not an auth failure', () => {
  assert.equal(readPortalStatus('{"code":"200","isValid":true}').authFailed, false);
});

test('non-JSON and edge cases do not throw', () => {
  for (const input of ['', null, undefined, '<html>nope</html>', '[]', 'null', '"str"']) {
    const s = readPortalStatus(input);
    assert.equal(s.authFailed, false);
    assert.equal(s.callLimit, false);
  }
});

test('backoff grows then stops at the cap', () => {
  assert.equal(backoffDelay(60_000, 1), 60_000);
  assert.equal(backoffDelay(60_000, 2), 120_000);
  assert.equal(backoffDelay(60_000, 3), 240_000);
  assert.equal(backoffDelay(60_000, 99), 600_000, 'capped at 10 minutes');
  assert.equal(backoffDelay(60_000, 0), 60_000, 'no negative exponent');
});
