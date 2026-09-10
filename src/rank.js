import { normalize } from './detect.js';
import { isThirdPartyHost } from './hosts.js';

/** Words that suggest "this is the request that lists appointments". */
const INTERESTING = ['termin', 'termín', 'date', 'datum', 'dátum', 'slot', 'availab', 'volny', 'voľn', 'cas', 'čas'];

/** Words that only appear in the POST body of a real reservation/date call. */
const ACTION_WORDS = ['reservation', 'termin', 'date', 'datum', 'day', 'office', 'pracovisko', 'workplace', 'service'];

/**
 * Portlet resource ids that name themselves. On the ECU flow the date lookup is
 * .../res/id=available-offices-service-date/... — when a URL says this plainly,
 * believe it over every heuristic below.
 */
const STRONG_URL_MARKERS = [
  'available-offices-service-date',
  'available-offices',
  'available-dates',
  'free-terms',
  'getfreeterms',
  'freetermin',
];

const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.\s?\d{4}/g;

export function countDates(body) {
  return new Set(body?.match(DATE_RE) ?? []).size;
}

/**
 * On this portal every AJAX call goes to the SAME WebSphere portlet URL and the
 * action lives in the POST body, so the URL barely discriminates. What actually
 * separates the date fetch from everything else is: it answers JSON, its body
 * is full of dates, and its request names the action.
 *
 * Page fragments (jsp=main1) answer HTML that embeds the portal's entire error
 * dictionary — every "voľný termín" string there is. To a naive keyword count
 * they look like the best match in the whole capture, which is exactly the
 * mistake this scoring exists to avoid.
 */
export function scoreRequest(entry, noSlotsPhrases = []) {
  // Google, analytics and the IP-lookup the wizard itself calls are recorded
  // like everything else. None can ever be the endpoint, and one of them has
  // already won this ranking and poisoned the session pool.
  if (isThirdPartyHost(entry.url)) return -1000;

  let score = 0;
  const url = normalize(entry.url ?? '');
  const body = normalize(entry.responseBody ?? '');
  const post = normalize(entry.postData ?? '');
  const contentType = entry.responseContentType ?? '';

  if (entry.resourceType === 'xhr' || entry.resourceType === 'fetch') score += 5;
  if (entry.resourceType === 'document') score -= 6;

  if (contentType.includes('json')) score += 5;
  // A date API answers data, not markup.
  if (contentType.includes('html')) score -= 6;
  // "jsp=main1" and friends just load the next chunk of the wizard's UI.
  if (/(^|&)jsp=/.test(post)) score -= 10;

  for (const word of ACTION_WORDS) {
    if (post.includes(normalize(word))) score += 4;
  }
  for (const word of INTERESTING) {
    if (url.includes(normalize(word))) score += 2;
  }
  for (const marker of STRONG_URL_MARKERS) {
    if (url.includes(normalize(marker))) {
      score += 20; // self-identifying endpoint — outweighs any keyword counting
      break;
    }
  }

  // Cap the body's contribution: a bundled JS file mentions every keyword there
  // is without being an endpoint at all.
  let bodyPoints = 0;
  for (const word of INTERESTING) {
    if (body.includes(normalize(word))) bodyPoints += 1;
  }
  score += Math.min(bodyPoints, 4);

  for (const phrase of noSlotsPhrases) {
    if (body.includes(normalize(phrase))) score += 8; // this endpoint reports slot state
  }

  const dates = countDates(entry.responseBody);
  if (dates >= 3) score += 8;
  else if (dates >= 1) score += 4;

  return score;
}
