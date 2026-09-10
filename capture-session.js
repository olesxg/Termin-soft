#!/usr/bin/env node
/**
 * Bridge between the two variants.
 *
 * Opens a real browser, records every XHR/fetch the wizard makes while you walk
 * it by hand, and — when you press ENTER on the date step — writes a ready
 * .env.captured with the request that fetched the dates, its cookies and its
 * headers. Copy that over .env and Variant 1 is configured.
 *
 * Beats hand-editing "Copy as cURL", and it also shows you what the page is
 * actually calling, which is what you need to pick TRIGGER_SELECTOR later.
 */
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { str, num, bool, list } from './src/config.js';
import { PORTAL_NO_SLOTS_PHRASES } from './src/detect.js';
import { scoreRequest, countDates } from './src/rank.js';
import { readEnvValues } from './src/envfile.js';
import { extractServices, buildRotation, bodyForService, matchServices } from './src/bodies.js';
import { readIdentity, fillIdentity, enterWizard, IDENTITY_FIELDS } from './src/identity.js';

const config = {
  startUrl: str('START_URL', 'https://pes.minv.sk/'),
  executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
  headless: bool('HEADLESS', false),
  outDir: str('CAPTURE_DIR', 'captured'),
  maxBodyChars: num('CAPTURE_MAX_BODY', 20_000),
  noSlotsPhrases: list('NO_SLOTS_TEXT', PORTAL_NO_SLOTS_PHRASES),
};

const captured = [];
let logOpen = true;

/** Latest credentials seen on the wire, in case the browser dies before the dump. */
const lastSeen = { cookie: '', userAgent: '' };

/**
 * dotenv strips surrounding quotes but does NOT unescape \" or \' inside them,
 * so an escaped quote would survive into the value and break JSON.parse.
 * Pick a quote character the value does not contain instead.
 */
function envLine(key, value) {
  if (value === undefined || value === null || value === '') return `# ${key}=`;
  const flat = String(value).replace(/[\r\n]+/g, ' ');

  if (!flat.includes("'")) return `${key}='${flat}'`;
  if (!flat.includes('"')) return `${key}="${flat}"`;
  return `# FIXME: value contains both quote types, quote it by hand\n# ${key}=${flat}`;
}

/**
 * The portal ties the session to the IP it saw (it literally POSTs the client's
 * address to GetIpAddress). If a VPN covers the browser but not Node — an
 * app-scoped or extension VPN, which is easy to end up with — then monitor.js
 * would replay a Slovak session from an Italian address and get thrown out.
 * Cheaper to find out now than after burning an SMS.
 */
async function warnOnIpMismatch(page) {
  const read = async (fetcher) => {
    try {
      const res = await fetcher();
      return res?.ip ?? null;
    } catch {
      return null;
    }
  };

  const browserIp = await read(() =>
    page.evaluate(() => fetch('https://api.ipify.org?format=json').then((r) => r.json())),
  );
  const nodeIp = await read(() =>
    fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()),
  );

  if (!browserIp || !nodeIp) {
    console.log('\n(could not compare browser/Node exit IPs — check your VPN by hand)');
    return;
  }
  if (browserIp === nodeIp) {
    console.log(`\nExit IP: ${nodeIp} — browser and Node agree, good.`);
    return;
  }

  console.log('\n' + '!'.repeat(66));
  console.log('  IP MISMATCH — monitor.js will very likely be rejected.');
  console.log(`    browser (session is bound to this): ${browserIp}`);
  console.log(`    Node (monitor.js will ping from)  : ${nodeIp}`);
  console.log('  Your VPN covers the browser but not Node. Make it system-wide,');
  console.log('  then re-run the capture so the session is bound to one address.');
  console.log('!'.repeat(66));
}

/**
 * Type the identity into step 1 so the human is left with only the CAPTCHA and
 * the SMS. Never allowed to break the run: if the form has moved or a label
 * changed, it says so and you fill that field by hand as before.
 */
