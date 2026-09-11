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
import { detectSlots, normalize, PORTAL_NO_SLOTS_PHRASES } from './src/detect.js';
import { parseBodiesFile, interleavePrimary } from './src/bodies.js';
import { readPortalStatus, backoffDelay } from './src/portal.js';
import { alignedDelayMs, minuteOffsetOf } from './src/schedule.js';
import { parseSessions, nextSession, retireSession, liveSessions, summarise, mergeSessions, freshSessions, serviceLabelOf } from './src/sessions.js';
import { writeStatus, readStatus } from './src/status.js';
import { mirrorConsoleTo } from './src/logfile.js';
import { raiseSlotAlarm, notifyTelegram } from './src/alert.js';
import { firstOffer, prepareBooking, openSessionBrowser } from './src/booking.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Idle minutes after which a session has been seen to answer 401. Measured on
 * 2026-08-28: first touches at 90, 96 and 103 idle minutes were all rejected;
 * shorter gaps were fine. Used to warn when a pool laps too slowly to survive.
 */
const IDLE_DEATH_MIN = 90;

/**
 * pingOnce returns this when the session failed rather than the portal
 * answering: a dead cookie or a spent budget says nothing about slots, so the
 * scheduled slot must be reused on the next session instead of being lost.
 */
const TRY_NEXT_SESSION = Symbol("try-next-session");

// Do this before anything logs, so the banner lands in the file too.
mirrorConsoleTo(str('LOG_FILE', 'monitor.log'));

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
    let entries = parseBodiesFile(fs.readFileSync(file, 'utf8'));
    if (entries.length === 0) throw new Error(`REQUEST_BODIES_FILE ${file} has no bodies in it`);
    // The first body is the service the wizard was actually on — the one you
    // care about. A flat cycle would check it once per lap; interleaving keeps
    // it at every second poll.
    if (bool('INTERLEAVE_PRIMARY', true)) entries = interleavePrimary(entries);
    return entries;
  }
  const single = readBody();
  return [{ body: single, id: null, label: null }];
}

const config = {
  url: required('TARGET_URL'),
  // With a single service every request would otherwise be byte-identical,
  // which is the pattern that preceded both CALL_LIMIT events. The portal
  // uses the same `_=` cache-buster on its own asset loads.
  cacheBust: bool('CACHE_BUST', true),
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
  // A clean, bookmarkable entry to the booking flow — what goes in the alert,
  // instead of the giant stateful portlet URL you cannot tap on a phone.
  bookUrl: str('BOOK_URL', 'https://portal.minv.sk/wps/portal/domov/ecu/ecu_elektronicke_sluzby/ecu-vysys/'),
  origin: str('ORIGIN'),
  extraHeaders: json('EXTRA_HEADERS', {}),

  intervalMs: num('INTERVAL_MS', 60_000),
  // Measured: a session is cut off after roughly six calls to this endpoint, and
  // neither slower polling, varied payloads, unique URLs nor waiting out
  // CALL_LIMIT restores it. The calls are the scarce resource, not time — so
  // spread them across a window instead of spending them in six minutes.
  callBudget: num('CALL_BUDGET', 6),
  budgetWindowMin: num('BUDGET_WINDOW_MIN', 0),
  jitterMs: num('JITTER_MS', 15_000),
  // The portal answers slowly when it is struggling: third-party fetches of the
  // same page came back at 8.7s and 19.6s while our 20s ceiling was cutting
  // connections off. Well under INTERVAL_MS, so polls still cannot overlap.
  timeoutMs: num('REQUEST_TIMEOUT_MS', 45_000),

  noSlotsPhrases: list('NO_SLOTS_TEXT', PORTAL_NO_SLOTS_PHRASES),
  slotPhrases: list('SLOT_TEXT', []),
  jsonPath: str('SLOT_JSON_PATH'),

  callLimitPauseMs: num('CALL_LIMIT_PAUSE_MS', 10 * 60_000),
  authFailTolerance: num('AUTH_FAIL_TOLERANCE', 1),
  networkAlertAfter: num('NETWORK_ALERT_AFTER', 3),
  // Deliberately lower than CALL_LIMIT_PAUSE_MS: a failed connection costs no
  // call budget, so the only thing a long wait buys is a longer blind spot
  // after the portal comes back.
  networkBackoffCapMs: num('NETWORK_BACKOFF_CAP_MS', 3 * 60_000),
  inconclusiveIsSlot: bool('TREAT_INCONCLUSIVE_AS_SLOT', false),
  heartbeatEvery: num('HEARTBEAT_EVERY', 20),
  beepMaxMs: num('BEEP_MAX_MS', 15 * 60_000),

  // Wall-clock aligned polling. 0 = off, fall back to INTERVAL_MS.
  // These place the calls; they never create more of them.
  alignMinuteMod: num('POLL_ALIGN_MINUTE_MOD', 0),
  alignMinuteOffset: num('POLL_ALIGN_MINUTE_OFFSET', 8),
  alignSecond: num('POLL_ALIGN_SECOND', 58),
  burst: Math.max(1, num('POLL_BURST', 1)),
  burstSpacingMs: num('POLL_BURST_SPACING_MS', 1500),

  // Two phases. SCAN: one call per cycle on the round mark (:00, :10, :20…),
  // cheap and wide, looking for WHEN slots appear. HUNT: once a slot has been
  // seen, re-aim at the offset it appeared on and cover a window around it —
  // a slot spotted at :08 means the next one is worth watching :08 through :11
  // rather than checking once and going blind for ten minutes.
  burstAfterHit: Math.max(1, num('POLL_BURST_AFTER_HIT', 4)),

  sessionsFile: str('SESSIONS_FILE', 'sessions.json'),
  // One is enough: the budget does not recover, so a second CALL_LIMIT on the
  // same session only spends a poll to learn what the first one already said.
  callLimitRetireAfter: num('CALL_LIMIT_RETIRE_AFTER', 1),
};

