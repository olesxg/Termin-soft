/**
 * Spend each session's whole budget before it dies, spread evenly over its life.
 *
 * A wall-clock grid asks once per mark whichever session is next in turn. With
 * one session that is fine; with two, each is asked half as often and they
 * die of age with calls still unspent — s12+s13 and s18+s19 each managed three
 * answers of four that way. A session's calls are worth nothing once it is
 * dead, so the schedule belongs to the session, not to the clock.
 *
 * With budget B and a deadline D after the first call, the calls land at
 * 0, D/(B-1), 2D/(B-1) … D: the whole life watched, the last call at the end.
 * Past its estimated budget a live session is asked again at once, so a budget
 * larger than estimated is found and used rather than left to expire.
 */

/**
 * When this session should next be asked, as epoch ms.
 *
 * @returns {number} Infinity for a dead session
 */
export function dueAt(session, { budget, lifeMs, marginMs = 0, now = Date.now() }) {
  if (!session || session.dead) return Infinity;

  const captured = Date.parse(session.capturedAt ?? '');
  if (Number.isNaN(captured)) return now; // unknown age: spend it while it lasts

  const last = session.lastCallAt ?? null;
  if (last === null) return now; // never asked yet: ask now

  const remaining = budget - (session.calls ?? 0);
  if (remaining <= 0) return now; // budget estimate spent: probe, CALL_LIMIT will say if it is over

  const deadline = captured + lifeMs - marginMs;
  const spacing = Math.max(0, (deadline - last) / remaining);
  return Math.min(last + spacing, Math.max(deadline, last));
}

/**
 * The live session to ask next, and when — the one whose turn comes first.
 *
 * @returns {{session: object, at: number}|null} null when none is live
 */
export function nextDue(sessions, options) {
  let best = null;
  for (const session of sessions ?? []) {
    const at = dueAt(session, options);
    if (at === Infinity) continue;
    if (best === null || at < best.at) best = { session, at };
  }
  return best;
}
