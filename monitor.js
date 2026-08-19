#!/usr/bin/env node
/**
 * Variant 1 — API pinger.
 *
 * You walk the wizard by hand once (CAPTCHA + SMS), reach the date-picking
 * step, copy the XHR that fetches the dates, and drop its cookies/headers into
 * .env. This script then replays exactly that request on a loop, so the
 * session stays warm and you never touch the CAPTCHA again.
 *
 * See README.md — "Варіант 1" — for how to grab the request.
 */
import axios from 'axios';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { str, num, bool, list, json, required, nextDelay, ts } from './src/config.js';
import { detectSlots, PORTAL_NO_SLOTS_PHRASES } from './src/detect.js';
import { readPortalStatus, backoffDelay } from './src/portal.js';
import { writeStatus } from './src/status.js';
import { raiseSlotAlarm, notifyTelegram } from './src/alert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * pes.minv.sk serves ONLY its leaf certificate — it omits the "CA Disig R2I2"
 * intermediate. Browsers paper over that by fetching the missing cert via the
 * AIA extension; Node does not, so verification fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE even though the certificate is perfectly
 * valid. certs/ca-disig.pem supplies the missing link.
 *
 * This keeps full verification on — it is emphatically not the same thing as
 * rejectUnauthorized:false. CA Disig Root R2 is already in Node's trust store;
 * we are only handing Node the chain the server should have sent.
 */
function trustedCAs() {
  const extra = [];
  for (const file of [path.join(HERE, 'certs', 'ca-disig.pem'), str('EXTRA_CA_FILE')]) {
    if (!file) continue;
    try {
      extra.push(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (file === str('EXTRA_CA_FILE')) throw new Error(`EXTRA_CA_FILE unreadable: ${err.message}`);
    }
  }
  return extra.length > 0 ? [...tls.rootCertificates, ...extra] : undefined;
}

/**
 * A POST payload containing both quote characters cannot be written safely into
 * a .env value, so it can live in its own file instead.
 */
function readBody() {
  const file = str('REQUEST_BODY_FILE');
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return str('REQUEST_BODY');
}

/**
 * The portal killed two sessions after ~5 byte-identical POSTs, while its own
 * wizard never repeats a body. So we rotate: several request bodies, one per
 * poll, cycling. Two birds — it covers more than one service, and if the guard
 * is really a repeated-request check rather than a call counter, varying the
 * payload is what gets past it.
 *
 * REQUEST_BODIES_FILE: one body per line, blank lines and # comments ignored.
 */
function readBodies() {
  const file = str('REQUEST_BODIES_FILE');
  if (file) {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length === 0) throw new Error(`REQUEST_BODIES_FILE ${file} has no bodies in it`);
    return lines;
  }
  const single = readBody();
  return single ? [single] : [''];
}

const config = {
  url: required('TARGET_URL'),
  method: str('METHOD', 'GET').toUpperCase(),
  cookie: required('COOKIE_HEADER'),
  csrfToken: str('CSRF_TOKEN'),
  csrfHeaderName: str('CSRF_HEADER_NAME', 'X-CSRF-TOKEN'),
  bodies: readBodies(),
  contentType: str('CONTENT_TYPE', 'application/json'),
  userAgent: str(
    'USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ),
  accept: str('ACCEPT', 'application/json, text/javascript, */*; q=0.01'),
  acceptLanguage: str('ACCEPT_LANGUAGE', 'sk-SK,sk;q=0.9,en;q=0.8'),
  referer: str('REFERER'),
  origin: str('ORIGIN'),
  extraHeaders: json('EXTRA_HEADERS', {}),

  intervalMs: num('INTERVAL_MS', 60_000),
  jitterMs: num('JITTER_MS', 15_000),
  timeoutMs: num('REQUEST_TIMEOUT_MS', 20_000),

  noSlotsPhrases: list('NO_SLOTS_TEXT', PORTAL_NO_SLOTS_PHRASES),
  slotPhrases: list('SLOT_TEXT', []),
  jsonPath: str('SLOT_JSON_PATH'),

  callLimitPauseMs: num('CALL_LIMIT_PAUSE_MS', 10 * 60_000),
  authFailTolerance: num('AUTH_FAIL_TOLERANCE', 1),
  networkFailTolerance: num('NETWORK_FAIL_TOLERANCE', 5),
  inconclusiveIsSlot: bool('TREAT_INCONCLUSIVE_AS_SLOT', false),
  heartbeatEvery: num('HEARTBEAT_EVERY', 20),
};

if (!['GET', 'POST', 'PUT'].includes(config.method)) {
  throw new Error(`METHOD must be GET, POST or PUT — got "${config.method}"`);
}

function buildHeaders() {
  const headers = {
    Cookie: config.cookie,
    'User-Agent': config.userAgent,
    Accept: config.accept,
    'Accept-Language': config.acceptLanguage,
    'X-Requested-With': 'XMLHttpRequest',
    // A cached 304/200-from-cache would silently hide a new slot.
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  if (config.referer) headers.Referer = config.referer;
  if (config.origin) headers.Origin = config.origin;
  if (config.csrfToken) headers[config.csrfHeaderName] = config.csrfToken;
  if (config.method !== 'GET' && config.bodies.some(Boolean)) headers['Content-Type'] = config.contentType;

  return { ...headers, ...config.extraHeaders };
}

const client = axios.create({
  timeout: config.timeoutMs,
  // Never throw on status: we want to inspect 401/403/302 ourselves.
  validateStatus: () => true,
  // The portal bounces an expired session to the wizard's step 1 via a redirect.
  // Following it would return a happy 200 full of nothing.
  maxRedirects: 0,
  decompress: true,
  transformResponse: [(data) => data], // keep the raw string
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true, ca: trustedCAs() }),
});

