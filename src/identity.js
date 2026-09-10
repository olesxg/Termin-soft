import { normalize } from './detect.js';

/**
 * Fill the wizard's identity form so the human only has to do the CAPTCHA and
 * the SMS — the two things a human must do.
 *
 * Typing the same six fields by hand before every capture is the friction that
 * makes re-authenticating unpleasant, and re-authenticating is the routine case
 * here: a session dies after ~6 calls.
 *
 * Fields are found by their visible Slovak label rather than by a selector.
 * The portal is a WebSphere portlet — its ids are generated and change between
 * deployments, while "Meno" and "Priezvisko" do not. Every field also takes an
 * explicit selector override for when the guess is wrong.
 */

/** In the order the form presents them. `match` is compared diacritic-free. */
export const IDENTITY_FIELDS = [
  { key: 'name', env: 'ID_NAME', match: ['meno'], label: 'Meno' },
  { key: 'surname', env: 'ID_SURNAME', match: ['priezvisko'], label: 'Priezvisko' },
  { key: 'day', env: 'ID_BIRTH_DAY', match: ['den'], label: 'Deň' },
  { key: 'month', env: 'ID_BIRTH_MONTH', match: ['mesiac'], label: 'Mesiac' },
  { key: 'year', env: 'ID_BIRTH_YEAR', match: ['rok'], label: 'Rok' },
  { key: 'doc', env: 'ID_DOC_NUMBER', match: ['cestovneho dokladu', 'dokladu', 'cislo dokladu'], label: 'Číslo dokladu' },
  { key: 'phone', env: 'ID_PHONE', match: ['sms kontakt', 'telefon', 'sms'], label: 'SMS kontakt' },
  { key: 'email', env: 'ID_EMAIL', match: ['emailova adresa', 'email'], label: 'Email' },
];

/**
 * Assign each field the best free input.
 *
 * "Best" is the shortest matching label: when the label had to be guessed from
 * surrounding text it can swallow a whole paragraph, and such a blob matches
 * several fields at once. The tightest match is the intended one, and each
 * input is claimed only once so two fields cannot land in the same box.
 */
export function matchFields(inputs, fields = IDENTITY_FIELDS) {
  const taken = new Set();
  const pairs = [];

  for (const field of fields) {
    let best = null;
    for (const input of inputs) {
      if (taken.has(input.index)) continue;
      const label = normalize(input.label ?? '');
      if (!label) continue;
      if (!field.match.some((needle) => label.includes(normalize(needle)))) continue;
      if (best === null || label.length < normalize(best.label).length) best = input;
    }
    if (best) {
      taken.add(best.index);
      pairs.push({ field, input: best });
    } else {
      pairs.push({ field, input: null });
    }
  }
  return pairs;
}

/** Read the identity from the environment; blank fields are simply skipped. */
export function readIdentity(env = process.env) {
  const out = {};
  for (const field of IDENTITY_FIELDS) {
    const value = (env[field.env] ?? '').trim();
    if (value) out[field.key] = value;
  }
  return out;
}

/** Every visible text-ish input on the page, with the label we can see above it. */
async function collectInputs(page) {
  return page.evaluate(() => {
    const SKIP = new Set(['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'file']);

    const labelFor = (el) => {
      if (el.id) {
        const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const text = tag?.innerText?.trim();
        if (text) return text;
      }
      const wrapping = el.closest('label');
      if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.placeholder) return el.placeholder;

      // Nothing declared — take the nearest text that precedes the input.
      let node = el;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        let sibling = node.previousElementSibling;
        while (sibling) {
          const text = (sibling.innerText || sibling.textContent || '').trim();
          if (text) {
            const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
            if (lines.length > 0) return lines[lines.length - 1];
          }
          sibling = sibling.previousElementSibling;
        }
        node = node.parentElement;
      }
      return '';
    };

    const all = [...document.querySelectorAll('input, textarea')];
    const out = [];
    all.forEach((el, index) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP.has(type)) return;
      if (el.disabled || el.readOnly) return;
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      out.push({
        index,
        id: el.id || null,
        name: el.getAttribute('name') || null,
        type,
        label: labelFor(el),
        value: el.value || '',
      });
    });
    return out;
  });
}

/** A locator for an input we already identified, preferring a stable handle. */
function locatorFor(page, input) {
  if (input.id) return page.locator(`#${CSS_ESCAPE(input.id)}`);
  if (input.name) return page.locator(`[name="${input.name}"]`);
  return page.locator('input, textarea').nth(input.index);
}

/** Minimal CSS.escape for ids — Node has no CSS global. */
function CSS_ESCAPE(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}

/**
 * The consent page stands between the deep link and the form. Its button is
 * safe to press — it only accepts the reservation rules and opens step 1.
 *
 * The identically named button that CONFIRMS a booking is never touched: this
 * runs once, at the start, and only while no identity field exists yet.
 */
export async function enterWizard(page, { timeoutMs = 15_000 } = {}) {
  const inputs = await collectInputs(page).catch(() => []);
  if (matchFields(inputs).some((p) => p.input)) return false; // already on the form

  const button = page
    .locator('button, a, input[type=button], input[type=submit]')
    .filter({ hasText: /Pokra[čc]ova[ťt]/i })
    .first();

  if ((await button.count()) === 0) return false;

  await button.click({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

/**
 * Type the identity into the form.
 *
 * Typed key by key, not assigned: the portal validates as you type and a value
 * dropped straight into `.value` fires no keyboard events, so the field can
 * look filled while the wizard still considers it empty.
 */
export async function fillIdentity(page, identity, options = {}) {
  const { delayMs = 25, overrides = {} } = options;
  const filled = [];
  const missed = [];

  const inputs = await collectInputs(page);
  const pairs = matchFields(inputs);

  for (const { field, input } of pairs) {
    const value = identity[field.key];
    if (!value) continue;

    const override = overrides[field.env];
    const target = override ? page.locator(override).first() : input ? locatorFor(page, input) : null;

    if (!target || (await target.count().catch(() => 0)) === 0) {
      missed.push(field);
      continue;
    }

    try {
      await target.click({ timeout: 5000 });
      await target.fill('');
      await target.pressSequentially(String(value), { delay: delayMs });
      filled.push({ field, label: input?.label ?? override });
    } catch {
      missed.push(field);
    }
  }

  return { filled, missed, inputs };
}
