import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSessions, nextSession, retireSession, liveSessions, summarise, mergeSessions, freshSessions, serviceLabelOf } from '../src/sessions.js';

const raw = (n) =>
  Array.from({ length: n }, (_, i) => ({ label: `s${i + 1}`, cookie: `JSESSIONID=${i}`, url: 'https://portal/x' }));

test('a plain array and a {sessions:[...]} wrapper both parse', () => {
  assert.equal(parseSessions(raw(3)).sessions.length, 3);
  assert.equal(parseSessions({ sessions: raw(2) }).sessions.length, 2);
});

test('a session with no cookie is skipped, and says why', () => {
  const { sessions, skipped } = parseSessions([{ label: 'broken', url: 'https://portal/x' }, ...raw(1)]);
  assert.equal(sessions.length, 1);
  assert.match(skipped[0], /missing cookie/);
});

test('junk entries do not throw', () => {
  assert.deepEqual(parseSessions(null).sessions, []);
  assert.deepEqual(parseSessions('nonsense').sessions, []);
  assert.equal(parseSessions([null, 42]).sessions.length, 0);
});

/** Walk the rotation n times, threading the cursor as the monitor does. */
const walk = (s, n) => {
  const out = [];
  let cursor = -1;
  for (let i = 0; i < n; i += 1) {
    const next = nextSession(s, cursor);
    if (!next) break;
    out.push(next.session.label);
    cursor = next.cursor;
  }
  return out;
};

test('polls go round the sessions in turn', () => {
  assert.deepEqual(walk(parseSessions(raw(3)).sessions, 6), ['s1', 's2', 's3', 's1', 's2', 's3']);
});

test('every session gets a turn — none is skipped as the pool shrinks', () => {
  // The bug this guards: indexing into the live subset polled s1, s3, s5, s7
  // out of eight and left the even ones to expire untouched.
  const s = parseSessions(raw(8)).sessions;
  const seen = new Set();
  let cursor = -1;
  for (let i = 0; i < 8; i += 1) {
    const next = nextSession(s, cursor);
    seen.add(next.session.label);
    cursor = next.cursor;
  }
  assert.equal(seen.size, 8);
});

test('a dead session is stepped over, the rest keep their order', () => {
  const s = parseSessions(raw(3)).sessions;
  retireSession(s[1], '401');
  assert.deepEqual(walk(s, 4), ['s1', 's3', 's1', 's3']);
});

test('a session dying mid-walk does not cost its neighbour a turn', () => {
  const s = parseSessions(raw(4)).sessions;
  let cursor = -1;
  const order = [];
  for (let i = 0; i < 5; i += 1) {
    const next = nextSession(s, cursor);
    order.push(next.session.label);
    if (next.session.label === 's2') retireSession(next.session, '401');
    cursor = next.cursor;
  }
  assert.deepEqual(order, ['s1', 's2', 's3', 's4', 's1']);
});

test('when every session is spent there is nothing to poll', () => {
  const s = parseSessions(raw(2)).sessions;
  s.forEach((x) => retireSession(x, '401'));
  assert.equal(nextSession(s, -1), null);
  assert.deepEqual(liveSessions(s), []);
});

test('the summary distinguishes spent sessions from live ones', () => {
  const s = parseSessions(raw(2)).sessions;
  s[0].calls = 4;
  retireSession(s[1], 'CALL_LIMIT x3');
  assert.equal(summarise(s), 's1: 4 calls | s2: dead (CALL_LIMIT x3)');
});

test('parsing keeps the fields the request needs', () => {
  const [s] = parseSessions([
    { label: 'a', cookie: 'c', url: 'u', csrfToken: 't', body: 'data=1', referer: 'r' },
  ]).sessions;
  assert.equal(s.csrfToken, 't');
  assert.equal(s.body, 'data=1');
  assert.equal(s.referer, 'r');
  assert.equal(s.calls, 0);
  assert.equal(s.dead, false);
});

test('new sessions from disk join a running pool', () => {
  const current = parseSessions(raw(2)).sessions;
  const incoming = parseSessions(raw(4)).sessions;
  const { merged, added } = mergeSessions(current, incoming);
  assert.equal(merged.length, 4);
  assert.deepEqual(added.map((s) => s.label), ['s3', 's4']);
});

test('re-reading the same file adds nothing', () => {
  const current = parseSessions(raw(3)).sessions;
  const { merged, added } = mergeSessions(current, parseSessions(raw(3)).sessions);
  assert.equal(merged.length, 3);
  assert.deepEqual(added, []);
});

