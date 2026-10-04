import { normalize } from './detect.js';
import { collectInputs, locatorForInput } from './identity.js';

/**
 * The mechanical steps around the SMS code: type the PIN, pick the service,
 * pick the office.
 *
 * The CAPTCHA stays the human's — this waits for it to be solved rather than
 * touching it.
 */

const CONTINUE = /Pokra[čc]ova[ťt]/i;
const PIN_LABELS = ['kod z sms', 'sms kod', 'pin', 'kod'];
const CAPTCHA_TOKEN = 'textarea[name="g-recaptcha-response"]';

export const WIZARD_SELECTORS = {
  continueButton: 'button[aria-label^="Pokra"], button, a, input[type=button], input[type=submit]',
  officeRadio: 'input[id^="input-vyberPracoviska-"]',
  dateSelect: 'select#input-dostupneTerminyDatum',
  choice: 'input[type=radio], a[href], button, [role=radio]',
};

/**
 * Shortest matching label wins: a guessed label can swallow a whole paragraph,
 * and then it matches everything on the page.
 */
export function bestMatch(candidates, needle) {
  const want = normalize(needle ?? '');
  if (!want) return null;

  let best = null;
  for (const candidate of candidates ?? []) {
    const label = normalize(candidate?.label ?? '');
    if (!label || !label.includes(want)) continue;
    if (best === null || label.length < normalize(best.label).length) best = candidate;
  }
  return best;
}

/** Visible, clickable controls with whatever text identifies them. */
export async function collectChoices(page, selector = WIZARD_SELECTORS.choice) {
  return page.evaluate((css) => {
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };

    const labelOf = (el) => {
      if (el.id) {
        const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (tag?.innerText?.trim()) return tag.innerText.trim();
      }
      const wrapping = el.closest('label');
      if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.innerText?.trim()) return el.innerText.trim();
      const row = el.closest('tr, li, .row, div');
      return row?.innerText?.trim() ?? '';
    };

    const out = [];
    [...document.querySelectorAll(css)].forEach((el, index) => {
      if (!visible(el) || el.disabled) return;
      out.push({ index, id: el.id || null, label: labelOf(el).replace(/\s+/g, ' ').slice(0, 300) });
    });
    return out;
  }, selector);
}

/** Click the control whose label names `needle`. */
export async function choose(page, needle, options = {}) {
  const { selector = WIZARD_SELECTORS.choice, override = '', timeoutMs = 15_000 } = options;

  if (override) {
    await page.locator(override).first().click({ timeout: timeoutMs });
    return { ok: true, label: override };
  }

  const candidates = await collectChoices(page, selector);
  const match = bestMatch(candidates, needle);
  if (!match) return { ok: false, reason: `nothing on the page matches "${needle}"`, candidates };

  const target = match.id
    ? page.locator(`#${match.id.replace(/([^\w-])/g, '\\$1')}`)
    : page.locator(selector).nth(match.index);

  await target.first().click({ timeout: timeoutMs });
  return { ok: true, label: match.label };
}

/** The wizard's own "Pokračovať", never the one that confirms a booking. */
export async function clickContinue(page, { timeoutMs = 15_000 } = {}) {
  const button = page
    .locator('button, a, input[type=button], input[type=submit]')
    .filter({ hasText: CONTINUE })
    .first();

  if ((await button.count().catch(() => 0)) === 0) return false;
  await button.click({ timeout: timeoutMs });
  return true;
}

/** The reCAPTCHA token the widget writes once a human has solved it. */
export async function captchaToken(page) {
  return page
    .evaluate((css) => document.querySelector(css)?.value ?? '', CAPTCHA_TOKEN)
    .catch(() => '');
}

/**
 * Found by label, most specific first. No identity label contains "kod" or
 * "pin" — "Číslo cestovného dokladu" included — so the broad fallback is safe.
 */
export async function findPinInput(page) {
  const inputs = await collectInputs(page).catch(() => []);
  for (const needle of PIN_LABELS) {
    const match = bestMatch(inputs, needle);
    if (match) return match;
  }
  return null;
}

/**
 * Wait until the human has solved the CAPTCHA, then send the identity step.
 *
 * Either signal ends the wait: a token means it is solved, a PIN field means
 * the person already pressed the button and the SMS is out.
 *
 * @returns {Promise<'pin'|'submitted'|'timeout'>}
 */
export async function passCaptcha(page, { timeoutMs = 15 * 60_000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await findPinInput(page)) return 'pin';
    if (await captchaToken(page)) {
      await clickContinue(page).catch(() => false);
      await page.waitForTimeout(2500);
      return (await findPinInput(page)) ? 'pin' : 'submitted';
    }
    await page.waitForTimeout(pollMs);
  }
  return 'timeout';
}

/** Wait for the SMS field to appear, however the identity step was submitted. */
export async function waitForPinInput(page, { timeoutMs = 5 * 60_000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const input = await findPinInput(page);
    if (input) return input;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(pollMs);
  }
}

/** Type the code and submit it; typed key by key, as the form validates on keystrokes. */
export async function fillPin(page, code, options = {}) {
  const { override = '', delayMs = 40, timeoutMs = 15_000 } = options;

  const target = override ? page.locator(override).first() : null;
  if (!target) {
    const input = await waitForPinInput(page, { timeoutMs });
    if (!input) return { ok: false, reason: 'no SMS code field on the page' };

    const locator = locatorForInput(page, input);
    await locator.click({ timeout: timeoutMs });
    await locator.fill('');
    await locator.pressSequentially(String(code), { delay: delayMs });
  } else {
    await target.click({ timeout: timeoutMs });
    await target.fill('');
    await target.pressSequentially(String(code), { delay: delayMs });
  }

  const submitted = await clickContinue(page, { timeoutMs }).catch(() => false);
  return { ok: true, submitted };
}

/** The office radio and the date select only exist once the dates have loaded. */
export async function waitForDateStep(page, { timeoutMs = 2 * 60_000 } = {}) {
  const selector = `${WIZARD_SELECTORS.dateSelect}, ${WIZARD_SELECTORS.officeRadio}`;
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Tick the office radio, so the window is left one click from a booking. */
export async function chooseOffice(page, needle, options = {}) {
  if (!needle) return { ok: false, reason: 'no office configured' };
  return choose(page, needle, { selector: WIZARD_SELECTORS.officeRadio, ...options });
}
