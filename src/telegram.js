/**
 * Read the SMS code back from the bot chat, so the phone does not need a remote
 * desktop to reach the wizard on the PC.
 *
 * Only this chat, and only messages sent after it started asking: a code left
 * in the history is expired, and reusing one costs a CAPTCHA to find out.
 */

const DEFAULT_PATTERN = /\b(\d{4,8})\b/;
const API = 'https://api.telegram.org';

/** The digits inside a chat message, or null if there are none. */
export function extractCode(text, pattern = DEFAULT_PATTERN) {
  const match = String(text ?? '').match(pattern);
  if (!match) return null;
  return match[1] ?? match[0];
}

/** Codes from this chat only, newest last, with the update id to resume from. */
export function codesFromUpdates(payload, chatId, pattern = DEFAULT_PATTERN) {
  const updates = Array.isArray(payload?.result) ? payload.result : [];
  let lastId = null;
  const codes = [];

  for (const update of updates) {
    if (typeof update?.update_id === 'number') lastId = update.update_id;
    const message = update?.message ?? update?.edited_message;
    if (!message) continue;
    if (String(message.chat?.id ?? '') !== String(chatId)) continue;

    const code = extractCode(message.text, pattern);
    if (code) codes.push(code);
  }

  return { codes, lastId };
}

async function callApi(fetchImpl, token, method, params, timeoutMs) {
  const query = new URLSearchParams(params).toString();
  const response = await fetchImpl(`${API}/bot${token}/${method}?${query}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * @returns {Promise<string|null>} null on timeout — the caller falls back to a
 *   human typing it at the machine, which must always stay possible.
 */
export async function awaitCode(options = {}) {
  const {
    token = '',
    chatId = '',
    timeoutMs = 10 * 60_000,
    pollSeconds = 25,
    pattern = DEFAULT_PATTERN,
    fetchImpl = fetch,
    log = () => {},
  } = options;

  if (!token || !chatId) return null;

  const deadline = Date.now() + timeoutMs;
  let offset = null;

  try {
    const seen = await callApi(fetchImpl, token, 'getUpdates', { offset: -1, timeout: 0 }, 15_000);
    const { lastId } = codesFromUpdates(seen, chatId, pattern);
    if (lastId !== null) offset = lastId + 1;
  } catch (err) {
    log(`could not read the chat (${err.message}) — type the code at the machine`);
    return null;
  }

  while (Date.now() < deadline) {
    const params = { timeout: pollSeconds, allowed_updates: '["message"]' };
    if (offset !== null) params.offset = offset;

    let payload;
    try {
      payload = await callApi(fetchImpl, token, 'getUpdates', params, (pollSeconds + 15) * 1000);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    const { codes, lastId } = codesFromUpdates(payload, chatId, pattern);
    if (lastId !== null) offset = lastId + 1;
    if (codes.length > 0) return codes[codes.length - 1];
  }

  return null;
}
