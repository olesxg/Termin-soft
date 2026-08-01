#!/usr/bin/env node
/**
 * Variant 2 — browser automation.
 *
 * Use this when the API session dies too fast or the tokens rotate. A real
 * Chromium window opens, you solve the CAPTCHA and type the SMS code by hand
 * (once), press ENTER in this terminal, and from then on the script pokes the
 * page's own JavaScript on a loop.
 *
 * It never reloads and never navigates — a reload is exactly what resets the
 * wizard and costs you another SMS.
 */
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { str, num, bool, list, nextDelay, ts } from './src/config.js';
import { detectSlots } from './src/detect.js';
import { raiseSlotAlarm, notifyTelegram } from './src/alert.js';

const config = {
  startUrl: str('START_URL', 'https://pes.minv.sk/'),
  userDataDir: str('USER_DATA_DIR'),
  executablePath: str('CHROMIUM_EXECUTABLE_PATH'),
  slowMoMs: num('SLOW_MO_MS', 0),
  // You need a visible window to solve the CAPTCHA, so this stays false.
  // Only useful on a headless box where you drive the browser over VNC/xvfb.
  headless: bool('HEADLESS', false),

  intervalMs: num('BROWSER_INTERVAL_MS', 20_000),
  jitterMs: num('JITTER_MS', 3_000),
  settleMs: num('CHECK_SETTLE_MS', 2_500),

  // How to make the page re-ask the server: none | click | reselect | eval
  triggerMode: str('TRIGGER_MODE', 'none'),
  triggerSelector: str('TRIGGER_SELECTOR'),
  triggerAltValue: str('TRIGGER_ALT_VALUE'),
  triggerJs: str('TRIGGER_JS'),

  apiUrlPattern: str('API_URL_PATTERN'),
  scopeSelector: str('SCOPE_SELECTOR'),
  slotSelector: str('SLOT_SELECTOR'),

  noSlotsPhrases: list('NO_SLOTS_TEXT', ['Nie sú momentálne dostupné žiadne termíny']),
  slotPhrases: list('SLOT_TEXT', []),
  jsonPath: str('SLOT_JSON_PATH'),

  inconclusiveIsSlot: bool('TREAT_INCONCLUSIVE_AS_SLOT', false),
  screenshotDir: str('SCREENSHOT_DIR', 'screenshots'),
  heartbeatEvery: num('HEARTBEAT_EVERY', 10),
};

/** Last XHR/fetch body whose URL matched API_URL_PATTERN. */
const lastApiResponse = { body: null, url: null, at: 0 };

function watchApiTraffic(page) {
  if (!config.apiUrlPattern) return;

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes(config.apiUrlPattern)) return;
    try {
      lastApiResponse.body = await response.text();
      lastApiResponse.url = url;
      lastApiResponse.at = Date.now();
    } catch {
      // body already discarded (redirect, or the page moved on) — ignore
    }
  });
}

async function triggerCheck(page) {
  switch (config.triggerMode) {
    case 'none':
      return;

    case 'click': {
      if (!config.triggerSelector) throw new Error('TRIGGER_MODE=click needs TRIGGER_SELECTOR');
      await page.click(config.triggerSelector, { timeout: 10_000 });
      return;
    }

    case 'reselect': {
      if (!config.triggerSelector) throw new Error('TRIGGER_MODE=reselect needs TRIGGER_SELECTOR');
      // Flip the dropdown to another option and straight back. The wizard's own
      // change handler fires the AJAX for us — no reload, no lost session.
      await page.evaluate(
        ({ selector, altValue }) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`selector not found: ${selector}`);
          const original = el.value;
          const options = Array.from(el.options ?? []).map((o) => o.value);
          const other = altValue || options.find((v) => v && v !== original);
          if (other === undefined) throw new Error(`no alternative option in ${selector}`);

          const fire = (value) => {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          fire(other);
          fire(original);
        },
        { selector: config.triggerSelector, altValue: config.triggerAltValue },
      );
      return;
    }

    case 'eval': {
      if (!config.triggerJs) throw new Error('TRIGGER_MODE=eval needs TRIGGER_JS');
      await page.evaluate(config.triggerJs);
      return;
    }

    default:
      throw new Error(`unknown TRIGGER_MODE "${config.triggerMode}" (none|click|reselect|eval)`);
  }
}

async function readPageText(page) {
  const selector = config.scopeSelector;
  if (!selector) return page.innerText('body');
  const el = await page.$(selector);
  if (!el) return page.innerText('body');
  return el.innerText();
}

