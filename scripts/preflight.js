#!/usr/bin/env node
/**
 * Is the portal steady enough to be worth an SMS?
 *
 * Two sessions have now been lost the same way: captured during a brief window
 * when portal.minv.sk was up, then killed when it went down for three hours and
 * the session expired with nothing able to keep it warm. The CAPTCHA and SMS
 * are the expensive part, so check before spending them.
 *
 *   npm run preflight          one window, verdict, exit 0 if clean
 *   npm run preflight -- --wait  keep going until a clean window happens
 *
 * Only the public landing page is fetched — no session, no call budget.
 */
import { str, num } from '../src/config.js';

const TARGET = str('PREFLIGHT_URL', 'https://portal.minv.sk/');
const WINDOW_MIN = num('PREFLIGHT_MINUTES', 5);
const EVERY_MS = num('PREFLIGHT_INTERVAL_MS', 20_000);
const WAIT = process.argv.includes('--wait');

const probes = Math.max(2, Math.round((WINDOW_MIN * 60_000) / EVERY_MS));
const clock = () => new Date().toLocaleTimeString('sk-SK', { hour12: false });

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

async function runWindow() {
  const results = [];
  for (let i = 1; i <= probes; i += 1) {
    const r = await probe();
    results.push(r);
    console.log(`  [${clock()}] ${i}/${probes}  ${r.ok ? 'ok' : 'FAIL'}  ${r.status}  ${r.ms}ms`);
    if (i < probes) await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
  }
  return results;
}

console.log(`Preflight: ${TARGET}`);
console.log(`Watching for ${WINDOW_MIN} min (${probes} probes, ${EVERY_MS / 1000}s apart).`);
console.log('Public page only — this costs no session and no call budget.\n');

for (;;) {
  const results = await runWindow();
  const good = results.filter((r) => r.ok).length;
  const slowest = Math.max(...results.map((r) => r.ms));

  console.log(`\n  ${good}/${results.length} succeeded, slowest ${slowest}ms`);

  if (good === results.length) {
    console.log('\nSTEADY — worth spending the SMS.');
    console.log('  npm run capture\n');
    process.exit(0);
  }

  console.log('\nNOT STEADY — the portal is dropping connections.');
  console.log('Capturing now risks losing the session (and the SMS) to an outage.');
  if (!WAIT) {
    console.log('Re-run with --wait to sit here until it settles.\n');
    process.exit(1);
  }
  console.log('Waiting, will try another window...\n');
}