test('a retired session is not resurrected by a file that still lists it', () => {
  const current = parseSessions(raw(2)).sessions;
  retireSession(current[0], '401');
  const { merged } = mergeSessions(current, parseSessions(raw(2)).sessions);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].dead, true);
  assert.deepEqual(liveSessions(merged).map((s) => s.label), ['s2']);
});

test('call counts and state survive a merge', () => {
  const current = parseSessions(raw(1)).sessions;
  current[0].calls = 3;
  const { merged } = mergeSessions(current, parseSessions(raw(2)).sessions);
  assert.equal(merged[0].calls, 3);
  assert.equal(merged[1].calls, 0);
});

test('entries with no cookie are never merged in', () => {
  const { added } = mergeSessions([], [{ label: 'broken', cookie: '' }]);
  assert.deepEqual(added, []);
});

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

test('sessions older than the idle cutoff are dropped', () => {
  const kept = freshSessions(
    [
      { label: 'fresh', capturedAt: minutesAgo(5) },
      { label: 'old', capturedAt: minutesAgo(200) },
      { label: 'borderline', capturedAt: minutesAgo(89) },
    ],
    90,
  );
  assert.deepEqual(kept.map((s) => s.label), ['fresh', 'borderline']);
});

test('an unknown capture time is kept — not knowing is not proof of death', () => {
  const kept = freshSessions([{ label: 'no date' }, { label: 'junk', capturedAt: 'nonsense' }], 90);
  assert.equal(kept.length, 2);
});

test('the refresh path uses the same cutoff, so corpses cannot come back', () => {
  // The bug: startup dropped two 3-hour-old sessions and the very next refresh
  // merged them straight back in, each then costing a poll to rediscover.
  const onDisk = [
    { label: 's1', url: 'https://portal.minv.sk/a', cookie: 'a=1', method: 'POST', capturedAt: minutesAgo(200) },
    { label: 's2', url: 'https://portal.minv.sk/b', cookie: 'b=2', method: 'POST', capturedAt: minutesAgo(2) },
  ];
  const { sessions } = parseSessions(onDisk);
  const { merged } = mergeSessions([], freshSessions(sessions, 90));
  assert.deepEqual(merged.map((s) => s.label), ['s2']);
});

test('nothing survives when every session is stale', () => {
  assert.deepEqual(freshSessions([{ capturedAt: minutesAgo(500) }], 90), []);
});

test('the service reported is the one the session actually asks about', () => {
  // The bug: the session's own body is what gets sent, but the log printed the
  // rotation's current label — naming Biosnímanie while asking about Registrácia.
  const session = {
    body: 'data=%7B%22serviceBranchID%22%3A%2269d5d361%22%7D',
    service: { id: '69d5d361', label: 'Dočasné útočisko / Registrácia dočasného útočiska' },
  };
  assert.match(serviceLabelOf(session, 'Biosnímanie'), /Registrácia/);
});

test('with no recorded name the id is reported, never the rotation', () => {
  const session = { body: 'data=%7B%22serviceBranchID%22%3A%22abc123%22%7D' };
  assert.equal(serviceLabelOf(session, 'Biosnímanie'), 'abc123');
});

test('only a session with no body falls back to the rotation', () => {
  assert.equal(serviceLabelOf({}, 'Biosnímanie'), 'Biosnímanie');
  assert.equal(serviceLabelOf(null, 'Biosnímanie'), 'Biosnímanie');
});

test('a session spent by CALL_LIMIT leaves the rotation at once', () => {
  const { sessions } = parseSessions([
    { label: 'sA', url: 'https://portal.minv.sk/a', cookie: 'a=1', method: 'POST' },
    { label: 'sB', url: 'https://portal.minv.sk/b', cookie: 'b=2', method: 'POST' },
  ]);
  retireSession(sessions[0], 'CALL_LIMIT x1');

  assert.deepEqual(liveSessions(sessions).map((s) => s.label), ['sB']);
  assert.equal(nextSession(sessions, -1).session.label, 'sB', 'the next poll goes to the survivor');
});

test('retiring the last session empties the pool instead of leaving it waiting', () => {
  // CALL_LIMIT never lifts, so a lone spent session must not be sat out for ten
  // minutes: an empty pool has to be reported while there is still time to
  // capture another.
  const { sessions } = parseSessions([
    { label: 'only', url: 'https://portal.minv.sk/a', cookie: 'a=1', method: 'POST' },
  ]);
  retireSession(sessions[0], 'CALL_LIMIT x1');

  assert.equal(liveSessions(sessions).length, 0);
  assert.equal(nextSession(sessions, -1), null, 'nothing left to poll — the spent path must fire');
});
