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
import { extractServices, buildRotation } from './src/bodies.js';

const config = {
  startUrl: str('START_URL', 'https://pes.minv.sk/'),
  executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
  headless: bool('HEADLESS', false),
  outDir: str('CAPTURE_DIR', 'captured'),
  maxBodyChars: num('CAPTURE_MAX_BODY', 20_000),
  noSlotsPhrases: list('NO_SLOTS_TEXT', PORTAL_NO_SLOTS_PHRASES),
};

const captured = [];

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

/** page.url() is "about:blank" for the very first request — useless as a Referer. */
function usablePageUrl(entry) {
  if (entry.pageUrl && entry.pageUrl !== 'about:blank') return entry.pageUrl;
  return new URL(entry.url).origin;
}

/** Keep TELEGRAM_* across a re-capture so the one alert that matters still lands. */
function carryOverAlerting() {
  const found = readEnvValues(['.env', '.env.captured'], ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  return { token: found.TELEGRAM_BOT_TOKEN ?? '', chatId: found.TELEGRAM_CHAT_ID ?? '' };
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
  if (body && services.length > 0) {
    const rotation = buildRotation(body, services);
    if (rotation.length > 1) {
      const rotPath = path.join(config.outDir, 'request-bodies.txt');
      const header = services
        .map((s) => `# ${s.id}  ${s.group ? s.group + ' / ' : ''}${s.name}`)
        .join('\n');
      await fs.writeFile(rotPath, `${header}\n${rotation.join('\n')}\n`, 'utf8');
      rotationLine = envLine('REQUEST_BODIES_FILE', rotPath);
      console.log(`\nRotation set: ${rotation.length} bodies -> ${rotPath}`);
      for (const s of services) console.log(`   ${s.id}  ${s.name}`);
    }
  }

  // The endpoint answers {"services":[...]} on the ECU flow; anywhere else let
  // the detector find the array itself.
  const isEcuDateEndpoint = /available-offices-service-date/.test(best.url);

  // Re-capturing is routine (cookies die often). Losing the Telegram wiring
  // every time would mean the one alert that matters goes nowhere.
  const carried = carryOverAlerting();

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
    '# The portal throttles: faster than this earns CALL_LIMIT and can cost you',
    '# the whole session. Do not lower these.',
    envLine('INTERVAL_MS', '60000'),
    envLine('JITTER_MS', '15000'),
    envLine('NO_SLOTS_TEXT', config.noSlotsPhrases.join(',')),
    isEcuDateEndpoint ? envLine('SLOT_JSON_PATH', 'services') : '# SLOT_JSON_PATH=data.terms',
    '',
    carried.token ? envLine('TELEGRAM_BOT_TOKEN', carried.token) : '# TELEGRAM_BOT_TOKEN=',
    carried.chatId ? envLine('TELEGRAM_CHAT_ID', carried.chatId) : '# TELEGRAM_CHAT_ID=',
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

    captured.push(entry);
    await log.write(`${JSON.stringify(entry)}\n`);
    console.log(`  [${entry.status}] ${entry.method} ${entry.url.slice(0, 120)}`);
  });

  console.log('Session capture — walk the wizard by hand, everything is recorded.');
  console.log('NOTE: the log will contain your name, document number and SMS PIN.');
  console.log(`      ${config.outDir}/ is gitignored — delete it once .env works.\n`);
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    '\n>>> Solve the CAPTCHA, enter the SMS code, then keep going:\n' +
      '>>>   service -> office -> until the CALENDAR WITH DATES is on screen.\n' +
      '>>> The dates step is the one we need — stopping earlier captures the\n' +
      '>>> wrong request. Press ENTER only once you can see the dates.\n',
  );
  rl.close();

  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await warnOnIpMismatch(page);

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

  if (ranked.length === 0) {
    console.error('\nNothing captured — did the wizard actually load?');
  } else {
    const target = await writeEnvTemplate(ranked[0].entry, cookieHeader, userAgent);
    console.log(`\nWrote ${target} (top candidate).`);
    console.log(`Full request log: ${logPath}`);
    console.log('If the top candidate looks wrong — no dates in it, or it answered');
    console.log('HTML — pick a better one from the log and fix TARGET_URL by hand.');
    console.log('\nNext: cp .env.captured .env && npm run monitor');
  }

  await log.close();

  if (bool('CLOSE_BROWSER_ON_EXIT', false)) {
    await browser.close();
    return;
  }

  // Deliberately NOT closing the browser: the portal session lives in it, and
  // killing the window throws away the CAPTCHA and SMS you just went through.
  console.log('\nLeaving the browser open so the session stays alive.');
  console.log('Close it yourself once monitor.js is running. Ctrl+C to exit this script.');
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`\nFatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
