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
import { parseSessions, nextSession, retireSession, liveSessions, summarise, mergeSessions, freshSessions, serviceLabelOf, sessionAgeMin } from './src/sessions.js';
import { writeStatus, readStatus } from './src/status.js';
import { mirrorConsoleTo } from './src/logfile.js';
import { raiseSlotAlarm, notifyTelegram } from './src/alert.js';
import { firstOffer, prepareBooking, openSessionBrowser } from './src/booking.js';
import { formatOffers } from './src/offers.js';
import { parseWindows, inWindow, nextWindowStart, weeklyMinutes } from './src/windows.js';
import { readIdentity, fillIdentity, enterWizard, IDENTITY_FIELDS } from './src/identity.js';
import { dueForRefresh, refreshedBody, serviceLabel } from './src/services-step.js';
import { record, withTabId, nextTabId, markTabId } from './src/experiment.js';
import { appendSessionRecord, readSessionsFile } from './src/sessionfile.js';
import { relogin } from './src/relogin.js';
import { awaitCode } from './src/telegram.js';

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
  // Measured 2026-10-05 across three sessions: FOUR answers, then the fifth
  // call returns CALL_LIMIT. Identical whether or not the wizard context was
  // rebuilt in between. Neither slower polling, varied payloads, unique URLs
  // nor waiting it out restores the budget — the calls are the scarce
  // resource, not time, so spread them over the window you actually care about.
  callBudget: num('CALL_BUDGET', 4),
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

  onlyService: str('ONLY_SERVICE'),
  office: str('OFFICE'),
  // Starred and listed first in the alert. Never filters: a slot anywhere beats
  // no slot, and the alarm must not stay silent because it was in the wrong town.
  preferOffice: str('PREFER_OFFICE', str('OFFICE')),
  dateMarker: str('DATE_ENDPOINT_MARKER', 'available-offices-service-date'),

  // Hypothesis 1 — DISPROVEN 2026-10-05, kept so the measurement can be redone
  // rather than re-guessed. Replaying the services step hands out a genuinely
  // new serviceBranchID, so the server does build a fresh wizard context there
  // — and the date counter survives it untouched: 4 answers with a refresh,
  // 4 without. The counter belongs to the session, not to the context. The
  // replay costs no date budget either, so leaving it on is merely pointless.
  servicesRefresh: bool('SERVICES_REFRESH', false),
  servicesRefreshEvery: num('SERVICES_REFRESH_EVERY', 3),
  // The two steps are one human action, a couple of seconds apart. The pace
  // between PAIRS stays INTERVAL_MS, which is where the human tempo lives.
  servicesRefreshGapMs: num('SERVICES_REFRESH_GAP_MS', 2000),
  experimentLog: str('EXPERIMENT_LOG', 'experiment.jsonl'),

  // Hypothesis 3 — tida looks like a tab id. On CALL_LIMIT, retry the session
  // under the next tab id instead of burying it. Empty = off.
  tidaRetry: list('TIDA_RETRY_VALUES', []),

  // An empty pool used to end the run. A watchdog instead opens a window, fills
  // the form, asks for the CAPTCHA on the phone and waits — the monitor is the
  // thing that must not stop. Falls back to exiting when no browser can open.
  watchdog: bool('WATCHDOG_ON_EMPTY_POOL', true),
  watchdogPollMs: num('WATCHDOG_POLL_MS', 30_000),
  smsViaTelegram: bool('SMS_CODE_VIA_TELEGRAM', false),
  // When a human is reachable to tap a CAPTCHA. Unset = ask whenever the pool
  // empties, which is how the watchdog came to ask at half past three.
  captchaWindows: str('CAPTCHA_WINDOWS'),
};

