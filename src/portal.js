/**
 * The portal answers HTTP 200 and puts the real outcome in the JSON body:
 *
 *   {"code":"401"}                                  -> session no longer valid
 *   {"code":"500","message":"CALL_LIMIT"}           -> polled too fast, back off
 *   {"services":[...]}                              -> actual payload
 *
 * Reading only the HTTP status makes an expired session look like a normal
 * empty answer, which is the worst possible failure mode here: the monitor
 * would sit there politely reporting "no slots" forever.
 */

const AUTH_CODES = new Set(['401', '403']);

/**
 * @returns {{authFailed: boolean, callLimit: boolean, code: string|null, message: string}}
 */
export function readPortalStatus(rawBody) {
  const empty = { authFailed: false, callLimit: false, code: null, message: '' };
  if (!rawBody) return empty;

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return empty; // HTML or plain text — nothing structured to read
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  const code = parsed.code === undefined || parsed.code === null ? null : String(parsed.code).trim();
  const message = parsed.message === undefined || parsed.message === null ? '' : String(parsed.message);

  return {
    code,
    message,
    authFailed: code !== null && AUTH_CODES.has(code),
    // CALL_LIMIT arrives as code 500, but match on the message so a future
    // change of code does not silently turn throttling into a hard error.
    callLimit: /call[_\s-]?limit/i.test(message),
  };
}

/**
 * Exponential backoff for throttling: 1x, 2x, 4x... of the normal interval,
 * capped so the monitor never goes properly to sleep.
 */
export function backoffDelay(baseMs, consecutiveHits, capMs = 10 * 60_000) {
  const factor = 2 ** Math.max(0, consecutiveHits - 1);
  return Math.min(baseMs * factor, capMs);
}