async function checkOnce(page, roundStartedAt) {
  // The XHR body is the truth when we have it; the rendered text is the fallback.
  if (lastApiResponse.body && lastApiResponse.at >= roundStartedAt) {
    const result = detectSlots(lastApiResponse.body, config);
    if (result.available !== null) {
      return { ...result, source: `xhr ${lastApiResponse.url}` };
    }
  }

  if (config.slotSelector) {
    const count = await page.locator(config.slotSelector).count();
    if (count > 0) {
      return { available: true, reason: `${count} node(s) match SLOT_SELECTOR`, source: 'dom' };
    }
  }

  const text = await readPageText(page);
  const result = detectSlots(text, config);

  // With a slot selector configured, "no matches + no phrase" is a real negative,
  // not an inconclusive one.
  if (result.available === null && config.slotSelector) {
    return { available: false, reason: 'no SLOT_SELECTOR match', source: 'dom' };
  }
  return { ...result, source: 'dom' };
}

async function launch() {
  const options = {
    headless: config.headless,
    slowMo: config.slowMoMs || undefined,
    executablePath: config.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  };

  if (config.userDataDir) {
    const context = await chromium.launchPersistentContext(config.userDataDir, {
      ...options,
      viewport: null,
      locale: 'sk-SK',
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, close: () => context.close() };
  }

  const browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK' });
  const page = await context.newPage();
  return { context, page, close: () => browser.close() };
}

async function main() {
  console.log('Termín monitor — browser mode');
  console.log(`  start url : ${config.startUrl}`);
  console.log(`  interval  : ${config.intervalMs / 1000}s`);
  console.log(`  trigger   : ${config.triggerMode}${config.triggerSelector ? ` (${config.triggerSelector})` : ''}\n`);

  const { page, close } = await launch();
  watchApiTraffic(page);
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(
    '\n>>> Solve the CAPTCHA and enter the SMS code in the browser window.\n' +
      '>>> Walk the wizard up to the step that lists the dates.\n' +
      '>>> Then press ENTER here to start monitoring (the page will NOT be reloaded).\n',
  );
  rl.close();

  const urlAtStart = page.url();
  console.log(`\nMonitoring from ${urlAtStart}\n`);

  let rounds = 0;
  let consecutiveErrors = 0;

  for (;;) {
    rounds += 1;
    const roundStartedAt = Date.now();

    try {
      if (page.isClosed()) {
        console.error('\nThe page was closed. Nothing left to watch.');
        break;
      }

      // Cheap activity so the server-side session does not idle out.
      await page.mouse.move(5 + (rounds % 20), 5 + (rounds % 20));

      await triggerCheck(page);
      await page.waitForTimeout(config.settleMs);

      const result = await checkOnce(page, roundStartedAt);
      consecutiveErrors = 0;

      if (result.available === true) {
        await page.bringToFront().catch(() => {});

        let shot = '';
        try {
          await fs.mkdir(config.screenshotDir, { recursive: true });
          shot = path.join(config.screenshotDir, `slot-${Date.now()}.png`);
          await page.screenshot({ path: shot, fullPage: true });
        } catch (err) {
          console.error(`  (screenshot failed: ${err.message})`);
          shot = '';
        }

        await raiseSlotAlarm([
          `reason: ${result.reason}`,
          `source: ${result.source}`,
          result.sample ? `data  : ${result.sample}` : 'switch to the Chromium window and book it',
          shot ? `shot  : ${shot}` : '',
        ].filter(Boolean));

        console.log('Loop stopped, browser left open. Click through and book it. Ctrl+C when done.');
        return; // browser stays open on purpose
      }

      if (result.available === null) {
        console.warn(`\n[${ts()}] round ${rounds} inconclusive — ${result.reason}`);
        if (result.sample) console.warn(`         text: ${result.sample.slice(0, 200)}`);
        if (config.inconclusiveIsSlot) {
          console.warn('         TREAT_INCONCLUSIVE_AS_SLOT is on — alarming anyway.');
          await raiseSlotAlarm(['inconclusive but flagged', `reason: ${result.reason}`]);
          return;
        }
      } else if (rounds === 1 || rounds % config.heartbeatEvery === 0) {
        console.log(`[${ts()}] round ${rounds} — no slots (${result.reason}, via ${result.source})`);
      } else {
        process.stdout.write('.');
      }

      if (page.url() !== urlAtStart) {
        console.warn(`\n[${ts()}] URL changed to ${page.url()} — the wizard may have reset you.`);
        await notifyTelegram('⚠️ Termín monitor: the browser navigated away, session may be lost.');
      }
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`\n[${ts()}] round ${rounds} failed: ${err.message} (${consecutiveErrors}/5)`);
      if (consecutiveErrors >= 5) {
        await notifyTelegram('⛔️ Termín monitor (browser) gave up after 5 consecutive errors.');
        console.error('Five failures in a row — check TRIGGER_SELECTOR and the page state.');
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, nextDelay(config.intervalMs, config.jitterMs)));
  }

  if (bool('CLOSE_BROWSER_ON_EXIT', false)) await close();
}

main().catch((err) => {
  console.error(`\nFatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
