/**
 * Hosts that can never be the appointment endpoint.
 *
 * A capture records every XHR the browser makes, and the browser makes plenty
 * that have nothing to do with the portal. One of them once won the ranking: a
 * Google autocomplete response is JSON, is an XHR, and its trending payload
 * carries dates and Slovak words, which is most of what the scorer looks for.
 * That session went into the pool pointing at www.google.com and then ate every
 * third poll — a slot spent on a request that cannot answer about termíny at
 * all, reported only as "inconclusive".
 *
 * Matching an allow-list of minv.sk instead would be tighter, but it would also
 * reject every local fake used in testing, so this names the intruders.
 */
const THIRD_PARTY = [
  'google.com',
  'google-analytics.com',
  'googleapis.com',
  'googletagmanager.com',
  'gstatic.com',
  'doubleclick.net',
  'recaptcha.net',
  'facebook.com',
  'ipify.org',
];

/** True when the URL belongs to a service that is not the portal. */
export function isThirdPartyHost(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false; // not a URL we can judge — leave it to the caller
  }
  return THIRD_PARTY.some((bad) => host === bad || host.endsWith(`.${bad}`));
}