async function prefillIdentity(page) {
  const identity = readIdentity();
  if (Object.keys(identity).length === 0) {
    console.log('\n(no ID_* values in .env — filling the form by hand this time)');
    console.log(`  set: ${IDENTITY_FIELDS.map((f) => f.env).join(', ')}\n`);
    return;
  }

  const overrides = Object.fromEntries(
    IDENTITY_FIELDS.map((f) => [f.env, str(`${f.env}_SELECTOR`)]).filter(([, v]) => v),
  );

  try {
    if (await enterWizard(page)) console.log('  pressed "Pokračovať" to open the form');

    const { filled, missed } = await fillIdentity(page, identity, { overrides });
    for (const { field, label } of filled) console.log(`  filled ${field.label} <- ${label}`);
    if (missed.length > 0) {
      console.log(`  NOT filled: ${missed.map((f) => f.label).join(', ')} — type these by hand.`);
      console.log(`  (or pin them with ${missed[0].env}_SELECTOR=<css> in .env)`);
    }
    if (filled.length > 0) console.log('\n  Form is ready — do the CAPTCHA and the SMS.\n');
  } catch (err) {
    console.log(`\n(could not prefill: ${err.message} — fill the form by hand)\n`);
  }
}

/** page.url() is "about:blank" for the very first request — useless as a Referer. */
function usablePageUrl(entry) {
  if (entry.pageUrl && entry.pageUrl !== 'about:blank') return entry.pageUrl;
  return new URL(entry.url).origin;
}

/**
 * Keep the settings that must survive a re-capture. Cookies die often, so this
 * runs a lot; anything not carried here is silently lost every time.
 *
 * TELEGRAM_* — the one alert that matters would otherwise go nowhere.
 * ONLY_SERVICE — losing it re-widens the rotation to every service the wizard
 * offers, and monitor.js stops watching on the first hit whichever service it
 * belongs to. That has already cost a session: a slot on the document-issuing
 * service halted the watch while the registration it was meant to catch went
 * unchecked for over an hour.
 */
function carryOverSettings() {
  const found = readEnvValues(
    ['.env', '.env.captured'],
    [
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ONLY_SERVICE', 'AUTOSTART_MONITOR',
      'START_URL', 'NETWORK_BACKOFF_CAP_MS',
      'INTERVAL_MS', 'JITTER_MS', 'HEARTBEAT_EVERY',
      'POLL_ALIGN_MINUTE_MOD', 'POLL_ALIGN_MINUTE_OFFSET', 'POLL_ALIGN_SECOND',
      'POLL_BURST', 'POLL_BURST_SPACING_MS',
      // Losing these would put the six fields back on the human every capture —
      // the exact chore the prefill exists to remove.
      ...IDENTITY_FIELDS.map((f) => f.env),
    ],
  );
  return {
    identity: Object.fromEntries(IDENTITY_FIELDS.map((f) => [f.env, found[f.env] ?? ''])),
    token: found.TELEGRAM_BOT_TOKEN ?? '',
    chatId: found.TELEGRAM_CHAT_ID ?? '',
    onlyService: found.ONLY_SERVICE ?? '',
    autostart: found.AUTOSTART_MONITOR ?? '',
    // A pace you tuned by hand must not be reset to the default on every
    // re-capture — re-capturing is the routine case, not the exception.
    // The wizard's deep link. Losing it on every re-capture meant digging the
    // URL out of old notes before each run — it belongs in the config.
    startUrl: found.START_URL ?? '',
    networkBackoffCapMs: found.NETWORK_BACKOFF_CAP_MS ?? '',
    intervalMs: found.INTERVAL_MS ?? '',
    jitterMs: found.JITTER_MS ?? '',
    heartbeatEvery: found.HEARTBEAT_EVERY ?? '',
    align: {
      mod: found.POLL_ALIGN_MINUTE_MOD ?? '', offset: found.POLL_ALIGN_MINUTE_OFFSET ?? '',
      second: found.POLL_ALIGN_SECOND ?? '', burst: found.POLL_BURST ?? '', spacing: found.POLL_BURST_SPACING_MS ?? '',
    },
  };
}

/**
 * Save the markup of the date step, so the booking UI can be driven later.
 *
 * Replaying the reservation as an HTTP call is not possible: no capture has
 * ever reached it, so its resource id and payload are unknown, and inventing
 * them would mean firing a made-up request carrying real identity data.
 * Clicking the portal's own buttons avoids that entirely — but it needs the
 * selectors, and only the network was ever recorded, never the page.
 *
 * Reading the DOM clicks nothing, spends no call budget and cannot touch the
 * session, so this is free to collect and safe to do on every capture.
 */
