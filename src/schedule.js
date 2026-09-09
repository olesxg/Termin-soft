/**
 * Wall-clock aligned polling.
 *
 * A fixed interval drifts: start at 22:55 and the polls land wherever the
 * arithmetic puts them. If the portal releases slots on a rhythm, you want the
 * calls to land ON that rhythm instead of near it — same number of calls,
 * placed deliberately.
 *
 * This does NOT buy extra calls. The session's budget is ~5 requests to the
 * date endpoint no matter how they are spaced, so alignment is about WHERE the
 * five land, never how many there are.
 */

/**
 * Next wall-clock instant strictly after `now` whose minute satisfies
 * `minute % minuteMod === minuteOffset % minuteMod` and whose second is
 * `second`.
 *
 * @returns {Date|null} null when minuteMod is not a positive number
 */
export function nextAlignedTime(now, { minuteMod = 10, minuteOffset = 8, second = 58 } = {}) {
  if (!Number.isFinite(minuteMod) || minuteMod <= 0) return null;

  const target = new Date(now.getTime());
  target.setSeconds(second, 0);

  // Walk forward a minute at a time. Two full cycles is always enough to find a
  // match, and bounding the loop keeps a bad config from hanging the monitor.
  for (let i = 0; i <= minuteMod * 2 + 2; i += 1) {
    if (target.getTime() > now.getTime() && target.getMinutes() % minuteMod === minuteOffset % minuteMod) {
      return target;
    }
    target.setMinutes(target.getMinutes() + 1);
  }
  return null;
}

/**
 * Where in the cycle this moment sits — the minute offset to re-aim at.
 *
 * A slot found at 23:08 says the portal releases them at :08 past each ten
 * minutes. Scanning found the rhythm; this is what lets the next pass camp on
 * it instead of carrying on blind.
 */
export function minuteOffsetOf(date, minuteMod) {
  if (!Number.isFinite(minuteMod) || minuteMod <= 0) return null;
  return date.getMinutes() % minuteMod;
}

/** Milliseconds to wait until that instant; null when alignment is off. */
export function alignedDelayMs(now, options) {
  const at = nextAlignedTime(now, options);
  return at === null ? null : at.getTime() - now.getTime();
}
