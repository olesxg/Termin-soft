#!/usr/bin/env node
/**
 * Wait until the portal is worth an SMS, then say so on the phone.
 *
 * Sessions have been lost by capturing during a brief window when
 * portal.minv.sk happened to be up: it then went down for three hours and the
 * session expired with nothing able to keep it warm. The CAPTCHA and SMS are
 * the expensive part, so the useful question is not "is it up right now" but
 * "tell me when it is up and staying up".
 *
 *   npm run preflight           wait for it to come back, then Telegram
 *   npm run preflight -- --once one window, verdict, exit 0/1
 *
 * Only the public landing page is fetched — no session, no call budget, so this
 * can sit running for hours without costing anything.
 */
import { str, num } from '../src/config.js';
import { notifyTelegram } from '../src/alert.js';

const TARGET = str('PREFLIGHT_URL', 'https://portal.minv.sk/');
const WINDOW_MIN = num('PREFLIGHT_MINUTES', 5);
const EVERY_MS = num('PREFLIGHT_INTERVAL_MS', 20_000);
const BOOK_URL = str('BOOK_URL', 'https://portal.minv.sk/wps/portal/domov/ecu/ecu_elektronicke_sluzby/ecu-vysys/');
const ONCE = process.argv.includes('--once');

const probes = Math.max(2, Math.round((WINDOW_MIN * 60_000) / EVERY_MS));
const clock = () => new Date().toLocaleTimeString('sk-SK', { hour12: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function humanDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

async function probe() {
  const started = Date.now();
  try {
    const res = await fetch(TARGET, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'sk-SK,sk;q=0.9' },
      signal: AbortSignal.timeout(20_000),
    });
    return { ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: err.cause?.code ?? err.name, ms: Date.now() - started };
  }
}

/** One full window. Every probe must pass for the portal to count as steady. */
async function runWindow() {
  const results = [];
  for (let i = 1; i <= probes; i += 1) {
    const r = await probe();
    results.push(r);
    console.log(`  [${clock()}] ${i}/${probes}  ${r.ok ? 'ok' : 'FAIL'}  ${r.status}  ${r.ms}ms`);
    if (!r.ok) return results; // no point finishing a window already spoilt
    if (i < probes) await sleep(EVERY_MS);
  }
  return results;
}

/**
 * Poll until one request gets through.
 *
 * Kept separate from the confirmation window so a return is noticed within one
 * interval rather than after a whole failed window, and so that hours of
 * downtime do not print thousands of identical lines: failures are summarised
 * periodically instead.
 */
async function waitForFirstSign(downSince) {
  let attempts = 0;
  let lastReport = Date.now();

  for (;;) {
    const r = await probe();
    attempts += 1;

    if (r.ok) {
      console.log(`\n  [${clock()}] answered ${r.status} in ${r.ms}ms after ${attempts} tries — checking it holds...\n`);
      return;
    }

    // Roughly every five minutes, not every probe.
    if (attempts === 1 || Date.now() - lastReport >= 5 * 60_000) {
      lastReport = Date.now();
      console.log(
        `  [${clock()}] still down (${r.status}) — ${attempts} tries, ${humanDuration(Date.now() - downSince)} so far`,
      );
    }
    await sleep(EVERY_MS);
  }
}

console.log(`Preflight: ${TARGET}`);
console.log(`Steady means ${probes} clean probes ${EVERY_MS / 1000}s apart (${WINDOW_MIN} min).`);
console.log('Public page only — this costs no session and no call budget.');

const telegramReady = Boolean(str('TELEGRAM_BOT_TOKEN') && str('TELEGRAM_CHAT_ID'));
if (!ONCE) {
  console.log(
    telegramReady
      ? 'Waiting until it is back. Telegram will tell you — Ctrl+C to stop.\n'
      : 'Waiting until it is back. NO TELEGRAM CONFIGURED, so watch this window.\n',
  );
}

const startedAt = Date.now();
let waited = false;

for (;;) {
  const results = await runWindow();
  const good = results.filter((r) => r.ok).length;

  if (good === results.length) {
    console.log(`\n  ${good}/${probes} clean — STEADY.`);

    // Only worth a push if it actually had to be waited for; if it was up from
    // the first probe, the person is looking at this window anyway.
    if (waited && telegramReady) {
      const sent = await notifyTelegram(
        [
          '✅ Portál ожив — можна знімати сесію.',
          '',
          `Лежав ${humanDuration(Date.now() - startedAt)}.`,
          `Перевірено: ${probes} чистих запитів за ${WINDOW_MIN} хв.`,
          '',
          'На ПК:  npm run capture',
          BOOK_URL,
        ].join('\n'),
      );
      // Never claim it was sent when it was not: this is the one message the
      // whole wait exists to deliver, and a wrong token would otherwise look
      // like success while the phone stays silent.
      console.log(sent ? '  Telegram sent.' : '  Telegram NOT sent — fix the token, the portal is up NOW.');
    }

    console.log('\n  npm run capture\n');
    process.exit(0);
  }

  if (ONCE) {
    console.log(`\n  ${good}/${probes} — NOT STEADY. Capturing now risks losing the SMS to an outage.\n`);
    process.exit(1);
  }

  waited = true;
  await waitForFirstSign(startedAt);
}
