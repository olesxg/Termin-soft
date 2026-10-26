import test from 'node:test';
import assert from 'node:assert/strict';

import { dueAt, nextDue } from '../src/pacing.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-26T20:00:00Z');
const opts = (now, budget = 4) => ({ budget, lifeMs: 50 * MIN, marginMs: 3 * MIN, now });
const session = (over = {}) => ({ label: 's1', capturedAt: new Date(T0).toISOString(), calls: 0, dead: false, ...over });

/** Ask a session as soon as it is due, until its estimated budget is spent. */
function simulate(s, budget = 4) {
  const times = [];
  let now = T0;
  for (let i = 0; i < budget; i += 1) {
    now = Math.max(now, dueAt(s, opts(now, budget)));
    times.push(Math.round((now - T0) / MIN));
    s.calls += 1;
    s.lastCallAt = now;
  }
  return times;
}

test('a fresh session is asked at once', () => {
  assert.equal(dueAt(session(), opts(T0)), T0);
});

test('four calls cover the whole life, the last at the deadline', () => {
  // 50min life, 3min margin: deadline 47min. Calls at 0, 47/3, 2*47/3, 47.
  assert.deepEqual(simulate(session(), 4), [0, 16, 31, 47]);
});

test('a budget of six is spread the same way, not bunched up', () => {
  assert.deepEqual(simulate(session(), 6), [0, 9, 19, 28, 38, 47]);
});

test('no call is planned past the deadline', () => {
  const s = session();
  const times = simulate(s, 4);
  assert.ok(Math.max(...times) <= 47);
});

test('past its estimated budget a live session is probed at once', () => {
  // If the real budget is larger, this finds it before the session dies;
  // if not, CALL_LIMIT retires it straight away and a fresh one is asked for.
  const s = session({ calls: 4, lastCallAt: T0 + 47 * MIN });
  const now = T0 + 47 * MIN;
  assert.equal(dueAt(s, opts(now)), now);
});

test('a session that sat idle catches up rather than wasting its calls', () => {
  // Asked once at 0, then nothing until 40min (an outage, say): three calls
  // left and 7min to the deadline — they are spread over what remains.
  const s = session({ calls: 1, lastCallAt: T0 });
  const due = dueAt(s, opts(T0 + 40 * MIN));
  assert.ok(due <= T0 + 47 * MIN, 'still due before the deadline');
});

test('a session already past its deadline is due now, not never', () => {
  const s = session({ calls: 2, lastCallAt: T0 + 49 * MIN });
  const now = T0 + 49 * MIN;
  assert.equal(dueAt(s, opts(now)), now);
});

test('a dead session is never due', () => {
  assert.equal(dueAt(session({ dead: true }), opts(T0)), Infinity);
});

test('unknown age is spent now rather than guessed at', () => {
  assert.equal(dueAt(session({ capturedAt: undefined, calls: 2, lastCallAt: T0 }), opts(T0 + MIN)), T0 + MIN);
});

test('of two sessions, the one whose turn comes first is asked', () => {
  const older = session({ label: 'old', capturedAt: new Date(T0 - 30 * MIN).toISOString(), calls: 2, lastCallAt: T0 - 5 * MIN });
  const fresh = session({ label: 'fresh', calls: 1, lastCallAt: T0 });
  const next = nextDue([fresh, older], opts(T0 + MIN));
  assert.equal(next.session.label, 'old', 'the one nearer death goes first');
});

test('two sessions both get their whole budget — the grid gave each three', () => {
  // s12 and s13 were captured three minutes apart; on the 10-minute grid each
  // got three answers before dying of age. Paced, both spend all four.
  const a = session({ label: 'a' });
  const b = session({ label: 'b', capturedAt: new Date(T0 + 3 * MIN).toISOString() });
  let now = T0;
  const asked = { a: 0, b: 0 };
  for (let i = 0; i < 8; i += 1) {
    const next = nextDue([a, b].filter((s) => s.calls < 4), opts(now));
    now = Math.max(now, next.at);
    next.session.calls += 1;
    next.session.lastCallAt = now;
    asked[next.session.label] += 1;
  }
  assert.deepEqual(asked, { a: 4, b: 4 });
  assert.ok(now <= T0 + 3 * MIN + 47 * MIN, 'all of it before the later one dies');
});

test('an empty or all-dead pool has no next session', () => {
  assert.equal(nextDue([], opts(T0)), null);
  assert.equal(nextDue([session({ dead: true })], opts(T0)), null);
  assert.equal(nextDue(undefined, opts(T0)), null);
});
