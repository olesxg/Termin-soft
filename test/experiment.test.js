import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { record, withTabId, nextTabId, markTabId, summarise } from '../src/experiment.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termin-')), 'experiment.jsonl');

test('rows are appended one JSON object per line', () => {
  const file = tmpFile();
  assert.equal(record(file, { kind: 'date', label: 's1' }), true);
  assert.equal(record(file, { kind: 'retire', label: 's1' }), true);

  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'date');
  assert.ok(Date.parse(rows[0].at), 'every row is timestamped');
});

test('an unwritable log is reported, never thrown', () => {
  assert.equal(record(path.join('/does/not/exist', 'x.jsonl'), { kind: 'date' }), false);
  assert.equal(record('', { kind: 'date' }), false);
});

test('tida is replaced in place, keeping the rest of the query', () => {
  assert.equal(
    withTabId('https://portal/x/res/id=dates/=/?tida=0&language=sk', 1),
    'https://portal/x/res/id=dates/=/?tida=0&language=sk'.replace('tida=0', 'tida=1'),
  );
  assert.equal(withTabId('https://portal/x?a=1&tida=12&b=2', 3), 'https://portal/x?a=1&tida=3&b=2');
});

test('a url without tida gets one, with the right separator', () => {
  assert.equal(withTabId('https://portal/x', 1), 'https://portal/x?tida=1');
  assert.equal(withTabId('https://portal/x?a=1', 2), 'https://portal/x?a=1&tida=2');
});

test('each tab id is offered once, then the session is really spent', () => {
  const session = {};
  assert.equal(nextTabId(session, ['1', '2']), '1');
  markTabId(session, '1');
  assert.equal(nextTabId(session, ['1', '2']), '2');
  markTabId(session, '2');
  assert.equal(nextTabId(session, ['1', '2']), null);
  assert.equal(session.tabId, '2');
});

test('no configured tab ids means the experiment is off', () => {
  assert.equal(nextTabId({}, []), null);
  assert.equal(nextTabId({}, undefined), null);
});

test('the summary separates sessions that refreshed from those that did not', () => {
  const rows = [
    { kind: 'date', label: 's1', dateCalls: 1, outcome: 'no-slots' },
    { kind: 'date', label: 's1', dateCalls: 2, outcome: 'no-slots' },
    { kind: 'date', label: 's1', dateCalls: 3, outcome: 'call-limit' },
    { kind: 'retire', label: 's1', reason: 'CALL_LIMIT x1', ageMin: 12, dateCalls: 3 },
    { kind: 'refresh', label: 's2', ok: true },
    { kind: 'date', label: 's2', dateCalls: 1, outcome: 'no-slots' },
    { kind: 'date', label: 's2', dateCalls: 9, outcome: 'call-limit' },
    { kind: 'retire', label: 's2', reason: 'CALL_LIMIT x1', ageMin: 64, dateCalls: 9 },
  ];

  const out = summarise(rows);
  assert.equal(out.sessions.length, 2);
  assert.equal(out.callsWithoutRefresh, 3);
  assert.equal(out.callsWithRefresh, 9);
  assert.deepEqual(out.deathAges, [12, 64]);

  const first = out.sessions.find((s) => s.label === 's1');
  assert.equal(first.callsBeforeLimit, 3);
  assert.equal(first.refreshes, 0);
});

test('a failed refresh is counted apart from a successful one', () => {
  const out = summarise([
    { kind: 'refresh', label: 's1', ok: false, reason: 'no services step recorded' },
    { kind: 'date', label: 's1', dateCalls: 1, outcome: 'no-slots' },
  ]);
  const session = out.sessions[0];
  assert.equal(session.refreshes, 0);
  assert.equal(session.refreshFailures, 1);
  assert.equal(out.callsWithRefresh, null, 'a failed refresh must not count as a refreshed session');
});

test('rows with no session label are ignored rather than crashing the report', () => {
  assert.deepEqual(summarise([{ kind: 'date' }, null, 42]).sessions, []);
});