/**
 * Sessions to rotate over.
 *
 * CALL_LIMIT is counted per session, so N captures give N times the calls —
 * and rotating also keeps each one warm against the 15-30 minute idle death,
 * because every session gets touched once per lap.
 *
 * Falls back to the single session in .env when there is no sessions file, so
 * the old single-capture workflow keeps working unchanged.
 */
/** True once the pool came from a file — only then is pruning it on exit ours to do. */
let usingSessionsFile = false;

function loadSessions() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(config.sessionsFile, 'utf8'));
  } catch {
    // no sessions file — the .env session below is the whole rotation
  }

  if (parsed) {
    const { sessions: fromFile, skipped } = parseSessions(parsed);
    for (const why of skipped) console.warn(`  ignoring session ${why}`);

    // Drop what cannot still be alive BEFORE spending a poll to find out.
    // Pruning only on exit is too late: a pool left over from earlier in the
    // day cost 40 minutes of watching while each corpse was tried in turn.
    const fresh = freshSessions(fromFile, IDLE_DEATH_MIN);
    const stale = fromFile.length - fresh.length;
    if (stale > 0) {
      console.warn(
        `  dropped ${stale} session(s) captured over ${IDLE_DEATH_MIN}min ago — too old to still be valid`,
      );
    }

    // Enforced here, not only at capture time. The body lives on the session, so
    // a pool built before ONLY_SERVICE was set — or topped up from an older
    // file — keeps asking about services you never wanted, and every one of
    // those spends a call from a budget of roughly five per session.
    const only = str('ONLY_SERVICE');
    let usable = fresh;
    if (only) {
      const want = normalize(only);
      const named = fresh.filter((s) => s.service?.label);
      const unnamed = fresh.length - named.length;
      usable = fresh.filter((s) => !s.service?.label || normalize(s.service.label).includes(want));

      const dropped = fresh.length - usable.length;
      if (dropped > 0) {
        console.warn(`  dropped ${dropped} session(s) asking about something other than "${only}"`);
      }
      // Sessions captured before the service was recorded cannot be checked.
      // Dropping them would throw away working sessions, so keep them and say so.
      if (unnamed > 0) {
        console.warn(
          `  ${unnamed} session(s) have no recorded service — kept, but re-capture to be sure they ask about "${only}"`,
        );
      }
    }

    if (usable.length > 0) { usingSessionsFile = true; return usable; }
    console.warn(`${config.sessionsFile} holds no usable session — falling back to .env`);
  }

  // No body here on purpose: the single-session path keeps using the rotation
  // from REQUEST_BODIES_FILE, which is a different axis entirely.
  return parseSessions([
    {
      label: 'env',
      cookie: config.cookie,
      url: config.url,
      csrfToken: config.csrfToken,
      csrfHeaderName: config.csrfHeaderName,
      referer: config.referer,
    },
  ]).sessions;
}

