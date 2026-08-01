/**
 * Slot detection shared by the API pinger and the browser monitor.
 *
 * The portal is inconsistent: sometimes it answers with a JSON array of dates,
 * sometimes with an object wrapping one, sometimes with a rendered HTML
 * fragment carrying the "no free slots" sentence. So we check, in order:
 *
 *   1. an explicit "no slots" phrase   -> definitely nothing (highest trust)
 *   2. an explicit "slot found" phrase -> definitely something
 *   3. a JSON array of offered dates   -> non-empty means something
 *   4. nothing matched                 -> inconclusive, reported as such
 */

/**
 * The portal's own "no free slots" wording, taken verbatim from its JS bundle
 * (keys noDatesAvailable / noAvailableSlots / missDate / missTime). Used as the
 * default when NO_SLOTS_TEXT is not set.
 */
export const PORTAL_NO_SLOTS_PHRASES = [
  'Nie sú momentálne dostupné žiadne termíny',
  'Vo zvolenom dátume nie je prístupný žiaden voľný termín',
  'Pre zvolené pracovisko nie je k dispozícii žiadna voľná rezervácia',
  'Pre zvolený deň nie je k dispozícii žiadna voľná',
];

/** Lowercase + strip Slovak diacritics, so "Nie sú" matches "nie su". */
export function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function containsAny(haystack, phrases) {
  const normalizedHaystack = normalize(haystack);
  return phrases.find((phrase) => normalizedHaystack.includes(normalize(phrase)));
}

/** Resolve "data.terms" or "result.0.dates" against a parsed body. */
function resolvePath(root, path) {
  return path.split('.').reduce((node, key) => {
    if (node === null || node === undefined) return undefined;
    return node[key];
  }, root);
}

/** First array found while walking the object breadth-first. */
function findFirstArray(root, maxDepth = 4) {
  const queue = [{ node: root, depth: 0, path: '$' }];
  while (queue.length > 0) {
    const { node, depth, path } = queue.shift();
    if (Array.isArray(node)) return { array: node, path };
    if (depth >= maxDepth || node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      queue.push({ node: value, depth: depth + 1, path: `${path}.${key}` });
    }
  }
  return null;
}

/**
 * @param {string} rawBody          response body as text (or page text)
 * @param {object} options
 * @param {string[]} options.noSlotsPhrases
 * @param {string[]} options.slotPhrases
 * @param {string} options.jsonPath  optional explicit path to the dates array
 * @returns {{available: boolean|null, reason: string, sample?: string}}
 *          available === null means "could not tell"
 */
export function detectSlots(rawBody, options = {}) {
  const { noSlotsPhrases = [], slotPhrases = [], jsonPath = '' } = options;
  const text = rawBody ?? '';

  // JSON bodies may carry ú escapes, so search the decoded form too.
  let parsed = null;
  let decoded = text;
  try {
    parsed = JSON.parse(text);
    decoded = `${text}\n${JSON.stringify(parsed)}`;
  } catch {
    // not JSON — fine, it is an HTML fragment or plain text
  }

  const noSlotsHit = containsAny(decoded, noSlotsPhrases);
  if (noSlotsHit) {
    return { available: false, reason: `matched "no slots" phrase: "${noSlotsHit}"` };
  }

  const slotHit = containsAny(decoded, slotPhrases);
  if (slotHit) {
    return { available: true, reason: `matched "slot" phrase: "${slotHit}"` };
  }

  if (parsed !== null && typeof parsed === 'object') {
    let array = null;
    let path = jsonPath;

    if (jsonPath) {
      const resolved = resolvePath(parsed, jsonPath);
      if (Array.isArray(resolved)) array = resolved;
    } else {
      const found = findFirstArray(parsed);
      if (found) {
        array = found.array;
        path = found.path;
      }
    }

    if (array) {
      return array.length > 0
        ? {
            available: true,
            reason: `${array.length} entr${array.length === 1 ? 'y' : 'ies'} at ${path}`,
            sample: JSON.stringify(array.slice(0, 5)),
          }
        : { available: false, reason: `empty array at ${path}` };
    }
  }

  return {
    available: null,
    reason: 'no known marker in the response — adjust NO_SLOTS_TEXT / SLOT_TEXT / SLOT_JSON_PATH',
    sample: text.slice(0, 400),
  };
}
