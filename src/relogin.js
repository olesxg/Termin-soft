import path from 'node:path';

import { extractServices } from './bodies.js';
import { readIdentity, fillIdentity, enterWizard, IDENTITY_FIELDS } from './identity.js';
import { sessionRecord } from './sessionfile.js';
import { findServicesStep } from './services-step.js';
import {
  choose, chooseOffice, clickContinue, fillPin, passCaptcha, waitForDateStep, waitForPinAccepted, waitForPinInput,
} from './wizard.js';

/**
 * A fresh login, driven as far as a machine honestly can: everything but the
 * CAPTCHA, which is waited for rather than touched.
 *
 * Shaped as "wait for the date request, helping where possible" rather than a
 * strict sequence — a step that cannot be found leaves the window to the human
 * and the session is captured either way.
 */

const DEFAULTS = {
  dateMarker: 'available-offices-service-date',
  overallMs: 30 * 60_000,
  captchaMs: 15 * 60_000,
  pinMs: 5 * 60_000,
  stepMs: 2 * 60_000,
};

function watchRequests(page, dateMarker) {
  const entries = [];
  let resolveDate;
  const dateRequest = new Promise((resolve) => {
    resolveDate = resolve;
  });

  page.on('response', async (response) => {
    const request = response.request();
    if (!['xhr', 'fetch', 'document'].includes(request.resourceType())) return;

    const url = response.url();
    if (!/minv\.sk/.test(url)) return;

    const entry = {
      at: new Date().toISOString(),
      method: request.method(),
      url,
      status: response.status(),
      pageUrl: page.url(),
      requestHeaders: await request.allHeaders().catch(() => ({})),
      postData: request.postData() ?? '',
      responseBody: '',
    };
    try {
      entry.responseBody = await response.text();
    } catch {
      // body already discarded — the request is still the valuable part
    }
    entries.push(entry);

    if (url.includes(dateMarker) && response.status() === 200 && entry.postData) resolveDate(entry);
  });

  return { entries, dateRequest };
}

/**
 * Save the page a step could not be found on.
 *
 * Every selector here was derived from one captured date step, and the first
 * live run already disproved one of them. A dump turns the next wrong guess
 * into a one-line fix instead of another lost SMS.
 *
 * Holds the prefilled identity, so it goes to the gitignored capture dir.
 */
async function dumpPage(page, { fs, dumpDir, log }, tag) {
  if (!fs || !dumpDir) return;
  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    const file = path.join(dumpDir, `relogin-${tag}-${Date.now()}.html`);
    fs.writeFileSync(file, await page.content(), 'utf8');
    log(`saved the page for diagnosis -> ${file}`);
  } catch (err) {
    log(`could not save the page: ${err.message}`);
  }
}

