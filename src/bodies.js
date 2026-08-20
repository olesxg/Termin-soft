/**
 * The wizard's services response carries every serviceBranchID the account may
 * pick. The date endpoint takes one of them per call, so those ids are exactly
 * the material for a rotation set: same endpoint, legitimately different
 * payloads, and broader coverage than watching a single service.
 */

/** Every {id, name, group} in a captured services tree. */
export function extractServices(responseBody) {
  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return [];
  }
  const out = [];
  for (const group of parsed?.services ?? []) {
    for (const service of group?.serviceList ?? []) {
      if (service?.id) out.push({ id: service.id, name: service.name ?? '', group: group.name ?? '' });
    }
  }
  return out;
}

/**
 * Rewrite the captured body's serviceBranchID, keeping everything else byte for
 * byte — the payload is form-encoded JSON and re-serialising it risks changing
 * key order or escaping in ways the portal may not expect.
 */
export function bodyForService(templateBody, serviceId) {
  const encoded = encodeURIComponent(`"serviceBranchID":"`);
  const idx = templateBody.indexOf(encoded);
  if (idx !== -1) {
    const start = idx + encoded.length;
    const end = templateBody.indexOf('%22', start);
    if (end !== -1) return templateBody.slice(0, start) + serviceId + templateBody.slice(end);
  }
  const plain = '"serviceBranchID":"';
  const j = templateBody.indexOf(plain);
  if (j !== -1) {
    const start = j + plain.length;
    const end = templateBody.indexOf('"', start);
    if (end !== -1) return templateBody.slice(0, start) + serviceId + templateBody.slice(end);
  }
  return null; // not a service-scoped body — caller falls back to the single body
}

/** Rotation set: the captured body first, then one per other service. */
export function buildRotation(templateBody, services) {
  const bodies = [templateBody];
  const seen = new Set([templateBody]);
  for (const service of services) {
    const body = bodyForService(templateBody, service.id);
    if (body && !seen.has(body)) {
      seen.add(body);
      bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Parse a rotation file back into labelled bodies.
 *
 * The file carries "# <id>  <group> / <name>" comments alongside the payloads.
 * An alert that only says "2 entries at services" is not actionable — the dates
 * may belong to a service you are not applying for, which is exactly how one
 * alert sent someone to the portal to book something that was never free.
 * Match label to body by serviceBranchID rather than by position.
 */
export function parseBodiesFile(text) {
  const labels = new Map();
  const bodies = [];

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = line.match(/^#\s*([0-9a-f-]{16,})\s+(.*)$/i);
      if (m) labels.set(m[1], m[2].trim());
      continue;
    }
    bodies.push(line);
  }

  return bodies.map((body) => {
    const m = decodeURIComponent(body).match(/"serviceBranchID"\s*:\s*"([^"]+)"/);
    const id = m ? m[1] : null;
    return { body, id, label: (id && labels.get(id)) || null };
  });
}

/**
 * Interleave the primary body with the rest: primary, A, primary, B, ...
 *
 * A flat cycle checks the service you actually need only once per full lap —
 * nine minutes at a one-minute cadence, which is a long time for a slot that
 * others are also racing for. This keeps it at every second poll while still
 * covering the others.
 */
export function interleavePrimary(entries) {
  if (entries.length < 2) return entries;
  const [primary, ...rest] = entries;
  const out = [];
  for (const entry of rest) {
    out.push(primary, entry);
  }
  return out;
}
