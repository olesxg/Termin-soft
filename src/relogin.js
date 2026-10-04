import { extractServices } from './bodies.js';
import { readIdentity, fillIdentity, enterWizard, IDENTITY_FIELDS } from './identity.js';
import { sessionRecord } from './sessionfile.js';
import { findServicesStep } from './services-step.js';
import { choose, chooseOffice, clickContinue, fillPin, passCaptcha, waitForDateStep, waitForPinInput } from './wizard.js';

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

/** Never throws: every failure is reported and the window is left to a human. */
async function automate(page, options) {
  const { identity, service, office, readCode, notify, log, timeouts, overrides } = options;

  if (Object.keys(identity).length > 0) {
    if (await enterWizard(page).catch(() => false)) log('opened the form');
    const { filled, missed } = await fillIdentity(page, identity, { overrides }).catch(() => ({ filled: [], missed: [] }));
    log(`identity: ${filled.length} field(s) filled${missed.length > 0 ? `, by hand: ${missed.map((f) => f.label).join(', ')}` : ''}`);
  } else {
    log(`no ID_* values set — fill the form by hand (${IDENTITY_FIELDS.map((f) => f.env).join(', ')})`);
  }

  await notify('🔐 Potrebná CAPTCHA — monitor otvoril okno a čaká. Solve it, the rest is automatic.');

  const captcha = await passCaptcha(page, { timeoutMs: timeouts.captchaMs }).catch(() => 'timeout');
  log(`captcha: ${captcha}`);
  if (captcha === 'timeout') return;

  if (!(await waitForPinInput(page, { timeoutMs: timeouts.pinMs }))) {
    log('no SMS field appeared — finish this step in the window');
    return;
  }

  const code = readCode ? await readCode() : null;
  if (code) {
    const typed = await fillPin(page, code).catch((err) => ({ ok: false, reason: err.message }));
    log(typed.ok ? 'SMS code typed and submitted' : `could not type the code: ${typed.reason}`);
  } else {
    await notify('📲 Napíš kód zo SMS sem do chatu (alebo ho zadaj priamo v okne).');
    log('waiting for the code to be typed in the window');
  }

  if (service) {
    const picked = await choose(page, service, { timeoutMs: timeouts.stepMs }).catch((err) => ({ ok: false, reason: err.message }));
    log(picked.ok ? `service: ${picked.label}` : `service not picked: ${picked.reason}`);
    if (picked.ok) await clickContinue(page).catch(() => false);
  }

  if (await waitForDateStep(page, { timeoutMs: timeouts.stepMs })) {
    log('dates are on screen');
    if (office) {
      const picked = await chooseOffice(page, office).catch((err) => ({ ok: false, reason: err.message }));
      log(picked.ok ? `office: ${picked.label}` : `office not picked: ${picked.reason}`);
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
    poolIndex = 1,
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

  automate(page, { identity, service, office, readCode, notify, log, timeouts, overrides }).catch((err) =>
    log(`automation stopped: ${err.message}`),
  );

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
