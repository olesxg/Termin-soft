/**
 * Shared .env line writer.
 *
 * dotenv strips surrounding quotes but does not unescape them, so a value
 * containing the quote char would leak the backslash. Pick a quote the value
 * does not contain instead of escaping.
 */
export function envQuote(value) {
  const flat = String(value).replace(/[\r\n]+/g, ' ');
  if (!flat.includes("'")) return `'${flat}'`;
  if (!flat.includes('"')) return `"${flat}"`;
  return null; // both quote types present — caller must handle out-of-band
}

export function envLine(key, value) {
  if (value === undefined || value === null || value === '') return `# ${key}=`;
  const quoted = envQuote(value);
  return quoted === null ? `# FIXME both quote types, set by hand: ${key}=${value}` : `${key}=${quoted}`;
}
