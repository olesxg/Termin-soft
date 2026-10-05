export const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/**
 * Where the four calls should land.
 *
 * With a budget this small the question is not "how often" but "when", and the
 * only honest source for that is where the checks already went and what they
 * found. The most useful answer is usually the dullest one: the hours never
 * looked at, because a slot cannot be found in an hour nobody watched.
 */

/** Checks recorded by the monitor, newest or oldest first — order does not matter. */
export function eventsFromExperiment(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (row?.kind !== 'date') continue;
    const at = new Date(row.at ?? '');
    if (Number.isNaN(at.getTime())) continue;
    out.push({ at, hit: row.outcome === 'SLOT' });
  }
  return out;
}

/**
 * Slots announced in monitor.log, which reaches back further than the
 * experiment log does. The banner carries a full ISO timestamp, so these can
 * be placed on a weekday rather than only on an hour.
 */
export function hitsFromLog(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/detected at (\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/g)) {
    const at = new Date(match[1]);
    if (!Number.isNaN(at.getTime())) out.push({ at, hit: true });
  }
  return out;
}

/** Drop events sharing a weekday, hour and outcome within the same minute. */
export function dedupe(events) {
  const seen = new Set();
  return events.filter(({ at, hit }) => {
    const key = `${at.toISOString().slice(0, 16)}|${hit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const emptyGrid = () => Array.from({ length: 7 }, () => new Array(24).fill(0));

export function tally(events) {
  const checks = emptyGrid();
  const hits = emptyGrid();
  let totalChecks = 0;
  let totalHits = 0;

  for (const { at, hit } of events ?? []) {
    const day = at.getDay();
    const hour = at.getHours();
    checks[day][hour] += 1;
    totalChecks += 1;
    if (hit) {
      hits[day][hour] += 1;
      totalHits += 1;
    }
  }

  return { checks, hits, totalChecks, totalHits };
}

/** Hours of the day with no check on any weekday — the blind spots. */
export function blindHours({ checks }) {
  const blind = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (checks.every((day) => day[hour] === 0)) blind.push(hour);
  }
  return blind;
}

/** Runs of consecutive hours, as [from, to] inclusive, wrapping midnight. */
export function asRanges(hours) {
  if (hours.length === 0) return [];
  const ranges = [];
  let start = hours[0];
  let previous = hours[0];

  for (const hour of hours.slice(1)) {
    if (hour === previous + 1) {
      previous = hour;
      continue;
    }
    ranges.push([start, previous]);
    start = hour;
    previous = hour;
  }
  ranges.push([start, previous]);

  // 23 and 0 are adjacent; a wrap reads as one night, not two stray ends.
  if (ranges.length > 1 && ranges[0][0] === 0 && ranges[ranges.length - 1][1] === 23) {
    const [first] = ranges.splice(0, 1);
    ranges[ranges.length - 1][1] = first[1] + 24;
  }
  return ranges;
}

/** Slots seen, most recent first, with how many checks that slot took. */
export function hotspots({ checks, hits }) {
  const out = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      if (hits[day][hour] > 0) out.push({ day, hour, hits: hits[day][hour], checks: checks[day][hour] });
    }
  }
  return out.sort((a, b) => b.hits - a.hits || b.checks - a.checks);
}

/**
 * What the evidence can and cannot carry.
 *
 * One slot is an anecdote, not a release time, and aiming a whole budget at it
 * would be the same mistake as spreading the budget at random — just more
 * confident. Say which it is.
 */
export function verdict({ totalChecks, totalHits }, spots) {
  if (totalChecks === 0) return { level: 'none', text: 'Жодної перевірки в логах. Запусти монітор, повернись пізніше.' };
  if (totalHits === 0) {
    return {
      level: 'none',
      text: `${totalChecks} перевірок, жодного слота. Цілитись нема за чим — закривай сліпі зони.`,
    };
  }
  if (totalHits < 3) {
    return {
      level: 'weak',
      text:
        `${totalHits} слот(и) на ${totalChecks} перевірок — це анекдот, а не розклад.\n` +
        '  Став одну перевірку туди, решту — у сліпі зони, поки не набереться 3+ влучань.',
    };
  }
  const top = spots[0];
  return {
    level: 'usable',
    text:
      `${totalHits} слотів на ${totalChecks} перевірок. Найчастіше — ${WEEKDAYS[top.day]} о ${String(top.hour).padStart(2, '0')}:00 ` +
      `(${top.hits} з ${top.checks}).\n  Цілься туди, але лиши одну перевірку поза ним.`,
  };
}
