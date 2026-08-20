#!/usr/bin/env node
/**
 * One command for the phone: authenticate, then hunt.
 *
 * Built for the "away with only an iPhone, PC always on" case. You reach the PC
 * over RustDesk, run this once, and do only the parts a human must:
 *   - solve the CAPTCHA
 *   - type the SMS code (it is on the same phone)
 *   - pick the service and office until the dates appear
 *
 * The moment the portal answers the date endpoint, this captures that exact
 * request, writes .env, closes the browser and starts the monitor itself — no
 * pressing ENTER at the right instant, no copying files. Then you put the phone
 * away; Telegram tells you if a slot opens or when the ~6-call budget is spent
 * and a fresh CAPTCHA + SMS is needed.
 *
 *   npm run hunt
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

import { str, num, bool } from '../src/config.js';
import { envLine } from '../src/envwrite.js';
import { extractServices, bodyForService } from '../src/bodies.js';
import { readEnvValues } from '../src/envfile.js';

const config = {
  startUrl: str('START_URL', 'https://pes.minv.sk/'),
  executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
  headless: bool('HEADLESS', false),
  outDir: str('CAPTURE_DIR', 'captured'),
  dateMarker: str('DATE_ENDPOINT_MARKER', 'available-offices-service-date'),
  authTimeoutMin: num('AUTH_TIMEOUT_MIN', 20),
  // Spread the scarce budget across an hour by default, so one manual auth
  // covers a long window unattended rather than burning out in six minutes.
  callBudget: num('CALL_BUDGET', 6),
  budgetWindowMin: num('BUDGET_WINDOW_MIN', 60),
};

fs.mkdirSync(config.outDir, { recursive: true });

const captured = []; // response bodies, for the services tree / labels
/** The authenticated date request, filled in the moment we see it. */
let hit = null;

function launch() {
  const opts = {
    headless: config.headless,
    executablePath: config.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  return chromium.launch(opts);
}

async function main() {
  const browser = await launch();
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK' });
  const page = await context.newPage();

  const authenticated = new Promise((resolve) => {
    page.on('response', async (response) => {
      const url = response.url();
      // Detect by the endpoint marker, not the host — the marker is specific,
      // and gating on the host silently ignores everything in a local test.
      try {
        const body = await response.text();
        captured.push({ url, body });
        if (url.includes(config.dateMarker) && response.status() === 200 && !hit) {
          const request = response.request();
          hit = {
            url,
            method: request.method(),
            postData: request.postData() ?? '',
            headers: await request.allHeaders().catch(() => ({})),
          };
          resolve();
        }
      } catch {
        // body already gone (redirect); ignore
      }
    });
  });

  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n=================================================================');
  console.log(' HUNT — do only what a human must, then put the phone away.');
  console.log('=================================================================');
  console.log(' In the browser window:');
  console.log('   1. solve the CAPTCHA');
  console.log('   2. enter the SMS code');
  console.log('   3. pick the service and office until the DATES appear');
  console.log('\n Nothing to press here — the moment the dates load, this takes over.');
  console.log(` (waiting up to ${config.authTimeoutMin} min)\n`);

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timed out waiting for the date step')), config.authTimeoutMin * 60_000),
  );

  try {
    await Promise.race([authenticated, timeout]);
  } catch (err) {
    console.error(`\n${err.message}. Nothing captured — closing.`);
    await browser.close().catch(() => {});
    process.exit(1);
  }

  console.log('\nGot it — the session reached the date step. Wiring up the monitor...');

  const headers = hit.headers;
  const cookie = headers.cookie ?? '';
  if (!cookie) {
    console.error('The authenticated request carried no cookie — cannot replay. Closing.');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  const csrf = Object.entries(headers).find(([name]) => /csrf|xsrf/i.test(name));

  // Label the one service we are watching, if the services tree was seen.
  const decoded = decodeURIComponent(hit.postData);
  const serviceId = (decoded.match(/"serviceBranchID"\s*:\s*"([^"]+)"/) ?? [])[1] ?? null;
  const services = captured.flatMap((c) => extractServices(c.body));
  const label = serviceId ? services.find((s) => s.id === serviceId)?.name : null;
  if (label) console.log(`  watching: ${label}`);

  // A single-service rotation file, so the alert names the service and the
  // cache-buster keeps successive requests from being byte-identical.
  let bodiesLine = envLine('REQUEST_BODY', hit.postData);
  if (serviceId) {
    const file = path.join(config.outDir, 'request-bodies-hunt.txt');
    const header = `# ${serviceId}  ${label ?? '(service)'}`;
    fs.writeFileSync(file, `${header}\n${hit.postData}\n`, 'utf8');
    bodiesLine = envLine('REQUEST_BODIES_FILE', file);
  }

  const carried = readEnvValues(['.env', '.env.captured'], ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

  const lines = [
    '# Written by scripts/hunt.js',
    `# ${new Date().toISOString()}`,
    '',
    envLine('TARGET_URL', hit.url),
    envLine('METHOD', hit.method),
    envLine('COOKIE_HEADER', cookie),
    envLine('CSRF_HEADER_NAME', csrf ? csrf[0] : 'X-CSRF-TOKEN'),
    envLine('CSRF_TOKEN', csrf ? csrf[1] : ''),
    bodiesLine,
    envLine('CONTENT_TYPE', headers['content-type'] ?? 'application/x-www-form-urlencoded; charset=UTF-8'),
    envLine('REFERER', headers.referer ?? config.startUrl),
    envLine('ORIGIN', headers.origin ?? new URL(hit.url).origin),
    envLine('USER_AGENT', headers['user-agent'] ?? ''),
    envLine('SLOT_JSON_PATH', 'services'),
    '',
    '# Budget is spent after ~6 calls and does not recover, so spread it.',
    envLine('CALL_BUDGET', String(config.callBudget)),
    envLine('BUDGET_WINDOW_MIN', String(config.budgetWindowMin)),
    '',
    carried.TELEGRAM_BOT_TOKEN ? envLine('TELEGRAM_BOT_TOKEN', carried.TELEGRAM_BOT_TOKEN) : '# TELEGRAM_BOT_TOKEN=',
    carried.TELEGRAM_CHAT_ID ? envLine('TELEGRAM_CHAT_ID', carried.TELEGRAM_CHAT_ID) : '# TELEGRAM_CHAT_ID=',
    '',
  ];

  fs.writeFileSync('.env', lines.join('\n'), 'utf8');
  console.log('  wrote .env');
  if (!carried.TELEGRAM_CHAT_ID) console.log('  (no Telegram configured — you will only see alerts on this screen)');

  // The session lives in the cookies now, not the browser, so free it.
  await browser.close().catch(() => {});

  console.log('\nStarting the monitor. Leave this running; put the phone away.\n');

  // config.js pulled the OLD .env into our process.env at import time. The child
  // would inherit those stale values, and dotenv does not override an existing
  // env var — so the monitor would silently poll the previous session's target.
  // Strip every key we just wrote (plus its siblings) so the child reads them
  // fresh from the .env we just produced.
  const writtenKeys = new Set(lines.map((l) => (l.match(/^([A-Z_]+)=/) ?? [])[1]).filter(Boolean));
  for (const sibling of ['REQUEST_BODY', 'REQUEST_BODY_FILE', 'INTERVAL_MS', 'JITTER_MS']) {
    writtenKeys.add(sibling);
  }
  const childEnv = { ...process.env };
  for (const key of writtenKeys) delete childEnv[key];

  const child = spawn(process.execPath, ['monitor.js'], { stdio: 'inherit', env: childEnv });
  child.on('close', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`\nFatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
