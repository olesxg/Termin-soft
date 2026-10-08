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

/**
 * Release waves.
 *
 * The portal does not dribble slots out at random: they land in batches at a
 * clock time, and people who get appointments talk about "the first wave".
 * With a budget of four, knowing that time is worth more than every other
 * scheduling knob here put together — four calls on the wave beat four
 * hundred spread across the day.
 *
 * "14:45, 22:40"
 */
export function parseWaveTimes(text) {
  const times = [];
  const bad = [];

  for (const raw of String(text ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    const match = entry.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    const hour = match ? Number(match[1]) : NaN;
    const minute = match ? Number(match[2]) : NaN;
    const second = match && match[3] !== undefined ? Number(match[3]) : 0;

    if (!match || hour > 23 || minute > 59 || second > 59) {
      bad.push(entry);
      continue;
    }
    times.push({ hour, minute, second, label: entry });
  }

  times.sort((a, b) => a.hour - b.hour || a.minute - b.minute || a.second - b.second);
  return { times, bad };
}

/**
 * Every minute of the day a wave lands on.
 *
 * With `everyMin` the given times are not the whole list, they fix the PHASE
 * of a repeating grid: 14:45 on a 20-minute grid means :05, :25 and :45 past
 * every hour. One known wave is therefore enough to derive all of them.
 */
export function waveMinutes(times, everyMin = 0) {
  if (!Array.isArray(times) || times.length === 0) return [];

  const exact = times.map(({ hour, minute }) => hour * 60 + minute);
  if (!Number.isFinite(everyMin) || everyMin <= 0) return [...new Set(exact)].sort((a, b) => a - b);

  const phases = new Set(exact.map((minute) => minute % everyMin));
  const all = [];
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    if (phases.has(minute % everyMin)) all.push(minute);
  }
  return all;
}

/**
 * When to fire the first call of the next wave.
 *
 * `leadMs` before it, so the call straddles the release rather than landing
 * after it — the slots caught are the ones seen in the first seconds.
 *
 * @param {Set<number>|null} days weekdays the release runs on, null for all
 */
export function nextWaveTime(now, times, leadMs = 0, { everyMin = 0, days = null } = {}) {
  const minutes = waveMinutes(times, everyMin);
  if (minutes.length === 0) return null;

  const second = times[0]?.second ?? 0;

  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(now.getTime());
    day.setDate(day.getDate() + ahead);
    if (days !== null && !days.has(day.getDay())) continue;

    for (const minute of minutes) {
      const at = new Date(day.getTime());
      at.setHours(Math.floor(minute / 60), minute % 60, second, 0);
      const fire = new Date(at.getTime() - leadMs);
      if (fire.getTime() > now.getTime()) return fire;
    }
  }
  return null;
}

/** Milliseconds until the next wave's first call; null when no waves are set. */
export function waveDelayMs(now, times, leadMs = 0, options = {}) {
  const at = nextWaveTime(now, times, leadMs, options);
  return at === null ? null : at.getTime() - now.getTime();
}