let sessions = loadSessions();
let sessionsFileMtimeMs = 0;

/**
 * Pick up captures taken while the monitor is already running.
 *
 * Topping the pool up used to mean restarting, which throws away the hunt
 * offset and the retired-session bookkeeping mid-evening. Watching the file's
 * mtime costs one stat per poll and lets `npm run capture` be run alongside a
 * live monitor.
 */
function refreshSessionsFromDisk() {
  if (!usingSessionsFile) return;

  let mtimeMs;
  try {
    mtimeMs = fs.statSync(config.sessionsFile).mtimeMs;
  } catch {
    return; // file went away — keep running on what is already loaded
  }
  if (mtimeMs === sessionsFileMtimeMs) return;
  sessionsFileMtimeMs = mtimeMs;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(config.sessionsFile, 'utf8'));
  } catch {
    return; // half-written by a capture in progress — try again next poll
  }

  const { sessions: fromFile } = parseSessions(parsed);
  // Same cutoff as at startup. Without it the refresh re-adopts the corpses the
  // startup filter has just dropped, and each one still costs a poll to bury.
  const { merged, added } = mergeSessions(sessions, freshSessions(fromFile, IDLE_DEATH_MIN));
  if (added.length === 0) return;

  sessions = merged;
  console.log(
    `\n[${ts()}] picked up ${added.length} new session(s) from ${config.sessionsFile}: ` +
      `${added.map((s) => s.label).join(', ')} — ${liveSessions(sessions).length} live now.`,
  );
}

// Stretch a scarce budget over the window you actually care about.
if (config.budgetWindowMin > 0 && config.callBudget > 0) {
  const spaced = Math.round((config.budgetWindowMin * 60_000) / config.callBudget);
  if (spaced > config.intervalMs) config.intervalMs = spaced;
}

if (!['GET', 'POST', 'PUT'].includes(config.method)) {
  throw new Error(`METHOD must be GET, POST or PUT — got "${config.method}"`);
}