async function dumpDateStepDom(page) {
  try {
    const htmlPath = path.join(config.outDir, 'date-step.html');
    await fs.writeFile(htmlPath, await page.content(), 'utf8');

    // A full page dump is unreadable; pull out the things a booking click would
    // plausibly target so the selectors can be picked by eye.
    const candidates = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
        text: (el.innerText || el.value || '').trim().slice(0, 60),
        name: el.getAttribute('name'),
        type: el.getAttribute('type'),
      });
      const out = { clickable: [], selects: [], dateish: [] };
      for (const el of document.querySelectorAll('button, a[href], input[type=button], input[type=submit], [role=button]')) {
        if (visible(el)) out.clickable.push(describe(el));
      }
      for (const el of document.querySelectorAll('select')) {
        if (visible(el)) out.selects.push({ ...describe(el), options: [...el.options].slice(0, 8).map((o) => o.text.trim()) });
      }
      // Anything whose own text looks like a date — calendar cells, time slots.
      for (const el of document.querySelectorAll('td, li, div, span, button')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        if (/^\d{1,2}[.:]\d{2}(:\d{2})?$|^\d{1,2}\.\s?\d{1,2}\.\s?\d{4}$|^\d{1,2}$/.test(own) && visible(el)) {
          out.dateish.push(describe(el));
        }
      }
      out.dateish = out.dateish.slice(0, 40);
      return out;
    });

    const jsonPath = path.join(config.outDir, 'date-step-selectors.json');
    await fs.writeFile(jsonPath, `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');

    console.log(`\nSaved the date step for building a booking clicker:`);
    console.log(`  ${htmlPath}`);
    console.log(`  ${jsonPath}  (${candidates.clickable.length} buttons, ${candidates.selects.length} selects, ${candidates.dateish.length} date/time-looking nodes)`);
  } catch (err) {
    // Never let a diagnostic dump cost a session that took a CAPTCHA and an SMS.
    console.warn(`\n(could not save the date-step DOM: ${err.message} — capture continues)`);
  }
}

/**
 * Append this capture to the rotation file.
 *
 * CALL_LIMIT is counted per session, so each capture adds its own ~5 calls to
 * the pool. Accumulating them here is what makes a bulk-capture session worth
 * the SMS: monitor.js rotates over every entry, and a session only leaves the
 * rotation when the portal rejects it.
 *
 * Appends rather than overwrites, and skips a cookie already in the file, so
 * running `npm run capture` ten times in a row builds the pool ten deep
 * without any bookkeeping by hand.
 */
async function appendSession(best, cookieHeader, userAgent, body) {
  const file = str('SESSIONS_FILE', 'sessions.json');
  let existing = [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    // no file yet — this capture starts the pool
  }

  if (existing.some((s) => s?.cookie === cookieHeader)) {
    console.log(`\n${file}: this session is already in the pool (${existing.length} total).`);
    return existing.length;
  }

  const headers = best.requestHeaders ?? {};
  const csrfEntry = Object.entries(headers).find(([name]) =>
    /csrf|xsrf|verification.?token/i.test(name),
  );

  existing.push({
    // Local time, to match monitor.log — a UTC label next to local timestamps
    // reads as a two-hour gap that never happened.
    label: `s${existing.length + 1} ${new Date().toLocaleTimeString('sk-SK', { hour12: false }).slice(0, 5)}`,
    capturedAt: new Date().toISOString(),
    cookie: cookieHeader,
    url: best.url,
    csrfHeaderName: csrfEntry ? csrfEntry[0] : undefined,
    csrfToken: csrfEntry ? csrfEntry[1] : undefined,
    referer: headers.referer ?? usablePageUrl(best),
    userAgent,
    body,
  });

  await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(`\n${file}: pool is now ${existing.length} session(s) — roughly ${existing.length * 5} calls.`);
  return existing.length;
}

async function writeEnvTemplate(best, cookieHeader, userAgent) {
  const headers = best.requestHeaders ?? {};
  const csrfEntry = Object.entries(headers).find(([name]) =>
    /csrf|xsrf|verification.?token/i.test(name),
  );

  const skipHeaders = new Set([
    'cookie', 'user-agent', 'accept', 'accept-language', 'accept-encoding',
    'content-type', 'content-length', 'referer', 'origin', 'host', 'connection',
    'x-requested-with', 'cache-control', 'pragma',
  ]);
  const extra = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !skipHeaders.has(name.toLowerCase()) &&
        !name.startsWith(':') &&
        !name.toLowerCase().startsWith('sec-') &&
        (!csrfEntry || name !== csrfEntry[0]),
    ),
  );

  // A body with both quote characters in it cannot be inlined into .env, so it
  // goes to a file and monitor.js reads it from there.
  const body = best.postData ?? '';
  let bodyLine = envLine('REQUEST_BODY', body);
  if (body && bodyLine.startsWith('#')) {
    const bodyPath = path.join(config.outDir, 'request-body.txt');
    await fs.writeFile(bodyPath, body, 'utf8');
    bodyLine = `${envLine('REQUEST_BODY_FILE', bodyPath)}  # body had both quote types`;
  }

  // Build a rotation set from every service the wizard offered. Repeating one
  // identical body is what preceded both session deaths; varying it is both a
  // wider net and a plausible way past the guard.
  let rotationLine = '# REQUEST_BODIES_FILE=';
  const services = captured.flatMap((e) => extractServices(e.responseBody));
  const carried = carryOverSettings();
  const label = (s) => `${s.group ? s.group + ' / ' : ''}${s.name}`;

  if (body && services.length > 0) {
    const rotation = buildRotation(body, services);
    if (rotation.length > 1) {
      const rotPath = path.join(config.outDir, 'request-bodies.txt');
      const header = services.map((s) => `# ${s.id}  ${label(s)}`).join('\n');
      await fs.writeFile(rotPath, `${header}\n${rotation.join('\n')}\n`, 'utf8');
      rotationLine = envLine('REQUEST_BODIES_FILE', rotPath);
      console.log(`\nRotation set: ${rotation.length} bodies -> ${rotPath}`);
      for (const s of services) console.log(`   ${s.id}  ${s.name}`);
    }

    // ONLY_SERVICE overrides the rotation: every call goes to the one service
    // that matters, and the ids are regenerated per session so this has to be
    // rebuilt from the fresh capture rather than reused from the old file.
    if (carried.onlyService) {
      const wanted = matchServices(services, carried.onlyService);
      const bodies = wanted.map((s) => bodyForService(body, s.id)).filter(Boolean);
      if (bodies.length > 0) {
        const onlyPath = path.join(config.outDir, 'request-bodies-only.txt');
        const header = wanted.map((s) => `# ${s.id}  ${label(s)}`).join('\n');
        await fs.writeFile(onlyPath, `${header}\n${bodies.join('\n')}\n`, 'utf8');
        rotationLine = envLine('REQUEST_BODIES_FILE', onlyPath);
        console.log(`\nONLY_SERVICE="${carried.onlyService}" -> polling ${bodies.length} service(s):`);
        for (const s of wanted) console.log(`   ${s.id}  ${label(s)}`);
      } else {
        console.warn(
          `\n!! ONLY_SERVICE="${carried.onlyService}" matched NOTHING in this capture.` +
            '\n!! Falling back to the full rotation — check the spelling against the list above.',
        );
      }
    }
  }

  // The endpoint answers {"services":[...]} on the ECU flow; anywhere else let
  // the detector find the array itself.
  const isEcuDateEndpoint = /available-offices-service-date/.test(best.url);

  const lines = [
    '# Generated by capture-session.js — review, then: cp .env.captured .env',
    `# captured at ${new Date().toISOString()}`,
    '# NOTE: cookies expire. Re-capture whenever the monitor reports 401.',
    '',
    envLine('TARGET_URL', best.url),
    envLine('METHOD', best.method),
    envLine('COOKIE_HEADER', cookieHeader),
    envLine('CSRF_HEADER_NAME', csrfEntry ? csrfEntry[0] : 'X-CSRF-TOKEN'),
    envLine('CSRF_TOKEN', csrfEntry ? csrfEntry[1] : ''),
    bodyLine,
    rotationLine,
    envLine('CONTENT_TYPE', headers['content-type'] ?? 'application/json'),
    envLine('REFERER', headers.referer ?? usablePageUrl(best)),
    envLine('ORIGIN', headers.origin ?? new URL(best.url).origin),
    envLine('USER_AGENT', userAgent),
    envLine('EXTRA_HEADERS', Object.keys(extra).length ? JSON.stringify(extra) : ''),
    '',
    '# Pace the calls, do not race them. CALL_LIMIT counts CALLS, not speed:',
    '# 6s, 60s and rotated bodies all died on the 5th call. So a fast interval',
    '# buys nothing and spends the whole session in five minutes — one capture',
    '# on 2026-08-27 was exhausted by 18:55 while the slot it was hunting had',
    '# appeared at 21:58 the week before.',
    '#',
    '# Each date call also resets the 15-30 min idle timer, so a wide interval',
    '# keeps the session warm by itself. 10min + up to 2min jitter caps the gap',
    '# at 12min — inside the idle window — and stretches ~5 calls across ~an hour.',
    envLine('INTERVAL_MS', carried.intervalMs || '600000'),
    envLine('JITTER_MS', carried.jitterMs || '120000'),
    '# One line per poll. The default of 20 was tuned for a 60s interval; at a',
    '# 10min pace it prints once every 3.3 hours and a working monitor reads as',
    '# a dead one — which is exactly how it was misread on 2026-08-27.',
    envLine('HEARTBEAT_EVERY', carried.heartbeatEvery || '1'),
    '',
    '# Wall-clock aligned polling. Places the calls; never creates more.',
    carried.align.mod ? envLine('POLL_ALIGN_MINUTE_MOD', carried.align.mod) : '# POLL_ALIGN_MINUTE_MOD=10',
    carried.align.offset ? envLine('POLL_ALIGN_MINUTE_OFFSET', carried.align.offset) : '# POLL_ALIGN_MINUTE_OFFSET=8',
    carried.align.second ? envLine('POLL_ALIGN_SECOND', carried.align.second) : '# POLL_ALIGN_SECOND=58',
    carried.align.burst ? envLine('POLL_BURST', carried.align.burst) : '# POLL_BURST=1',
    carried.align.spacing ? envLine('POLL_BURST_SPACING_MS', carried.align.spacing) : '# POLL_BURST_SPACING_MS=1500',
    envLine('NO_SLOTS_TEXT', config.noSlotsPhrases.join(',')),
    isEcuDateEndpoint ? envLine('SLOT_JSON_PATH', 'services') : '# SLOT_JSON_PATH=data.terms',
    '',
    carried.token ? envLine('TELEGRAM_BOT_TOKEN', carried.token) : '# TELEGRAM_BOT_TOKEN=',
    carried.chatId ? envLine('TELEGRAM_CHAT_ID', carried.chatId) : '# TELEGRAM_CHAT_ID=',
    '',
    '# Carried across re-captures — see carryOverSettings().',
    carried.startUrl ? envLine('START_URL', carried.startUrl) : '# START_URL=',
    carried.networkBackoffCapMs
      ? envLine('NETWORK_BACKOFF_CAP_MS', carried.networkBackoffCapMs)
      : '# NETWORK_BACKOFF_CAP_MS=60000',
    '',
    '# Typed into step 1 on the next capture, so only the CAPTCHA and SMS are left.',
    ...IDENTITY_FIELDS.map((f) =>
      carried.identity[f.env] ? envLine(f.env, carried.identity[f.env]) : `# ${f.env}=`,
    ),
    '',
    carried.onlyService ? envLine('ONLY_SERVICE', carried.onlyService) : '# ONLY_SERVICE=',
    carried.autostart ? envLine('AUTOSTART_MONITOR', carried.autostart) : '# AUTOSTART_MONITOR=true',
    '',
  ];

  const target = '.env.captured';
  await fs.writeFile(target, lines.join('\n'), 'utf8');
  return target;
}