let stopBeeping = null;
let running = true;
let pings = 0;
let authFailures = 0;
let networkFailures = 0;
let callLimitHits = 0;
let extraWaitMs = 0;

/** Rotate through the configured bodies, one per poll. */
function currentBody() {
  return config.bodies[(pings - 1) % config.bodies.length];
}

function shutdown(code, message) {
  running = false;
  writeStatus({ stoppedAt: new Date().toISOString(), exitCode: code });
  if (stopBeeping) stopBeeping();
  if (message) console.error(message);
  process.exit(code);
}

async function pingOnce() {
  const response = await client.request({
    url: config.url,
    method: config.method,
    headers: buildHeaders(),
    data: config.method === 'GET' ? undefined : currentBody() || undefined,
  });

  const { status, data } = response;

  if (status === 401 || status === 403) {
    authFailures += 1;
    console.error(
      `[${ts()}] HTTP ${status} — session rejected (${authFailures}/${config.authFailTolerance})`,
    );
    if (authFailures >= config.authFailTolerance) {
      await notifyTelegram(
        `⛔️ Termín monitor stopped: HTTP ${status}. Session expired or the IP got blocked — redo the wizard and refresh COOKIE_HEADER.`,
      );
      shutdown(
        1,
        '\nSession is dead (401/403). Walk the wizard again, re-copy COOKIE_HEADER/CSRF_TOKEN into .env, restart.\n' +
          'A 403 on the very first ping usually means the IP is blocked — turn on a Slovak/Czech VPN.',
      );
    }
    return;
  }

  if (status >= 300 && status < 400) {
    authFailures += 1;
    const location = response.headers?.location ?? '(no Location header)';
    console.error(`[${ts()}] HTTP ${status} -> ${location} — kicked back to the wizard`);
    if (authFailures >= config.authFailTolerance) {
      await notifyTelegram('⛔️ Termín monitor stopped: session redirected back to step 1.');
      shutdown(1, '\nSession expired (redirect). Redo the wizard and refresh .env.\n');
    }
    return;
  }

  if (status >= 500) {
    networkFailures += 1;
    console.error(`[${ts()}] HTTP ${status} — server error (${networkFailures}/${config.networkFailTolerance})`);
    if (networkFailures >= config.networkFailTolerance) {
      shutdown(1, '\nToo many server errors in a row, giving up.\n');
    }
    return;
  }

  if (status !== 200) {
    console.error(`[${ts()}] HTTP ${status} — unexpected, continuing`);
    return;
  }

  // The transport succeeded, but the portal reports its own outcome in the body.
  const portal = readPortalStatus(data);

  if (portal.callLimit) {
    callLimitHits += 1;
    writeStatus({ lastResult: 'call-limit', callLimitHits, lastPingAt: new Date().toISOString(), pings });
    extraWaitMs = Math.max(config.callLimitPauseMs, backoffDelay(config.intervalMs, callLimitHits));
    console.warn(
      `\n[${ts()}] CALL_LIMIT — session is at its call budget. Sitting out ${Math.round(extraWaitMs / 60000)}min rather than spending the call that kills it (hit ${callLimitHits}).`,
    );
    networkFailures = 0;
    return;
  }

  if (portal.authFailed) {
    authFailures += 1;
    writeStatus({ lastResult: 'rejected-' + portal.code, lastPingAt: new Date().toISOString(), pings });
    console.error(
      `\n[${ts()}] portal says code ${portal.code} — session rejected (${authFailures}/${config.authFailTolerance})`,
    );
    if (authFailures >= config.authFailTolerance) {
      await notifyTelegram(
        `⛔️ Termín monitor stopped: portal returned code ${portal.code}. The session is gone — redo the wizard.`,
      );
      shutdown(
        1,
        '\nThe portal rejected the session — it says so in the response body, not the HTTP status.\n' +
          'Run: npm run capture, walk the wizard again, then restart the monitor.\n',
      );
    }
    return;
  }

  // A clean, meaningful answer — everything is healthy again.
  authFailures = 0;
  networkFailures = 0;
  callLimitHits = 0;
  extraWaitMs = 0;

  const result = detectSlots(data, {
    noSlotsPhrases: config.noSlotsPhrases,
    slotPhrases: config.slotPhrases,
    jsonPath: config.jsonPath,
  });

  writeStatus({
    lastPingAt: new Date().toISOString(),
    pings,
    lastResult:
      result.available === true ? 'SLOT' : result.available === false ? 'no-slots' : 'inconclusive',
    lastReason: result.reason,
    callLimitHits,
  });

  if (result.available === true) {
    return result;
  }

  if (result.available === null) {
    console.warn(`[${ts()}] inconclusive — ${result.reason}`);
    if (result.sample) console.warn(`         body: ${result.sample}`);
    if (config.inconclusiveIsSlot) return result;
    return;
  }

  if (pings === 1 || pings % config.heartbeatEvery === 0) {
    console.log(`[${ts()}] ping #${pings} — no slots (${result.reason})`);
  } else {
    process.stdout.write('.');
  }
}

