const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTES_PER_DAY = 24 * 60;

/**
 * When a human is reachable to tap a CAPTCHA.
 *
 * The watchdog used to ask the moment the pool died, which can be three in the
 * morning. One CAPTCHA buys an hour of watching, so it is worth spending only
 * when someone is awake to spend it — and the hour it buys should be an hour
 * worth watching.
 *
 * "mon-fri 18:00-22:00, sat 09:00-12:00, 07:00-08:00"
 */

function parseDays(text) {
  if (!text) return null; // every day
  const days = new Set();

  for (const part of text.split('+')) {
    const range = part.trim().toLowerCase().split('-');
    const from = DAYS.indexOf(range[0]);
    if (from === -1) return undefined;

    if (range.length === 1) {
      days.add(from);
      continue;
    }
    const to = DAYS.indexOf(range[1]);
    if (to === -1) return undefined;

    for (let i = 0; i < 7; i += 1) {
      const day = (from + i) % 7;
      days.add(day);
      if (day === to) break;
    }
  }
  return days;
}

function parseClock(text) {
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * @returns {{windows: object[], bad: string[]}} a window that cannot be read is
 *   named rather than dropped: a typo that silently removes a window is how the
 *   watchdog goes quiet on the one evening it was meant to cover.
 */
export function parseWindows(text) {
  const windows = [];
  const bad = [];

  for (const raw of String(text ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    const match = entry.match(/^(?:([a-z+\- ]+?)\s+)?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/i);
    if (!match) {
      bad.push(entry);
      continue;
    }

    const days = parseDays(match[1]);
    const start = parseClock(match[2]);
    const end = parseClock(match[3]);
    if (days === undefined || start === null || end === null || start === end) {
      bad.push(entry);
      continue;
    }

    windows.push({ days, start, end, label: entry });
  }

  return { windows, bad };
}

/** Minutes since midnight. */
const clockOf = (date) => date.getHours() * 60 + date.getMinutes();

export function inWindow(date, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true; // unconfigured = always
  const now = clockOf(date);
  const today = date.getDay();
  const yesterday = (today + 6) % 7;

  return windows.some(({ days, start, end }) => {
    // A window ending before it starts runs past midnight into the next day.
    if (start < end) return (days === null || days.has(today)) && now >= start && now < end;
    const late = (days === null || days.has(today)) && now >= start;
    const early = (days === null || days.has(yesterday)) && now < end;
    return late || early;
  });
}

/** When the next window opens, or null when none is configured. */
export function nextWindowStart(date, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null;

  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(date.getTime());
    day.setDate(day.getDate() + ahead);
    day.setHours(0, 0, 0, 0);

    const candidates = windows
      .filter(({ days }) => days === null || days.has(day.getDay()))
      .map(({ start }) => new Date(day.getTime() + start * 60_000))
      .filter((at) => at.getTime() > date.getTime())
      .sort((a, b) => a - b);

    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

/** Minutes a set of windows covers in a week — what the schedule actually buys. */
export function weeklyMinutes(windows) {
  if (!Array.isArray(windows)) return 0;
  return windows.reduce((total, { days, start, end }) => {
    const span = start < end ? end - start : MINUTES_PER_DAY - start + end;
    return total + span * (days === null ? 7 : days.size);
  }, 0);
}