async function main() {
  await fs.mkdir(config.outDir, { recursive: true });
  const logPath = path.join(config.outDir, 'requests.jsonl');
  const log = await fs.open(logPath, 'w');

  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: config.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK' });
  const page = await context.newPage();

  page.on('response', async (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (!['xhr', 'fetch', 'document'].includes(type)) return;

    const entry = {
      at: new Date().toISOString(),
      resourceType: type,
      method: request.method(),
      url: response.url(),
      status: response.status(),
      pageUrl: page.url(),
      requestHeaders: await request.allHeaders().catch(() => ({})),
      responseContentType: response.headers()['content-type'] ?? '',
      postData: request.postData() ?? '',
      responseBody: '',
    };

    try {
      entry.responseBody = (await response.text()).slice(0, config.maxBodyChars);
    } catch {
      // body not retained — keep the metadata anyway
    }

    if (/minv\.sk/.test(entry.url)) {
      if (entry.requestHeaders?.cookie) lastSeen.cookie = entry.requestHeaders.cookie;
      if (entry.requestHeaders?.['user-agent']) lastSeen.userAgent = entry.requestHeaders['user-agent'];
    }

    captured.push(entry);
    // The page keeps loading after the dump has closed the log. Writing to a
    // closed handle throws EBADF from an async listener, which is unhandled
    // and kills the process — taking the browser, and the live session, too.
    if (logOpen) {
      try {
        await log.write(`${JSON.stringify(entry)}\n`);
      } catch {
        logOpen = false;
      }
    }
    console.log(`  [${entry.status}] ${entry.method} ${entry.url.slice(0, 120)}`);
  });

  console.log('Session capture — walk the wizard by hand, everything is recorded.');
  console.log('NOTE: the log will contain your name, document number and SMS PIN.');
  console.log(`      ${config.outDir}/ is gitignored — delete it once .env works.\n`);
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });

  if (bool('PREFILL_IDENTITY', true)) await prefillIdentity(page);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    '\n>>> Solve the CAPTCHA, enter the SMS code, then keep going:\n' +
      '>>>   service -> office -> until the CALENDAR WITH DATES is on screen.\n' +
      '>>> The dates step is the one we need — stopping earlier captures the\n' +
      '>>> wrong request. Press ENTER only once you can see the dates.\n',
  );
  rl.close();

  await dumpDateStepDom(page);

  // The browser may already be gone — closed by hand, or crashed. Everything
  // needed was recorded as each request went out, so fall back to that rather
  // than throwing away a session that cost a CAPTCHA and an SMS.
  let cookieHeader = lastSeen.cookie;
  let userAgent = lastSeen.userAgent;

  try {
    const cookies = await context.cookies();
    if (cookies.length > 0) cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    console.warn('\n(browser is gone — using the cookies recorded from its last request)');
  }
  try {
    userAgent = await page.evaluate(() => navigator.userAgent);
  } catch {
    // the recorded User-Agent header is just as good
  }
  try {
    await warnOnIpMismatch(page);
  } catch {
    console.log('\n(could not compare exit IPs — browser closed)');
  }

  if (!cookieHeader) {
    console.error('\nNo cookies anywhere — the wizard never authenticated. Nothing to save.');
    process.exit(1);
  }

  const ranked = captured
    .map((entry) => ({ entry, score: scoreRequest(entry, config.noSlotsPhrases) }))
    .sort((a, b) => b.score - a.score || b.entry.at.localeCompare(a.entry.at));

  console.log('\nTop candidates for TARGET_URL:');
  for (const { entry, score } of ranked.slice(0, 8)) {
    const dates = countDates(entry.responseBody);
    const tag = [
      (entry.responseContentType ?? '').includes('json') ? 'json' : 'html',
      dates ? `${dates} dates` : 'no dates',
    ].join(', ');
    console.log(`  score ${String(score).padStart(3)}  [${tag}]  ${entry.method} ${entry.url.slice(0, 90)}`);
    if (entry.postData) console.log(`             body: ${entry.postData.slice(0, 90)}`);
  }

  let envTarget = null;
  if (ranked.length === 0) {
    console.error('\nNothing captured — did the wizard actually load?');
  } else {
    envTarget = await writeEnvTemplate(ranked[0].entry, cookieHeader, userAgent);
    console.log(`\nWrote ${envTarget} (top candidate).`);
    console.log(`Full request log: ${logPath}`);
    console.log('If the top candidate looks wrong — no dates in it, or it answered');
    console.log('HTML — pick a better one from the log and fix TARGET_URL by hand.');

    // Each session needs the body for ITS OWN serviceBranchID — the ids are
    // regenerated per capture, so a shared body would ask the wrong service.
    if (bool('SESSIONS_APPEND', true)) {
      let sessionBody = ranked[0].entry.postData ?? '';
      const narrowed = path.join(config.outDir, 'request-bodies-only.txt');
      try {
        const line = (await fs.readFile(narrowed, 'utf8'))
          .split(/\r?\n/)
          .find((l) => l.startsWith('data='));
        if (line) sessionBody = line;
      } catch {
        // no ONLY_SERVICE narrowing — the captured body is the right one
      }
      await appendSession(ranked[0].entry, cookieHeader, userAgent, sessionBody);
    }
  }

  logOpen = false;
  await log.close();

  if (bool('CLOSE_BROWSER_ON_EXIT', false)) {
    await browser.close();
    return;
  }

  // Deliberately NOT closing the browser: the portal session lives in it, and
  // killing the window throws away the CAPTCHA and SMS you just went through.
  console.log('\nLeaving the browser open so the session stays alive.');

  // --hold overrides AUTOSTART_MONITOR for this one run: keep THIS browser and
  // start the monitor in it. The window is already sitting on the date step, so
  // a found slot can be pre-filled there — a browser opened later from cookies
  // alone lands wherever the portal decides, which is not the date step.
  //
  // The intended shape of a pooled evening: capture as many as you want with
  // AUTOSTART_MONITOR=false, then finish with `npm run capture -- --hold`.
  const hold = process.argv.includes('--hold');
  if (envTarget && (hold || bool('AUTOSTART_MONITOR', true))) {
    await startMonitor(envTarget);
    return;
  }

  // Pool mode: the session lives in the cookies now saved to sessions.json, not
  // in this window. Holding the browser open would block the terminal, and
  // building a pool means running this twenty times in a row — so close it and
  // exit, leaving the shell free for the next capture.
  if (bool('SESSIONS_APPEND', true)) {
    await browser.close();
    console.log('\nBrowser closed — this session now lives in sessions.json.');
    console.log('Run `npm run capture` again to add another, or `npm run monitor` to start.');
    console.log('Leave ONE browser open at the date step when you are done: that is where you book.');
    return;
  }

  console.log('Close it yourself once monitor.js is running. Ctrl+C to exit this script.');
  console.log('\nNext: cp .env.captured .env && npm run monitor');
  await new Promise(() => {});
}