const { windows: captchaWindows, bad: badWindows } = parseWindows(config.captchaWindows);
for (const entry of badWindows) {
  console.warn(`  ignoring CAPTCHA_WINDOWS entry "${entry}" — expected e.g. "mon-fri 18:00-22:00"`);
}

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
    // those spends a call from a budget of four per session.
    const only = config.onlyService;
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
      servicesStep: json('SERVICES_STEP', null),
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

  const method = session.method ?? config.method;
  if (method !== 'GET' && (session.body || config.bodies.some((e) => e.body))) {
    headers['Content-Type'] = config.contentType;
  }

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
/** How the last session died, so an empty pool can say why in one place. */
let poolDeath = null;

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

  // The file says how to replay a session, never how this run used one — that
  // belongs in EXPERIMENT_LOG. Counters left behind here would be read back as
  // session state: a stale callsSinceRefresh makes a refresh due on the first
  // call of the next run, and a stale triedTabIds silently ends the tida test.
  const stripped = live.map(
    ({ dead, reason, calls, callLimits, callsSinceRefresh, refreshes, triedTabIds, tabId, label, ...rest }) => ({
      label,
      ...rest,
    }),
  );
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
/**
 * Type the identity into a freshly opened booking window.
 *
 * The window lands at step one, so without this the six fields have to be
 * retyped by hand at the exact moment speed decides whether the slot is still
 * there. The CAPTCHA and the SMS stay the human's — those are the portal's
 * anti-automation controls and are not ours to defeat — but nothing else here
 * needs a person.
 */
async function prefillBookingIdentity(page) {
  const identity = readIdentity();
  if (Object.keys(identity).length === 0) return;

  try {
    if (await enterWizard(page)) console.log(`[${ts()}] booking window: opened the form`);
    const { filled, missed } = await fillIdentity(page, identity);
    if (filled.length > 0) {
      console.log(`[${ts()}] booking window: ${filled.length} field(s) filled — do the CAPTCHA and the SMS`);
    }
    if (missed.length > 0) {
      console.log(`[${ts()}] booking window: type by hand — ${missed.map((f) => f.label).join(', ')}`);
    }
  } catch (err) {
    // Never let this stop the alarm: the banner and the push already went out.
    console.warn(`[${ts()}] booking window: could not prefill (${err.message})`);
  }
}

