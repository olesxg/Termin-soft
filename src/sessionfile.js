import { readFileSync, writeFileSync } from 'node:fs';

import { serviceIdOf } from './bodies.js';

/**
 * The rotation file, written by an interactive capture and by the watchdog's
 * re-login alike — monitor.js replays whatever is in there without question,
 * so both must produce the same record shape.
 */

const CSRF_HEADER = /csrf|xsrf|verification.?token/i;

export function readSessionsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A replayable session, built from the date request that was just observed. */
export function sessionRecord(options) {
  const {
    index = 1,
    url,
    method = 'POST',
    headers = {},
    cookie,
    userAgent = '',
    body = '',
    referer = '',
    services = [],
    servicesStep = null,
  } = options;

  const csrf = Object.entries(headers).find(([name]) => CSRF_HEADER.test(name));
  const serviceId = serviceIdOf(body);
  const match = serviceId ? services.find((service) => service.id === serviceId) : null;

  return {
    label: `s${index} ${new Date().toLocaleTimeString('sk-SK', { hour12: false }).slice(0, 5)}`,
    capturedAt: new Date().toISOString(),
    cookie,
    url,
    method,
    csrfHeaderName: csrf ? csrf[0] : undefined,
    csrfToken: csrf ? csrf[1] : undefined,
    referer: headers.referer ?? referer,
    userAgent,
    body,
    service: serviceId
      ? { id: serviceId, label: match ? `${match.group ? `${match.group} / ` : ''}${match.name}` : null }
      : null,
    servicesStep,
  };
}

/**
 * Append unless the cookie is already pooled.
 *
 * @returns {{size: number, added: boolean}}
 */
export function appendSessionRecord(file, record) {
  const existing = readSessionsFile(file);
  if (existing.some((entry) => entry?.cookie === record.cookie)) {
    return { size: existing.length, added: false };
  }

  existing.push(record);
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return { size: existing.length, added: true };
}