/** Never throws: every failure is reported and the window is left to a human. */
async function automate(page, options) {
  const { identity, service, office, readCode, notify, log, timeouts, overrides, pinSelector } = options;

  if (Object.keys(identity).length > 0) {
    if (await enterWizard(page).catch(() => false)) log('opened the form');
    const { filled, missed } = await fillIdentity(page, identity, { overrides }).catch(() => ({ filled: [], missed: [] }));
    log(`identity: ${filled.length} field(s) filled${missed.length > 0 ? `, by hand: ${missed.map((f) => f.label).join(', ')}` : ''}`);
  } else {
    log(`no ID_* values set — fill the form by hand (${IDENTITY_FIELDS.map((f) => f.env).join(', ')})`);
  }

  await notify(
    '🔐 Potrebná CAPTCHA. Anketa je vyplnená — vyrieš CAPTCHA v okne, ďalej to ide samo.\n' +
      'SMS prijde až po nej, takže kým o kód nepoprosím, žiadny nečakaj.',
  );

  const captcha = await passCaptcha(page, { timeoutMs: timeouts.captchaMs }).catch(() => 'timeout');
  log(`captcha: ${captcha}`);
  if (captcha === 'timeout') {
    log('CAPTCHA not solved in time — the window is yours');
    return;
  }

  // Only now can an SMS exist: the identity step has been accepted and the
  // portal has rendered the field it wants the code in. Asking any earlier is
  // asking for a code that was never sent.
  if (!(await waitForPinInput(page, { timeoutMs: timeouts.pinMs }))) {
    log('no SMS field appeared — the identity step was not accepted. Finish it in the window');
    await notify('⚠️ SMS sa neodoslala — anketu treba dokončiť v okne. Monitor ďalej čaká na sesiu.');
    await dumpPage(page, options, 'no-pin-field');
    return;
  }

  const code = readCode ? await readCode() : null;
  if (code) {
    const typed = await fillPin(page, code, { override: pinSelector }).catch((err) => ({ ok: false, reason: err.message }));
    log(typed.ok ? 'SMS code typed and submitted' : `could not type the code: ${typed.reason}`);
  } else {
    await notify(
      readCode
        ? '📲 Kód do chatu neprišiel — zadaj ho priamo v okne.'
        : '📲 SMS odoslaná. Zadaj kód priamo v okne.\n' +
            '(SMS_CODE_VIA_TELEGRAM=true a budem ho čítať z tohto chatu.)',
    );
    log('waiting for the code to be typed in the window');
  }

  // The service list does not exist until the code is accepted, so picking now
  // would match whatever prose on the PIN page happens to name the service.
  if (!(await waitForPinAccepted(page, { timeoutMs: timeouts.pinMs }))) {
    log('still on the code step — the window is yours');
    return;
  }

  if (service) {
    const picked = await choose(page, service, { timeoutMs: timeouts.stepMs }).catch((err) => ({ ok: false, reason: err.message }));
    log(picked.ok ? `service: ${picked.label}` : `service not picked: ${picked.reason}`);
    if (picked.ok) await clickContinue(page).catch(() => false);
    else await dumpPage(page, options, 'service-not-found');
  }

  if (await waitForDateStep(page, { timeoutMs: timeouts.stepMs })) {
    log('dates are on screen');
    if (office) {
      const picked = await chooseOffice(page, office).catch((err) => ({ ok: false, reason: err.message }));
      log(picked.ok ? `office: ${picked.label}` : `office not picked: ${picked.reason}`);
      if (!picked.ok) await dumpPage(page, options, 'office-not-found');
    }
  }
}

/**
 * @returns {Promise<{ok: boolean, session?: object, browser: object, page: object, reason?: string}>}
 */
export async function relogin(options = {}) {
  const {
    chromium,
    startUrl = 'https://pes.minv.sk/',
    executablePath = '',
    identity = readIdentity(),
    service = '',
    office = '',
    readCode = null,
    notify = async () => {},
    log = () => {},
    overrides = {},
    pinSelector = '',
    poolIndex = 1,
    fs = null,
    dumpDir = '',
    ...rest
  } = options;

  const timeouts = { ...DEFAULTS, ...rest };

  const browser = await chromium.launch({
    headless: false,
    executablePath: executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK' });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(timeouts.stepMs);
  page.setDefaultTimeout(timeouts.stepMs);

  const { entries, dateRequest } = watchRequests(page, timeouts.dateMarker);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  automate(page, {
    identity, service, office, readCode, notify, log, timeouts, overrides, pinSelector, fs, dumpDir,
  }).catch((err) => log(`automation stopped: ${err.message}`));

  const timedOut = Symbol('timed-out');
  const hit = await Promise.race([
    dateRequest,
    new Promise((resolve) => setTimeout(() => resolve(timedOut), timeouts.overallMs)),
  ]);

  if (hit === timedOut) {
    return { ok: false, browser, page, reason: `no date request in ${Math.round(timeouts.overallMs / 60_000)}min` };
  }

  let cookie = hit.requestHeaders?.cookie ?? '';
  try {
    const cookies = await context.cookies();
    if (cookies.length > 0) cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    // the window is gone — the cookie observed on the wire is the same session
  }
  if (!cookie) return { ok: false, browser, page, reason: 'the date request carried no cookie' };

  const session = sessionRecord({
    index: poolIndex,
    url: hit.url,
    method: hit.method,
    headers: hit.requestHeaders ?? {},
    cookie,
    userAgent: hit.requestHeaders?.['user-agent'] ?? '',
    body: hit.postData,
    referer: hit.pageUrl,
    services: entries.flatMap((entry) => extractServices(entry.responseBody)),
    servicesStep: findServicesStep(entries),
  });

  return { ok: true, session, browser, page };
}