async function bookingPage(session) {
  if (globalThis.__terminPage) return globalThis.__terminPage;
  if (!bool('PREFILL_BOOKING', true) || !bool('OPEN_BROWSER_ON_SLOT', true)) return null;
  if (ownBrowser) return ownBrowser.page;

  try {
    console.log(`[${ts()}] opening a browser on ${session.label}'s cookies...`);
    const { chromium } = await import('playwright');
    // Record what this window sends. The reservation request has never been
    // seen, and it is the one thing standing between here and booking without a
    // human — pressing "Pokračovať" reveals it even when the race is lost.
    const bookingLog = path.join(str('CAPTURE_DIR', 'captured'), 'booking-requests.jsonl');
    try {
      fs.mkdirSync(path.dirname(bookingLog), { recursive: true });
    } catch {
      // directory already there, or unwritable — recording is best effort
    }

    ownBrowser = await openSessionBrowser(chromium, session, str('START_URL', 'https://pes.minv.sk/'), {
      executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
      recordTo: bookingLog,
      fs,
    });
    console.log(`[${ts()}] recording this window's calls -> ${bookingLog}`);
    // The portal decides where a cookie-carrying window lands, and it is usually
    // step one — so fill the form now rather than leaving it to be retyped while
    // the slot is being taken.
    await prefillBookingIdentity(ownBrowser.page);
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

  // Read on a phone, in seconds, by someone who then has to race for it. The
  // raw answer is a wall of JSON with branchPublicId in it; city, date and how
  // soon are what decide whether to drop everything and run.
  const offers = formatOffers(hit.sample, { prefer: config.preferOffice });

  stopBeeping = await raiseSlotAlarm([
    // An alarm is read in seconds; a line saying "(unnamed)" is only clutter.
    ...(service === '(unnamed)' ? [] : [service]),
    ...(offers.length > 0 ? offers : [hit.sample ? `dates: ${hit.sample}` : 'open the portal tab and click through NOW']),
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
      // Deliberately NOT awaited. The office radio only appears once the human
      // has finished the CAPTCHA and the SMS, so this now waits minutes rather
      // than seconds — and blocking the loop for that long would stop the hunt
      // exactly when the next slot could be appearing.
      prepareBooking(page, offer, { screenshotPath: shot })
        .then(async (done) => {
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
        })
        .catch((err) => console.warn(`[${ts()}] booking prep failed: ${err.message} — book by hand.`));
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

/** The service a refreshed context must be re-aimed at. */
function serviceNeedleOf(session) {
  if (config.onlyService) return config.onlyService;
  const label = session.service?.label;
  return label && !/^[0-9a-f-]{8,}$/i.test(label) ? label : '';
}

/** One row per date call — the measurement the whole experiment rests on. */
function noteDateCall(session, outcome) {
  record(config.experimentLog, {
    kind: 'date',
    label: session.label,
    outcome,
    dateCalls: session.calls,
    callsSinceRefresh: session.callsSinceRefresh ?? 0,
    refreshes: session.refreshes ?? 0,
    ageMin: sessionAgeMin(session),
    tabId: session.tabId ?? null,
  });
}

/** Retire a session, and write down what it managed before it died. */
function bury(session, reason) {
  retireSession(session, reason);
  record(config.experimentLog, {
    kind: 'retire',
    label: session.label,
    reason,
    ageMin: sessionAgeMin(session),
    dateCalls: session.calls,
    refreshes: session.refreshes ?? 0,
    callsSinceRefresh: session.callsSinceRefresh ?? 0,
    tabId: session.tabId ?? null,
  });
  return session;
}

/**
 * Replay the services step, then re-point the date body at the ids it returns.
 *
 * Whether this spends date budget is unmeasured — the step is a different
 * resource id, and CALL_LIMIT was only ever seen on the date endpoint. The
 * counts in EXPERIMENT_LOG are what settle it.
 */
async function refreshServicesContext(session) {
  const step = session.servicesStep;
  const note = (ok, reason, extra = {}) => {
    record(config.experimentLog, {
      kind: 'refresh',
      ok,
      reason,
      label: session.label,
      ageMin: sessionAgeMin(session),
      dateCalls: session.calls,
      refreshes: session.refreshes ?? 0,
      ...extra,
    });
    return { ok, reason };
  };

  if (!step?.url || !step?.body) return note(false, 'no services step recorded — re-capture to get one');

  const headers = buildHeaders(session);
  if (step.contentType) headers['Content-Type'] = step.contentType;
  if (step.referer) headers.Referer = step.referer;

  let response;
  try {
    response = await client.request({ url: step.url, method: step.method ?? 'POST', headers, data: step.body });
  } catch (err) {
    return note(false, `request failed: ${err.code ?? err.message}`);
  }

  if (response.status !== 200) return note(false, `HTTP ${response.status}`);

  const portal = readPortalStatus(response.data);
  if (portal.expired) return note(false, 'answered {} — the context is already gone');
  if (portal.authFailed) return note(false, `code ${portal.code}`);
  if (portal.callLimit) return note(false, 'CALL_LIMIT on the services step itself');

  const template = session.body ?? currentEntry().body;
  const refreshed = refreshedBody(template, response.data, serviceNeedleOf(session));
  if (!refreshed) return note(false, 'the answer named no service we are watching');

  const changed = refreshed.body !== template;
  session.body = refreshed.body;
  session.service = { id: refreshed.service.id, label: serviceLabel(refreshed.service) };
  session.refreshes = (session.refreshes ?? 0) + 1;
  session.callsSinceRefresh = 0;

  console.log(
    `[${ts()}] ${session.label}: services step replayed — ${serviceLabel(refreshed.service)}` +
      (changed ? ` (new id ${refreshed.service.id})` : ' (same id as before)'),
  );
  return note(true, changed ? 'new service id' : 'same service id', { serviceId: refreshed.service.id });
}

async function pingOnce(session) {
  if (config.servicesRefresh && dueForRefresh(session, config.servicesRefreshEvery)) {
    await refreshServicesContext(session);
    await new Promise((resolve) => setTimeout(resolve, config.servicesRefreshGapMs));
  }

  session.calls += 1;
  session.callsSinceRefresh = (session.callsSinceRefresh ?? 0) + 1;

  const method = session.method ?? config.method;
  const response = await client.request({
    url: requestUrl(session),
    method,
    headers: buildHeaders(session),
    data: method === 'GET' ? undefined : (session.body ?? currentEntry().body) || undefined,
  });

  const { status, data } = response;

  if (status === 401 || status === 403) {
    noteDateCall(session, `http-${status}`);
    bury(session, `HTTP ${status}`);
    poolDeath = {
      push: `⛔️ HTTP ${status} — every session expired or the IP got blocked.`,
      exit:
        '\nEvery session is dead (401/403). Walk the wizard again and restart.\n' +
        'A 403 on the very first ping usually means the IP is blocked — turn on a Slovak/Czech VPN.',
    };
    console.error(
      `[${ts()}] HTTP ${status} — ${session.label} rejected. Still live: ${liveSessions(sessions).length}`,
    );
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
    noteDateCall(session, 'expired');
    bury(session, 'expired ({} response)');
    writeStatus({ lastResult: 'expired', lastPingAt: new Date().toISOString(), pings });
    poolDeath = {
      push: '⛔️ Every session expired (empty {} answers).',
      exit:
        '\nEvery session has expired — the portal still accepts the cookie but has dropped the\n' +
        'booking context, so it answers {}. Sessions last about an hour. Run: npm run capture.\n',
    };
    console.error(
      `\n[${ts()}] ${session.label} answered {} — session context expired after ${sessionAgeMin(session) ?? '?'}min. ` +
        `Still live: ${liveSessions(sessions).length}`,
    );
    return TRY_NEXT_SESSION;
  }

  if (portal.callLimit) {
    callLimitHits += 1;
    session.callLimits = (session.callLimits ?? 0) + 1;
    noteDateCall(session, 'call-limit');
    writeStatus({ lastResult: 'call-limit', callLimitHits, lastPingAt: new Date().toISOString(), pings });

    // Hypothesis 3: a counter kept per tab would give the next tida its own
    // budget. A session that just hit CALL_LIMIT is spent anyway, so this costs
    // one call to find out and nothing if it fails.
    const tabId = nextTabId(session, config.tidaRetry);
    if (tabId !== null) {
      const before = session.url;
      markTabId(session, tabId);
      session.url = withTabId(before, tabId);
      session.callLimits = 0;
      record(config.experimentLog, {
        kind: 'tida',
        label: session.label,
        tabId: String(tabId),
        dateCalls: session.calls,
        ageMin: sessionAgeMin(session),
      });
      console.warn(
        `\n[${ts()}] CALL_LIMIT on ${session.label} after ${session.calls} call(s) — ` +
          `retrying it under tida=${tabId} instead of burying it.`,
      );
      extraWaitMs = 0;
      networkFailures = 0;
      return TRY_NEXT_SESSION;
    }

    // CALL_LIMIT is terminal for the session that hit it: measured, the next
    // call comes back 401 whether it is sent in sixty seconds or ten minutes,
    // and the budget never recovers. So retire it and take the next session —
    // waiting only delays the bad news while a slot could be appearing.
    // Retire it even when it was the last one. The budget never comes back, so
    // sitting out ten minutes on a session that is already dead only delays the
    // bad news — and an empty pool is something to be told NOW, while there is
    // still time to capture another, not after a silent wait ending in 401.
    if (session.callLimits >= config.callLimitRetireAfter) {
      bury(session, `CALL_LIMIT x${session.callLimits}`);
      poolDeath = {
        push: '⛔️ Every session is spent (CALL_LIMIT).',
        exit: '\nEvery session is spent. Run: npm run capture.\n',
      };
      const left = liveSessions(sessions).length;
      console.warn(
        `\n[${ts()}] CALL_LIMIT — ${session.label} is spent after ${session.calls} date call(s)` +
          `${session.refreshes ? ` and ${session.refreshes} services refresh(es)` : ''}, dropping it. Still live: ${left}`,
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
    noteDateCall(session, `code-${portal.code}`);
    bury(session, `code ${portal.code}`);
    writeStatus({ lastResult: 'rejected-' + portal.code, lastPingAt: new Date().toISOString(), pings });
    poolDeath = {
      push: `⛔️ Portal returned code ${portal.code} — every session is spent.`,
      exit:
        '\nEvery session has been rejected — the portal says so in the body, not the HTTP status.\n' +
        'Run: npm run capture, walk the wizard again, then restart the monitor.\n',
    };
    console.error(
      `\n[${ts()}] portal says code ${portal.code} — ${session.label} is gone. Still live: ${liveSessions(sessions).length}`,
    );
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

  const outcome = result.available === true ? 'SLOT' : result.available === false ? 'no-slots' : 'inconclusive';
  noteDateCall(session, outcome);

  writeStatus({
    lastPingAt: new Date().toISOString(),
    pings,
    lastResult: outcome,
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

/** Selector pins for identity fields whose label guess went wrong. */
function identityOverrides() {
  return Object.fromEntries(
    IDENTITY_FIELDS.map((field) => [field.env, str(`${field.env}_SELECTOR`)]).filter(([, value]) => value),
  );
}

/** Take a freshly captured session into the live pool and onto disk. */
function adoptSession(entry) {
  const { sessions: parsed, skipped } = parseSessions([entry]);
  if (parsed.length === 0) {
    console.warn(`[${ts()}] the new session is not replayable: ${skipped.join('; ')}`);
    return false;
  }

  const { size } = appendSessionRecord(config.sessionsFile, entry);
  const { merged, added } = mergeSessions(sessions, parsed);

  // Same cookie as a session already buried: reporting success here would leave
  // the pool empty and send the watchdog straight back round.
  if (added.length === 0) {
    console.warn(`[${ts()}] ${entry.label} carries a cookie the pool already knows — nothing adopted.`);
    return false;
  }

  usingSessionsFile = true;
  sessions = merged;
  sessionCursor = -1;
  console.log(`\n[${ts()}] ${entry.label} joined the pool (${size} in ${config.sessionsFile}) — polling resumes.`);
  return true;
}

/**
 * @returns {Promise<boolean>} false when the login could not finish — the
 *   window stays open and the passive wait below takes over.
 */
async function watchdogRelogin() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    console.error(`[${ts()}] no browser available (${err.message}) — cannot re-login from here.`);
    return false;
  }

  try {
    const outcome = await relogin({
      chromium,
      startUrl: str('START_URL', 'https://pes.minv.sk/'),
      executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
      service: config.onlyService,
      office: config.office,
      dateMarker: config.dateMarker,
      overrides: identityOverrides(),
      pinSelector: str('PIN_SELECTOR'),
      poolIndex: readSessionsFile(config.sessionsFile).length + 1,
      fs,
      dumpDir: str('CAPTURE_DIR', 'captured'),
      readCode: config.smsViaTelegram
        ? () =>
            awaitCode({
              token: str('TELEGRAM_BOT_TOKEN'),
              chatId: str('TELEGRAM_CHAT_ID'),
              timeoutMs: num('SMS_CODE_TIMEOUT_MS', 10 * 60_000),
              log: (message) => console.log(`[${ts()}] sms: ${message}`),
            })
        : null,
      notify: notifyTelegram,
      log: (message) => console.log(`[${ts()}] relogin: ${message}`),
    });

    if (!outcome.ok) {
      console.warn(`[${ts()}] re-login never reached the dates: ${outcome.reason}`);
      await notifyTelegram(`⚠️ Re-login nedokončený: ${outcome.reason}. Okno je otvorené — dokonči ho ručne.`);
      return false;
    }

    if (!adoptSession(outcome.session)) return false;
    // Keep the window: it is sitting on the date step, which is exactly where a
    // slot has to be booked. A browser opened later from cookies alone is not.
    ownBrowser = { browser: outcome.browser, page: outcome.page };
    await notifyTelegram(`✅ Nová sesia v poole (${outcome.session.label}) — monitor pokračuje.`);
    return true;
  } catch (err) {
    console.error(`[${ts()}] watchdog re-login failed: ${err.message}`);
    return false;
  }
}

/** A session from disk, if one appeared since the last look. */
function adoptFromDisk() {
  const fromFile = freshSessions(parseSessions(readSessionsFile(config.sessionsFile)).sessions, IDLE_DEATH_MIN);
  const { merged, added } = mergeSessions(sessions, fromFile);
  if (added.length === 0) return null;

  sessions = merged;
  usingSessionsFile = true;
  sessionCursor = -1;
  return added;
}

/**
 * Sit out the hours nobody can answer in.
 *
 * @returns {Promise<boolean>} true when a session turned up meanwhile — someone
 *   ran a capture by hand, and there is nothing left to ask for.
 */
async function waitForWindowOrSession() {
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, config.watchdogPollMs));

    const added = adoptFromDisk();
    if (added) {
      console.log(`\n[${ts()}] adopted ${added.map((s) => s.label).join(', ')} — polling resumes.`);
      return true;
    }
    if (inWindow(new Date(), captchaWindows)) {
      console.log(`\n[${ts()}] CAPTCHA window is open — asking now.`);
      return false;
    }
  }
  return false;
}

/**
 * The passive half of the watchdog: `npm run capture` in another window is
 * still the most reliable way to make a session, and the monitor has to be the
 * thing already running when one appears.
 */
async function waitForFreshSession() {
  console.warn(
    `\n[${ts()}] waiting for a session in ${config.sessionsFile} — run \`npm run capture\`.\n` +
      '  The monitor stays up and adopts it by itself. Nothing is lost by leaving this running.',
  );

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, config.watchdogPollMs));

    const added = adoptFromDisk();
    if (!added) continue;

    console.log(`\n[${ts()}] adopted ${added.map((s) => s.label).join(', ')} — polling resumes.`);
    await notifyTelegram('✅ Monitor pokračuje — nová sesia je v poole.');
    return;
  }
}

/**
 * An empty pool is a call for help, not a reason to stop: exiting here meant
 * the one process that could alert on a slot was gone by the time anyone
 * looked. Exiting is now only the fallback for having no browser at all.
 */
async function handleEmptyPool() {
  const death = poolDeath ?? {
    push: '⛔️ Every captured session is spent.',
    exit: '\nEvery session is spent. Run: npm run capture.\n',
  };
  poolDeath = null;

  if (!config.watchdog) {
    await notifyTelegram(`${death.push} Termín monitor stopped — redo the wizard.`);
    shutdown(1, death.exit);
    return;
  }

  console.warn(`\n[${ts()}] pool is empty — the watchdog takes over instead of exiting.`);
  writeStatus({ lastResult: 'pool-empty', lastReason: death.push, poolEmptyAt: new Date().toISOString() });

  // One CAPTCHA buys one hour of watching, so it is only worth asking for while
  // someone is awake to give it — and the hour it buys should be an hour worth
  // watching. Outside the windows the monitor waits in silence.
  if (!inWindow(new Date(), captchaWindows)) {
    const opens = nextWindowStart(new Date(), captchaWindows);
    console.warn(
      `[${ts()}] outside the CAPTCHA windows — staying quiet until ` +
        `${opens ? opens.toLocaleString('sk-SK', { hour12: false }) : 'the next one'}.`,
    );
    if (await waitForWindowOrSession()) return;
  }

  await notifyTelegram(`${death.push}\n\nPotrebná CAPTCHA + SMS. Monitor nebeží naprázdno — čaká na novú sesiu.`);

  if (await watchdogRelogin()) {
    writeStatus({ lastResult: 'recovered', poolEmptyAt: null });
    return;
  }

  await waitForFreshSession();
  writeStatus({ lastResult: 'recovered', poolEmptyAt: null });
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
    console.log(`  sessions : ${sessions.length} in rotation — roughly ${sessions.length * 4} calls`);

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
  if (config.servicesRefresh) {
    const recorded = sessions.filter((s) => s.servicesStep?.url).length;
    console.log(
      `  hypothesis: services step replayed every ${config.servicesRefreshEvery} date call(s) — ` +
        `${recorded}/${sessions.length} session(s) carry one`,
    );
    if (recorded === 0) {
      console.warn('  !! No session has a recorded services step. Re-capture, or the refresh does nothing.');
    }
  }
  if (config.tidaRetry.length > 0) {
    console.log(`  hypothesis: on CALL_LIMIT, retry under tida=${config.tidaRetry.join(', then ')}`);
  }
  if (config.experimentLog) console.log(`  log      : ${config.experimentLog} (npm run experiment)`);
  console.log(`  on empty : ${config.watchdog ? 'open a window, ask for the CAPTCHA, keep watching' : 'exit'}`);
  if (config.watchdog && captchaWindows.length > 0) {
    const hours = Math.round(weeklyMinutes(captchaWindows) / 60);
    console.log(`  asks in  : ${captchaWindows.map((w) => w.label).join(' | ')}`);
    console.log(`             ${hours}h a week to be asked in — at ~1h watched per CAPTCHA, that is the ceiling`);
  }
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
        if (!turn) break;
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

      // Checked here rather than inside pingOnce: the last session can die on
      // any of five different answers, and handling it in one place is what
      // lets the watchdog exist at all.
      if (running && liveSessions(sessions).length === 0) await handleEmptyPool();
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