async function loop() {
  console.log('Termín monitor — API mode');
  console.log(`  target   : ${config.method} ${config.url}`);
  console.log(`  interval : ${config.intervalMs / 1000}s (+ up to ${config.jitterMs / 1000}s jitter)`);
  console.log(`  no-slots : ${config.noSlotsPhrases.join(' | ') || '(none configured)'}`);
  console.log('  Ctrl+C to stop. Keep the volume up.\n');

  writeStatus({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    target: config.url,
    intervalMs: config.intervalMs,
    jitterMs: config.jitterMs,
    telegram: Boolean(str('TELEGRAM_BOT_TOKEN') && str('TELEGRAM_CHAT_ID')),
    lastResult: 'starting',
    pings: 0,
    callLimitHits: 0,
    // writeStatus merges, so last run's outcome must be cleared explicitly —
    // otherwise health reports a fresh monitor as stopped.
    stoppedAt: null,
    exitCode: null,
    lastPingAt: null,
    lastReason: null,
    slotFoundAt: null,
    slotDetail: null,
  });

  while (running) {
    pings += 1;
    try {
      const hit = await pingOnce();
      if (hit) {
        stopBeeping = await raiseSlotAlarm([
          `reason: ${hit.reason}`,
          hit.sample ? `data  : ${hit.sample}` : 'open the portal tab and click through NOW',
          `url   : ${config.referer || config.url}`,
        ]);
        writeStatus({ lastResult: 'SLOT', slotFoundAt: new Date().toISOString(), slotDetail: hit.reason });
        console.log('Beeping until you kill me (Ctrl+C). Go book it.');
        return;
      }
    } catch (err) {
      networkFailures += 1;
      console.error(
        `\n[${ts()}] request failed: ${err.code ?? ''} ${err.message} (${networkFailures}/${config.networkFailTolerance})`,
      );
      if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/.test(err.code ?? '')) {
        console.error(
          '         The server sent an incomplete certificate chain. Grab its intermediate CA\n' +
            '         and point EXTRA_CA_FILE at it (certs/ca-disig.pem already covers *.minv.sk).',
        );
      }
      if (networkFailures >= config.networkFailTolerance) {
        await notifyTelegram('⛔️ Termín monitor stopped: network keeps failing.');
        shutdown(1, '\nToo many network failures in a row, giving up.\n');
      }
    }

    if (!running) break;
    const wait = Math.max(extraWaitMs, nextDelay(config.intervalMs, config.jitterMs));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

process.on('SIGINT', () => shutdown(0, '\nStopped.'));

loop().catch((err) => shutdown(1, `\nFatal: ${err.message}`));
