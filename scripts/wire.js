#!/usr/bin/env node
/**
 * Rebuild .env.captured from captured/requests.jsonl alone.
 *
 * capture-session writes that log incrementally, so it survives even when the
 * browser is closed mid-run and the interactive dump never happens. Everything
 * needed is in the recorded request headers — cookies, CSRF token, user agent —
 * which means a crashed capture does not have to cost another SMS.
 *
 *   npm run wire
 */
import fs from 'node:fs';
import path from 'node:path';

import { scoreRequest, countDates } from '../src/rank.js';
import { PORTAL_NO_SLOTS_PHRASES } from '../src/detect.js';
import { extractServices, buildRotation } from '../src/bodies.js';
import { readEnvValues } from '../src/envfile.js';

const LOG = process.argv[2] ?? path.join('captured', 'requests.jsonl');

let rows;
try {
  rows = fs
    .readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (err) {
  console.error(`Cannot read ${LOG}: ${err.message}`);
  console.error('Run `npm run capture` first.');
  process.exit(1);
}

const ranked = rows
  .map((entry) => ({ entry, score: scoreRequest(entry, PORTAL_NO_SLOTS_PHRASES) }))
  .sort((a, b) => b.score - a.score);

const best = ranked[0]?.entry;
if (!best) {
  console.error('Nothing usable in the log.');
  process.exit(1);
}

const headers = best.requestHeaders ?? {};
const cookie = headers.cookie ?? '';
if (!cookie) {
  console.error('The winning request carries no Cookie header — the session cannot be replayed.');
  process.exit(1);
}

const csrfEntry = Object.entries(headers).find(([name]) => /csrf|xsrf|verification.?token/i.test(name));

const quote = (value) => {
  const flat = String(value).replace(/[\r\n]+/g, ' ');
  if (!flat.includes("'")) return `'${flat}'`;
  if (!flat.includes('"')) return `"${flat}"`;
  return null;
};
const line = (key, value) => {
  if (value === undefined || value === null || value === '') return `# ${key}=`;
  const q = quote(value);
  return q === null ? `# FIXME quote by hand\n# ${key}=${value}` : `${key}=${q}`;
};

// Rotation across every service the wizard listed.
const body = best.postData ?? '';
const services = rows.flatMap((r) => extractServices(r.responseBody));
let rotationLine = '# REQUEST_BODIES_FILE=';
if (body && services.length > 0) {
  const rotation = buildRotation(body, services);
  if (rotation.length > 1) {
    const outDir = path.dirname(LOG);
    const rotPath = path.join(outDir, 'request-bodies.txt');
    const header = services.map((s) => `# ${s.id}  ${s.group ? `${s.group} / ` : ''}${s.name}`).join('\n');
    fs.writeFileSync(rotPath, `${header}\n${rotation.join('\n')}\n`, 'utf8');
    rotationLine = line('REQUEST_BODIES_FILE', rotPath);
    console.log(`Rotation set: ${rotation.length} bodies -> ${rotPath}`);
  }
}

const carried = readEnvValues(['.env', '.env.captured'], ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

const out = [
  '# Rebuilt by scripts/wire.js from the capture log',
  `# written at ${new Date().toISOString()}`,
  '',
  line('TARGET_URL', best.url),
  line('METHOD', best.method),
  line('COOKIE_HEADER', cookie),
  line('CSRF_HEADER_NAME', csrfEntry ? csrfEntry[0] : 'X-CSRF-TOKEN'),
  line('CSRF_TOKEN', csrfEntry ? csrfEntry[1] : ''),
  line('REQUEST_BODY', body),
  rotationLine,
  line('CONTENT_TYPE', headers['content-type'] ?? 'application/x-www-form-urlencoded; charset=UTF-8'),
  line('REFERER', headers.referer ?? best.pageUrl ?? ''),
  line('ORIGIN', headers.origin ?? new URL(best.url).origin),
  line('USER_AGENT', headers['user-agent'] ?? ''),
  '',
  '# The portal de-authenticates a session that overruns its call budget.',
  line('INTERVAL_MS', '90000'),
  line('JITTER_MS', '20000'),
  line('NO_SLOTS_TEXT', PORTAL_NO_SLOTS_PHRASES.join(',')),
  /available-offices-service-date/.test(best.url) ? line('SLOT_JSON_PATH', 'services') : '# SLOT_JSON_PATH=',
  '',
  carried.TELEGRAM_BOT_TOKEN ? line('TELEGRAM_BOT_TOKEN', carried.TELEGRAM_BOT_TOKEN) : '# TELEGRAM_BOT_TOKEN=',
  carried.TELEGRAM_CHAT_ID ? line('TELEGRAM_CHAT_ID', carried.TELEGRAM_CHAT_ID) : '# TELEGRAM_CHAT_ID=',
  '',
].join('\n');

fs.writeFileSync('.env.captured', out, 'utf8');

const resourceId = (best.url.match(/res\/id=([^/]+)/) ?? [])[1] ?? '(none)';
console.log(`\nPicked: score ${ranked[0].score}  ${best.method}  res-id=${resourceId}`);
console.log(`  dates in response : ${countDates(best.responseBody)}`);
console.log(`  cookies           : ${cookie.split(';').map((c) => c.trim().split('=')[0]).join(', ')}`);
console.log(`  csrf header       : ${csrfEntry ? csrfEntry[0] : '(none)'}`);
console.log(`  telegram carried  : ${carried.TELEGRAM_CHAT_ID ? 'yes' : 'NO — set it before running'}`);
console.log('\nWrote .env.captured.  Next: cp .env.captured .env && npm run monitor');