function buildHeaders(session) {
  const headers = {
    Cookie: session.cookie,
    'User-Agent': config.userAgent,
    Accept: config.accept,
    'Accept-Language': config.acceptLanguage,
    'X-Requested-With': 'XMLHttpRequest',
    // A cached 304/200-from-cache would silently hide a new slot.
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  // Per-session overrides where a capture supplied them, config otherwise —
  // every session carries its own CSRF token and its own wizard Referer.
  const referer = session.referer ?? config.referer;
  const csrfToken = session.csrfToken ?? config.csrfToken;
  if (referer) headers.Referer = referer;
  if (config.origin) headers.Origin = config.origin;
  if (csrfToken) headers[session.csrfHeaderName ?? config.csrfHeaderName] = csrfToken;
  if (config.method !== 'GET' && config.bodies.some((e) => e.body)) headers['Content-Type'] = config.contentType;

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
let lastSlotFingerprint = null;
let beepDeadline = null;
let burstLeft = 0;
/** Minute offset a slot was last seen on — null while still scanning. */
let huntOffset = null;
let sessionCursor = -1;

/** Rotate through the configured bodies, one per poll. */
/** A unique URL per poll, so no two requests are identical on the wire. */
function requestUrl(session) {
  // Each session carries its own captured endpoint; the cache-buster then makes
  // no two requests identical on the wire.
  const base = session?.url ?? config.url;
  if (!config.cacheBust) return base;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}_=${Date.now()}`;
}

function currentEntry() {
  return config.bodies[(pings - 1) % config.bodies.length];
}

/**
 * Drop spent sessions from the pool file on the way out.
 *
 * Without this the file only grows: the next run spends one poll per corpse
 * discovering it is a corpse. A pool of eight that had expired cost eight of
 * the next run's calls before it could do any real work.
 *
 * Only ever removes sessions the portal itself rejected, and only rewrites a
 * file we actually loaded from.
 */
function pruneSessionsFile() {
  if (!usingSessionsFile) return;
  const live = liveSessions(sessions);
  if (live.length === sessions.length) return;

  const stripped = live.map(({ dead, reason, calls, label, ...rest }) => ({ label, ...rest }));
  try {
    fs.writeFileSync(config.sessionsFile, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8');
    console.log(
      `\n${config.sessionsFile}: dropped ${sessions.length - live.length} spent session(s), ${live.length} left.`,
    );
  } catch (err) {
    console.warn(`  (could not prune ${config.sessionsFile}: ${err.message})`);
  }
}

function shutdown(code, message) {
  running = false;
  writeStatus({ stoppedAt: new Date().toISOString(), exitCode: code });
  clearTimeout(beepDeadline);
  if (stopBeeping) stopBeeping();
  pruneSessionsFile();
  if (message) console.error(message);
  process.exit(code);
}

/**
 * Announce a slot WITHOUT ending the watch.
 *
 * Returning here used to stop the loop, which reads as "job done" but is the
 * opposite: on 2026-08-27 a slot was found at 20:40, was already taken by the
 * time it could be clicked, and the monitor then sat beeping for 26 minutes
 * with three unspent calls in a session that expires anyway. The slot you were
 * shown may be gone; the next one is what you are still here for.
 *
 * The same dates staying on offer must not re-alarm every poll, so a slot is
 * only announced when the payload actually changes.
 */
/** Browser opened on the first hit, kept for the rest of the run. */
let ownBrowser = null;

/**
 * A page to fill the booking in.
 *
 * Prefers the window capture-session already has open (in-process handover).
 * Failing that — the pool workflow closes those so a run of captures does not
 * leave twenty windows behind — open one with this session's cookies. Without
 * this a slot found in pool mode had nowhere to be booked, which is exactly
 * how 30.09.2026 was lost on 2026-09-08.
 */
async function bookingPage(session) {
  if (globalThis.__terminPage) return globalThis.__terminPage;
  if (!bool('PREFILL_BOOKING', true) || !bool('OPEN_BROWSER_ON_SLOT', true)) return null;
  if (ownBrowser) return ownBrowser.page;

  try {
    console.log(`[${ts()}] opening a browser on ${session.label}'s cookies...`);
    const { chromium } = await import('playwright');
    ownBrowser = await openSessionBrowser(chromium, session, str('START_URL', 'https://pes.minv.sk/'), {
      executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
    });
    return ownBrowser.page;
  } catch (err) {
    console.warn(`[${ts()}] could not open a browser: ${err.message} — book by hand.`);
    return null;
  }
}

