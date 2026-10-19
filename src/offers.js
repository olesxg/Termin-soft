const WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/**
 * A slot alert is read in seconds, on a phone, by someone who then has to race
 * for it. The raw answer is a wall of JSON with branchPublicId in it; the three
 * things that decide whether to run are the city, the date and how soon.
 */

/** "20.10.2026" -> Date, or null. */
export function parseSlovakDate(text) {
  const match = String(text ?? '').match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/);
  if (!match) return null;

  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return date;
}

/** Every office/date pair the portal offered, flattened. */
export function parseOffers(sample, now = new Date()) {
  let parsed;
  try {
    parsed = typeof sample === 'string' ? JSON.parse(sample) : sample;
  } catch {
    return [];
  }

  const offices = Array.isArray(parsed) ? parsed : parsed?.services;
  if (!Array.isArray(offices)) return [];

  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];

  for (const office of offices) {
    for (const raw of office?.dates ?? []) {
      const date = parseSlovakDate(raw);
      out.push({
        city: office?.officeCity ?? '',
        officeName: office?.officeName ?? '',
        branchPublicId: office?.branchPublicId ?? '',
        date: raw,
        weekday: date ? WEEKDAYS[date.getUTCDay()] : '',
        daysAway: date ? Math.round((date.getTime() - midnight) / 86_400_000) : null,
      });
    }
  }

  return out;
}

/** Preferred city first, then soonest. */
export function rankOffers(offers, prefer = '') {
  const want = String(prefer ?? '').trim().toLowerCase();
  const matches = (offer) =>
    want !== '' && `${offer.city} ${offer.officeName}`.toLowerCase().includes(want);

  return [...offers].sort((a, b) => {
    if (matches(a) !== matches(b)) return matches(a) ? -1 : 1;
    return (a.daysAway ?? Infinity) - (b.daysAway ?? Infinity);
  });
}

function line(offer, starred) {
  const when = offer.daysAway === null ? '' : offer.daysAway <= 0 ? ' — СЬОГОДНІ' : ` — через ${offer.daysAway} дн.`;
  const day = offer.weekday ? ` (${offer.weekday})` : '';
  const where = offer.city || offer.officeName || '?';
  return `${starred ? '★ ' : '  '}${where.toUpperCase()} — ${offer.date}${day}${when}`;
}

/**
 * Alert body: where, when, how soon, preferred city starred and first.
 *
 * @returns {string[]} empty when the answer could not be read, so the caller
 *   falls back to the raw payload rather than announcing a slot with no detail.
 */
export function formatOffers(sample, { prefer = '', now = new Date(), max = 6 } = {}) {
  const offers = parseOffers(sample, now);
  if (offers.length === 0) return [];

  const ranked = rankOffers(offers, prefer);
  const want = String(prefer ?? '').trim().toLowerCase();
  const starred = (offer) => want !== '' && `${offer.city} ${offer.officeName}`.toLowerCase().includes(want);

  const lines = ranked.slice(0, max).map((offer) => line(offer, starred(offer)));
  if (ranked.length > max) lines.push(`  …ще ${ranked.length - max}`);

  if (want !== '' && !ranked.some(starred)) lines.push(`  (${prefer} — немає)`);

  return lines;
}

/**
 * A slot at the far end of the booking horizon is a whole day that has just
 * opened — every time from the morning to midday, the batch worth dropping
 * everything for. A nearer one is a single time someone gave back.
 *
 * Measured: every alert of 2026-09-28, 10-05 and 10-12 was exactly 22 days out
 * and each was a full day; the one that was not, 2026-09-14 for the 15th, was
 * a lone cancellation.
 */
export function isNewDay(offer, horizonDays = 19) {
  return offer?.daysAway !== null && offer?.daysAway !== undefined && offer.daysAway >= horizonDays;
}

/** First line of the alert: whether this is the batch or a leftover. */
export function alertHeadline(sample, { now = new Date(), horizonDays = 19 } = {}) {
  const offers = parseOffers(sample, now);
  if (offers.length === 0) return null;
  return offers.some((offer) => isNewDay(offer, horizonDays))
    ? '🆕 ВІДКРИВСЯ НОВИЙ ДЕНЬ — уся сітка вільна. Бронюй ЗАРАЗ, живе 10-40 хв.'
    : '↩ Звільнився окремий час (хтось скасував). Може зникнути за хвилини.';
}
