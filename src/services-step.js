import { extractServices, bodyForService, matchServices, serviceIdOf } from './bodies.js';
import { isThirdPartyHost } from './hosts.js';

/**
 * Hypothesis 1, DISPROVEN 2026-10-05: the date endpoint's call counter does NOT
 * live in the context the services step creates.
 *
 * The replay works — it hands out a genuinely new serviceBranchID, so the
 * server really does build a fresh context — and the counter ignores it. Three
 * sessions, four answers each, with and without. The counter is per session.
 *
 * Kept so the measurement can be repeated if the portal changes, and so the
 * next person reads a result instead of re-deriving the guess.
 */

/**
 * The newest recorded request whose answer listed the services.
 *
 * Matched on the answer, not the URL: every step POSTs to the same portlet
 * address, and the date endpoint answers under the same `services` key but
 * without a `serviceList`.
 */
export function findServicesStep(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry?.url || !entry.postData) continue;
    if (isThirdPartyHost(entry.url)) continue;
    if (extractServices(entry.responseBody).length === 0) continue;

    const headers = entry.requestHeaders ?? {};
    return {
      url: entry.url,
      method: entry.method ?? 'POST',
      body: entry.postData,
      contentType: headers['content-type'] ?? '',
      referer: headers.referer ?? '',
    };
  }
  return null;
}

/** Matched by name, because ids are reissued on every pass; the previous id is only a fallback. */
export function pickService(services, needle, previousId = null) {
  const matched = needle ? matchServices(services, needle) : [];
  if (matched.length > 0) return matched[0];
  if (previousId) return services.find((service) => service.id === previousId) ?? null;
  return null;
}

/** Service group and name as the log and the alert should print it. */
export function serviceLabel(service) {
  if (!service) return null;
  return `${service.group ? `${service.group} / ` : ''}${service.name ?? ''}`.trim() || service.id;
}

/**
 * A date body re-pointed at the ids the services step just handed out.
 *
 * @returns {{body: string, service: object}|null} null when nothing watched was
 *   on offer — the caller keeps its current body rather than polling a guess.
 */
export function refreshedBody(templateBody, servicesResponse, needle) {
  const services = extractServices(servicesResponse);
  if (services.length === 0) return null;

  const chosen = pickService(services, needle, serviceIdOf(templateBody));
  if (!chosen) return null;

  const body = bodyForService(templateBody, chosen.id);
  return body ? { body, service: chosen } : null;
}

/** True once this session has spent `every` date calls since its last refresh. */
export function dueForRefresh(session, every) {
  if (!Number.isFinite(every) || every <= 0) return false;
  return (session?.callsSinceRefresh ?? 0) >= every;
}