async function announceSlot(hit, session = null) {
  // Name the service that was actually asked about. The session's own body is
  // what gets sent, so the rotation's label describes nothing — and announcing
  // the wrong one already sent someone to book a slot that, for the service
  // they need, did not exist.
  const service = serviceLabelOf(session, currentEntry().label ?? currentEntry().id) ?? '(unnamed)';
  const fingerprint = `${service}|${hit.sample ?? hit.reason}`;

  writeStatus({
    lastResult: 'SLOT',
    slotFoundAt: new Date().toISOString(),
    slotDetail: hit.reason,
    slotService: service,
  });

  if (fingerprint === lastSlotFingerprint) {
    console.log(`[${ts()}] same slot still listed — still watching, not re-alarming`);
    return;
  }
  lastSlotFingerprint = fingerprint;

  // Never stack beep timers: a second slot while the first is still sounding
  // would otherwise leave an orphaned interval nothing can clear.
  if (stopBeeping) stopBeeping();
  clearTimeout(beepDeadline);

  stopBeeping = await raiseSlotAlarm([
    `service: ${service}`,
    `reason: ${hit.reason}`,
    hit.sample ? `dates : ${hit.sample}` : 'open the portal tab and click through NOW',
    // A clean, tappable link — never the giant session-bound portlet URL, which
    // cannot be opened from a phone.
    `👉 ${config.bookUrl}`,
  ]);

  // An alarm nobody came to is noise, not information — one of these beeped for
  // seven days straight. The banner and the Telegram push stay either way.
  beepDeadline = setTimeout(() => {
    if (stopBeeping) stopBeeping();
    stopBeeping = null;
    console.log(`[${ts()}] alarm silenced after ${Math.round(config.beepMaxMs / 60000)}min — still watching.`);
  }, config.beepMaxMs);

  // Set the page up so the only thing left is the button. Best effort: if any
  // of it fails the banner and the push have already gone out, and those are
  // what actually matter.
  const page = await bookingPage(session);
  if (page && bool('PREFILL_BOOKING', true)) {
    const offer = firstOffer(hit.sample);
    if (!offer) {
      console.warn(`[${ts()}] could not read an office/date out of the answer — book by hand.`);
    } else {
      const shot = path.join(str('SCREENSHOT_DIR', 'screenshots'), `slot-${Date.now()}.png`);
      try {
        fs.mkdirSync(path.dirname(shot), { recursive: true });
      } catch {
        // screenshot is a nicety; carry on without it
      }
      const done = await prepareBooking(page, offer, { screenshotPath: shot });
      if (done.ok) {
        console.log(
          `\n>>> BROWSER IS READY: ${offer.officeName} — ${offer.date}, first free time selected.\n` +
            '>>> Switch to the window and press "Pokračovať". Nothing else to fill in.\n',
        );
        await notifyTelegram(
          `✅ Browser pre-filled: ${offer.officeName}, ${offer.date}. Just press Pokračovať.`,
        );
      } else {
        console.warn(
          `[${ts()}] could not pre-fill the page at step "${done.step}" (${done.detail}) — book by hand.`,
        );
      }
    }
  }

  // Learn the rhythm: from here on, camp on the offset this appeared at.
  const learned = minuteOffsetOf(new Date(), config.alignMinuteMod);
  if (learned !== null && learned !== huntOffset) {
    huntOffset = learned;
    burstLeft = 0; // re-aim from the new offset rather than finishing the old pass
    console.log(
      `[${ts()}] hunting from now on: :${String(huntOffset).padStart(2, '0')} past every ` +
        `${config.alignMinuteMod}min, ${config.burstAfterHit} checks a minute apart.`,
    );
  }

  console.log(`[${ts()}] still polling — that slot may already be gone.`);
}