/**
 * Hand straight over to the monitor, in THIS process.
 *
 * The gap between capture and monitor is where sessions die: a CAPTCHA and an
 * SMS buy roughly four calls and expire after 15-30 idle minutes, and three
 * sessions in a row were lost to nobody running `npm run monitor` in time — one
 * of them sat unpolled for 2h43m and came back 401 on the first ping.
 *
 * Running in-process rather than spawning keeps the browser (and therefore the
 * session) alive on this process, and puts the beep in the terminal you are
 * already looking at. monitor.js reads its config from process.env at import
 * time, so .env has to be copied and reloaded BEFORE the import.
 */
async function startMonitor(envTarget) {
  try {
    await fs.copyFile(envTarget, '.env');
    const dotenv = await import('dotenv');
    dotenv.config({ path: '.env', override: true });

    console.log(`Copied ${envTarget} -> .env and starting the monitor here.`);
    console.log('Leave this window open: it holds the browser AND does the polling.\n');

    // Hand the live page to the monitor so a found slot can be pre-filled in
    // the window you already have open. A global is blunt, but monitor.js is a
    // standalone entry point with no way to be passed arguments, and the
    // alternative — driving the browser from another process — is impossible:
    // Playwright launches it with --remote-debugging-pipe, so nothing outside
    // this process can attach to it.
    globalThis.__terminPage = page;

    await import('./monitor.js');
  } catch (err) {
    // The session is still good at this point — never let a handover bug be
    // what throws away the SMS. Fall back to holding the browser open.
    console.error(`\nCould not start the monitor automatically: ${err.message}`);
    console.error('Do it by hand, in another window, NOW — the session is ticking:');
    console.error('  cp .env.captured .env && npm run monitor\n');
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
