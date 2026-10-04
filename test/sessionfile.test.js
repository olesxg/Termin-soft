import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionsFile, appendSessionRecord, sessionRecord } from '../src/sessionfile.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termin-')), 'sessions.json');

const BODY = 'data=%7B%22serviceBranchID%22%3A%22aaa11111%22%2C%22authValue%22%3A%22false%22%7D';
const SERVICES = [{ id: 'aaa11111', name: 'Registrácia dočasného útočiska', group: 'Dočasné útočisko' }];

const build = (over = {}) =>
  sessionRecord({
    index: 1,
    url: 'https://portal.minv.sk/wps/x/res/id=available-offices-service-date/=/?tida=0',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://portal.minv.sk/wps/wizard',
      'X-CSRF-TOKEN': '87448ac3',
    },
    cookie: 'JSESSIONID=abc',
    userAgent: 'Mozilla/5.0',
    body: BODY,
    services: SERVICES,
    ...over,
  });

test('a missing or broken file reads as an empty pool', () => {
  assert.deepEqual(readSessionsFile('/does/not/exist.json'), []);
  const file = tmpFile();
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(readSessionsFile(file), []);
  fs.writeFileSync(file, '{"sessions":[]}');
  assert.deepEqual(readSessionsFile(file), [], 'a bare object is not a pool');
});

test('the record carries everything a replay needs', () => {
  const record = build();
  assert.equal(record.cookie, 'JSESSIONID=abc');
  assert.equal(record.csrfHeaderName, 'X-CSRF-TOKEN');
  assert.equal(record.csrfToken, '87448ac3');
  assert.equal(record.referer, 'https://portal.minv.sk/wps/wizard');
  assert.ok(Date.parse(record.capturedAt), 'the age filter needs this');
});

test('the service is named, not just numbered', () => {
  assert.deepEqual(build().service, { id: 'aaa11111', label: 'Dočasné útočisko / Registrácia dočasného útočiska' });
});

test('an id the services tree never mentioned is kept, unnamed', () => {
  assert.deepEqual(build({ services: [] }).service, { id: 'aaa11111', label: null });
});

test('a body with no service id gives no service, rather than a wrong one', () => {
  assert.equal(build({ body: 'data=%7B%22pincode%22%3A%221%22%7D' }).service, null);
});

test('the referer falls back to the page the request came from', () => {
  const record = build({ headers: {}, referer: 'https://portal.minv.sk/wps/portal/domov' });
  assert.equal(record.referer, 'https://portal.minv.sk/wps/portal/domov');
});

test('appending grows the pool and reports its size', () => {
  const file = tmpFile();
  assert.deepEqual(appendSessionRecord(file, build()), { size: 1, added: true });
  assert.deepEqual(appendSessionRecord(file, build({ cookie: 'JSESSIONID=def', index: 2 })), { size: 2, added: true });
  assert.equal(readSessionsFile(file).length, 2);
});

test('the same cookie is never pooled twice', () => {
  const file = tmpFile();
  appendSessionRecord(file, build());
  assert.deepEqual(appendSessionRecord(file, build()), { size: 1, added: false });
  assert.equal(readSessionsFile(file).length, 1);
});

test('the recorded services step survives the round trip', () => {
  const file = tmpFile();
  const step = { url: 'https://portal.minv.sk/wps/x/res/id=reservation/', method: 'POST', body: 'reservation=1' };
  appendSessionRecord(file, build({ servicesStep: step }));
  assert.deepEqual(readSessionsFile(file)[0].servicesStep, step);
});