async function pingOnce(session) {
  session.calls += 1;
  const response = await client.request({
    url: requestUrl(session),
    method: config.method,
    headers: buildHeaders(session),
    data: config.method === 'GET' ? undefined : (session.body ?? currentEntry().body) || undefined,
  });

  const { status, data } = response;

  if (status === 401 || status === 403) {
    retireSession(session, `HTTP ${status}`);
    console.error(
      `[${ts()}] HTTP ${status} — ${session.label} rejected. Still live: ${liveSessions(sessions).length}`,
    );
    if (liveSessions(sessions).length === 0) {
      await notifyTelegram(
        `⛔️ Termín monitor stopped: HTTP ${status}. Every session expired or the IP got blocked — redo the wizard.`,
      );
      shutdown(
        1,
        '\nEvery session is dead (401/403). Walk the wizard again and restart.\n' +
          'A 403 on the very first ping usually means the IP is blocked — turn on a Slovak/Czech VPN.',
      );
    }
    return TRY_NEXT_SESSION;
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
    // A 5xx did reach the server, so unlike a connect failure it may well have
    // cost a call. Back off rather than hammering, but still do not quit.
    extraWaitMs = backoffDelay(config.intervalMs, networkFailures, config.networkBackoffCapMs);
    console.error(
      `[${ts()}] HTTP ${status} — server error (${networkFailures} in a row) — retrying in ${Math.round(extraWaitMs / 1000)}s`,
    );
    return;
  }

  if (status !== 200) {
    console.error(`[${ts()}] HTTP ${status} — unexpected, continuing`);
    return;
  }

  // The transport succeeded, but the portal reports its own outcome in the body.
  const portal = readPortalStatus(data);

  // `{}` — authenticated but the wizard context is gone. Same practical
  // outcome as a 401, and it must be handled before detectSlots, which would
  // otherwise call it "inconclusive" and keep polling a corpse.
  if (portal.expired) {
    retireSession(session, 'expired ({} response)');
    writeStatus({ lastResult: 'expired', lastPingAt: new Date().toISOString(), pings });
    console.error(
      `\n[${ts()}] ${session.label} answered {} — session context expired. Still live: ${liveSessions(sessions).length}`,
    );
    if (liveSessions(sessions).length === 0) {
      await notifyTelegram(
        '⛔️ Termín monitor stopped: every session expired (empty {} answers). Re-capture to carry on.',
      );
      shutdown(
        1,
        '\nEvery session has expired — the portal still accepts the cookie but has dropped the\n' +
          'booking context, so it answers {}. Sessions last about an hour. Run: npm run capture.\n',
      );
    }
    return TRY_NEXT_SESSION;
  }

  if (portal.callLimit) {
    callLimitHits += 1;
    session.callLimits = (session.callLimits ?? 0) + 1;
    writeStatus({ lastResult: 'call-limit', callLimitHits, lastPingAt: new Date().toISOString(), pings });

    // CALL_LIMIT is terminal for the session that hit it: measured, the next
    // call comes back 401 whether it is sent in sixty seconds or ten minutes,
    // and the budget never recovers. So retire it and take the next session —
    // waiting only delays the bad news while a slot could be appearing.
    // Retire it even when it was the last one. The budget never comes back, so
    // sitting out ten minutes on a session that is already dead only delays the
    // bad news — and an empty pool is something to be told NOW, while there is
    // still time to capture another, not after a silent wait ending in 401.
    if (session.callLimits >= config.callLimitRetireAfter) {
      retireSession(session, `CALL_LIMIT x${session.callLimits}`);
      const left = liveSessions(sessions).length;
      console.warn(
        `\n[${ts()}] CALL_LIMIT — ${session.label} is spent, dropping it. Still live: ${left}` +
          (left === 0 ? ' — pool is empty, run: npm run capture' : ''),
      );
      extraWaitMs = 0;
      networkFailures = 0;
      return TRY_NEXT_SESSION;
    }

    // Only reachable when CALL_LIMIT_RETIRE_AFTER was raised above 1, giving
    // this session another chance. Waiting still only makes sense when there is
    // nothing else to ask.
    extraWaitMs =
      liveSessions(sessions).length > 1
        ? 0
        : Math.max(config.callLimitPauseMs, backoffDelay(config.intervalMs, callLimitHits));
    console.warn(
      `\n[${ts()}] CALL_LIMIT on ${session.label}` +
        (extraWaitMs > 0
          ? ` — sitting out ${Math.round(extraWaitMs / 60000)}min rather than spending the call that kills it (hit ${callLimitHits}).`
          : ` — switching to the next session (hit ${session.callLimits} for this one).`),
    );
    networkFailures = 0;
    // Only a real pause means the window is spent; otherwise take the next
    // session now rather than going blind until the next mark.
    return extraWaitMs > 0 ? undefined : TRY_NEXT_SESSION;
  }

  if (portal.authFailed) {
    retireSession(session, `code ${portal.code}`);
    writeStatus({ lastResult: 'rejected-' + portal.code, lastPingAt: new Date().toISOString(), pings });
    console.error(
      `\n[${ts()}] portal says code ${portal.code} — ${session.label} is gone. Still live: ${liveSessions(sessions).length}`,
    );

    // Only the LAST session dying ends the run. Retiring one of several is
    // routine — each carries its own budget and they expire at different times.
    if (liveSessions(sessions).length === 0) {
      await notifyTelegram(
        `⛔️ Termín monitor stopped: portal returned code ${portal.code}. Every session is spent — redo the wizard.`,
      );
      shutdown(
        1,
        '\nEvery session has been rejected — the portal says so in the body, not the HTTP status.\n' +
          'Run: npm run capture, walk the wizard again, then restart the monitor.\n',
      );
    }
    return TRY_NEXT_SESSION;
  }

  // A clean, meaningful answer — everything is healthy again.
  authFailures = 0;
  networkFailures = 0;
  if (readStatus()?.outageAlerted) writeStatus({ outageAlerted: false });
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
    // The session label matters as much as the service: with a pool, "is it
    // actually rotating?" is the question the log has to be able to answer.
    const via = sessions.length > 1 ? ` via ${session.label}` : '';
    console.log(
      `[${ts()}] ping #${pings}${via} [${serviceLabelOf(session, currentEntry().label) ?? '?'}] — no slots (${result.reason})`,
    );
  } else {
    process.stdout.write('.');
  }
}

