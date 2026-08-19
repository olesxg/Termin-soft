import { readFileSync } from 'node:fs';

/**
 * Minimal .env reader — deliberately not a regex.
 *
 * Building one inside a template literal is a trap: `\s` in a template literal
 * collapses to a bare "s", so the pattern silently stops matching and the
 * caller just gets empty values back. Splitting lines has no such edge.
 */
export function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes.
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values may carry a trailing comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (value !== '') values[key] = value;
  }
  return values;
}

/** First non-empty value for each key, searching the files in order. */
export function readEnvValues(files, keys) {
  const found = {};
  for (const file of files) {
    let parsed;
    try {
      parsed = parseEnvText(readFileSync(file, 'utf8'));
    } catch {
      continue; // missing file is normal
    }
    for (const key of keys) {
      if (found[key] === undefined && parsed[key] !== undefined) found[key] = parsed[key];
    }
  }
  return found;
}
