import { isThirdPartyHost } from './hosts.js';
/**
 * Several captured sessions, polled in rotation.
 *
 * The portal's CALL_LIMIT counter is per session, not per IP and not per
 * person: measured on 2026-08-27, a session that died of CALL_LIMIT at 19:04
 * was followed by fresh captures at 20:28, 22:17, 22:32 and 22:55 — same exit
 * address, same applicant, minutes apart — and every one of them got its own
 * full budget. So N captures really do buy N times the observations.
 *
 * Round-robin has a second benefit that matters as much as the budget: a
 * session also dies after 15-30 idle minutes, and rotating touches each one
 * every Nth poll, which keeps them all warm at no extra cost.
 *
 * What is NOT established: whether several sessions can be held at the same
 * time. Every session so far was captured after the previous had already died,
 * so a portal that invalidates the older session on a new capture would look
 * identical to what we have seen. Capture two and poll both to find out.
 */

/** Fields a session must carry to be replayable on its own. */
const REQUIRED = ['cookie', 'url'];

/**
 * @param {unknown} raw parsed sessions file — an array, or {sessions: [...]}
 * @returns {{sessions: object[], skipped: string[]}}
 */
export function parseSessions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.sessions) ? raw.sessions : [];
  const sessions = [];
  const skipped = [];

  list.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      skipped.push(`#${i + 1}: not an object`);
      return;
    }
    const missing = REQUIRED.filter((key) => !entry[key]);
    if (missing.length > 0) {
      skipped.push(`#${i + 1} (${entry.label ?? 'unlabelled'}): missing ${missing.join(', ')}`);
      return;
    }
    // A pooled session that points somewhere else is worse than no session: it
    // still takes its turn in the rotation and spends a poll answering nothing.
    if (isThirdPartyHost(entry.url)) {
      skipped.push(`#${i + 1} (${entry.label ?? 'unlabelled'}): points at ${new URL(entry.url).hostname}, not the portal`);
      return;
    }
    sessions.push({
      label: entry.label ?? `session ${i + 1}`,
      dead: false,
      reason: null,
      calls: 0,
      ...entry,
    });
  });

  return { sessions, skipped };
}

/** Sessions still worth spending a poll on. */
export function liveSessions(sessions) {
  return sessions.filter((s) => !s.dead);
}

/**
 * Next live session after `cursor`, walking the full list.
 *
 * Indexing into the live subset (live[poll % live.length]) looks equivalent
 * and is not: every death shortens the list, so the modulus lands somewhere
 * else and whole sessions never get a turn. Observed on 2026-08-28 — a pool of
 * eight was polled s1, s3, s5, s7, skipping every even one while they sat
 * idle and expired.
 *
 * @param {number} cursor index last used, -1 to start
 * @returns {{session: object, cursor: number}|null} null when all are spent
 */
export function nextSession(sessions, cursor = -1) {
  if (sessions.length === 0) return null;
  for (let step = 1; step <= sessions.length; step += 1) {
    const i = (cursor + step + sessions.length) % sessions.length;
    if (!sessions[i].dead) return { session: sessions[i], cursor: i };
  }
  return null;
}

/**
 * Retire a session. A 401 is final; CALL_LIMIT is not — that one recovers, so
 * it must not remove the session from the rotation permanently.
 */
export function retireSession(session, reason) {
  session.dead = true;
  session.reason = reason;
  return session;
}

/** One-line summary per session, for the status line and the log. */
export function summarise(sessions) {
  return sessions
    .map((s) => `${s.label}: ${s.dead ? `dead (${s.reason})` : `${s.calls} calls`}`)
    .join(' | ');
}

/**
 * Fold sessions freshly read from disk into a pool that is already running.
 *
 * The monitor read the file once at startup, so captures taken while it ran
 * were invisible until a restart — and restarting mid-evening means dropping
 * the hunt state and re-reading everything. Merging lets the pool be topped up
 * live.
 *
 * Identity is the cookie: the same session re-read must not be added twice,
 * and an entry already retired must stay retired rather than being resurrected
 * by a stale file that still lists it.
 *
 * @returns {{merged: object[], added: object[]}}
 */
export function mergeSessions(current, incoming) {
  const known = new Set(current.map((s) => s.cookie));
  const added = incoming.filter((s) => s.cookie && !known.has(s.cookie));
  return { merged: [...current, ...added], added };
}