async function loop() {
  console.log('Termín monitor — API mode');
  console.log(`  target   : ${config.method} ${config.url}`);
  // Report the schedule actually in force. Printing INTERVAL_MS while the
  // aligned scanner drives the loop is worse than printing nothing — the two
  // numbers have nothing to do with each other.
  if (config.alignMinuteMod > 0) {
    const pad = (n) => String(n).padStart(2, '0');
    console.log(
      `  schedule : scan — ${config.burst} check${config.burst === 1 ? '' : 's'} at :${pad(config.alignMinuteOffset)}:${pad(config.alignSecond)} past every ${config.alignMinuteMod}min`,
    );
    console.log(
      `             hunt — after a slot: ${config.burstAfterHit} checks ${config.burstSpacingMs / 1000}s apart, re-aimed at the minute it appeared on`,
    );
    console.log(`             (INTERVAL_MS is unused while this is on)`);
  } else {
    console.log(`  interval : ${config.intervalMs / 1000}s (+ up to ${config.jitterMs / 1000}s jitter)`);
  }
  if (sessions.length > 1) {
    console.log(`  sessions : ${sessions.length} in rotation — roughly ${sessions.length * 5} calls`);

    // A session's turn comes round once per lap, and it dies if the lap is
    // longer than it can idle. Measured 2026-08-28: sessions first touched
    // after 90, 96 and 103 idle minutes all answered 401. A pool of eight on a
    // ten-minute scan laps every 80 minutes, so most of it expired unused.
    const lapMs = sessions.length * (config.alignMinuteMod > 0 ? config.alignMinuteMod * 60_000 : config.intervalMs);
    const lapMin = Math.round(lapMs / 60_000);
    if (lapMin >= IDLE_DEATH_MIN * 0.7) {
      console.warn(
        `\n  !! Each session waits ${lapMin}min for its turn, and sessions have died after ${IDLE_DEATH_MIN}min idle.`,
      );
      console.warn(
        `  !! Most of this pool will expire before it is ever used. Poll faster or capture fewer:`,
      );
      const safeMin = Math.max(1, Math.floor((IDLE_DEATH_MIN * 0.6) / sessions.length));
      console.warn(
        config.alignMinuteMod > 0
          ? `  !!   POLL_ALIGN_MINUTE_MOD=${safeMin}   (lap ${safeMin * sessions.length}min)\n`
          : `  !!   INTERVAL_MS=${safeMin * 60_000}   (lap ${safeMin * sessions.length}min)\n`,
      );
    }
  }
  console.log(`  no-slots : ${config.noSlotsPhrases.join(' | ') || '(none configured)'}`);
  if (config.budgetWindowMin > 0) {
    console.log(`  budget   : ~${config.callBudget} calls spread over ${config.budgetWindowMin} min`);
  }
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
      // One scheduled mark = one ANSWER about slots, not one HTTP request. A
      // dead cookie or a spent budget tells us nothing about availability, so
      // burning the mark on it would go blind until the next one — ten minutes
      // in which a slot can appear and be taken. Keep taking sessions until one
      // actually answers, or the pool runs out.
      refreshSessionsFromDisk();

      let hit = null;
      // Which session actually answered. `turn` dies with the loop, and the
      // alert needs it: it is the session's body that decides which service the
      // answer is about.
      let answeredBy = null;
      for (let attempt = 0; attempt < sessions.length && running; attempt += 1) {
        const turn = nextSession(sessions, sessionCursor);
        if (!turn) {
          await notifyTelegram('⛔️ Termín monitor stopped: every captured session is spent.');
          shutdown(1, '\nEvery session is spent. Run: npm run capture.\n');
          break;
        }
        sessionCursor = turn.cursor;

        const outcome = await pingOnce(turn.session);
        if (outcome !== TRY_NEXT_SESSION) {
          hit = outcome ?? null;
          answeredBy = turn.session;
          break;
        }
        if (attempt === 0 && liveSessions(sessions).length > 0) {
          console.log(`[${ts()}] retrying this window on the next session — no answer lost.`);
        }
      }

      if (hit) await announceSlot(hit, answeredBy);
    } catch (err) {
      // A connection that never reached the server costs no call budget, so
      // giving up would only lose slots — the session is still intact. Back off
      // and keep trying; portal.minv.sk has gone unreachable while its
      // neighbour pes.minv.sk stayed up, so outages here are a real thing.
      networkFailures += 1;
      extraWaitMs = backoffDelay(config.intervalMs, networkFailures, config.networkBackoffCapMs);
      console.error(
        `\n[${ts()}] request failed: ${err.code ?? ''} ${err.message} (${networkFailures} in a row) — retrying in ${Math.round(extraWaitMs / 1000)}s`,
      );
      writeStatus({
        lastResult: 'unreachable',
        lastReason: `${err.code ?? err.name}: ${err.message}`,
        networkFailures,
        lastPingAt: new Date().toISOString(),
        pings,
      });
      // Persisted, so restarting mid-outage does not re-announce it. Cleared
      // on the next clean answer, so a later outage still gets its own alert.
      if (networkFailures >= config.networkAlertAfter && !readStatus()?.outageAlerted) {
        writeStatus({ outageAlerted: true });
        await notifyTelegram(
          `⚠️ Termin monitor: portal unreachable for ${networkFailures} tries (${err.code ?? err.name}). Still retrying — the session is not spent.`,
        );
      }
    }

    if (!running) break;
    // Backoff always wins: after CALL_LIMIT the point is to stop asking, and
    // an alignment mark inside the penalty window would spend the call anyway.
    let wait;
    if (extraWaitMs > 0) {
      wait = Math.max(extraWaitMs, nextDelay(config.intervalMs, config.jitterMs));
      burstLeft = 0;
    } else if (burstLeft > 0) {
      burstLeft -= 1;
      wait = config.burstSpacingMs;
    } else {
      // Hunting aims at the offset a slot was actually seen on and sweeps a
      // window there; scanning takes one shot per cycle on the configured mark.
      const hunting = huntOffset !== null;
      const aligned = alignedDelayMs(new Date(), {
        minuteMod: config.alignMinuteMod,
        minuteOffset: hunting ? huntOffset : config.alignMinuteOffset,
        second: config.alignSecond,
      });
      if (aligned === null) {
        wait = nextDelay(config.intervalMs, config.jitterMs);
      } else {
        burstLeft = (hunting ? config.burstAfterHit : config.burst) - 1;
        wait = aligned;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

process.on('SIGINT', () => shutdown(0, '\nStopped.'));

loop().catch((err) => shutdown(1, `\nFatal: ${err.message}`));
