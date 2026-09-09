/**
 * Fill in the booking step for a slot the monitor just found, and stop.
 *
 * The race is lost in the seconds between the alert and the click: a slot seen
 * at 20:40 and again at 22:29 was taken both times before it could be reached
 * by hand. Everything up to the final button is mechanical — office, date,
 * time — so the monitor does that part and leaves the page one click from done.
 *
 * It deliberately does NOT press "Pokračovať". That button advances the wizard
 * towards an actual reservation, and a wrong automatic booking costs the queue
 * position it was meant to win.
 *
 * Selectors come from a real date step captured on 2026-08-27
 * (captured/date-step.html):
 *
 *   input#input-vyberPracoviska-<branchPublicId>   radio, office
 *   select#input-dostupneTerminyDatum              date, options "18.09.2026"
 *   input#input-dostupneTerminy-<HHMM>             radio, value "10:00"
 *   button[aria-label^="Pokračovať"]               left for the human
 *
 * The office radio's id suffix is the branchPublicId the date endpoint returns,
 * so the office the monitor found is the office that gets selected — no
 * guessing by name.
 */

export const SELECTORS = {
  office: (branchPublicId) => `input#input-vyberPracoviska-${branchPublicId}`,
  dateSelect: 'select#input-dostupneTerminyDatum',
  timeRadio: 'input[name="dostupneTerminy"]',
  continue: 'button[aria-label^="Pokraèova"], button[aria-label^="Pokračova"]',
};

/** First office/date pair in a detector sample, or null if the shape is unfamiliar. */
export function firstOffer(sample) {
  let parsed;
  try {
    parsed = typeof sample === 'string' ? JSON.parse(sample) : sample;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.services;
  if (!Array.isArray(list)) return null;

  for (const office of list) {
    const date = office?.dates?.[0];
    if (office?.branchPublicId && date) {
      return { branchPublicId: office.branchPublicId, date, officeName: office.officeName ?? '' };
    }
  }
  return null;
}

/**
 * @returns {Promise<{ok: boolean, step: string, detail?: string}>}
 *   ok:false never throws — a failed pre-fill must not stop the alarm or the
 *   watch. The banner and the Telegram push are what the user acts on; this is
 *   a shortcut on top of them, not a replacement.
 */
export async function prepareBooking(page, offer, { screenshotPath } = {}) {
  const step = async (name, fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return { ok: false, step: name, detail: err.message };
    }
  };

  const bringToFront = await step('focus', () => page.bringToFront());
  if (bringToFront) return bringToFront;

  const office = await step('office', () =>
    page.check(SELECTORS.office(offer.branchPublicId), { timeout: 5_000 }),
  );
  if (office) return office;

  const date = await step('date', () =>
    page.selectOption(SELECTORS.dateSelect, { label: offer.date }, { timeout: 5_000 }),
  );
  if (date) return date;

  // The time list is rendered after the date is chosen; take the first offered.
  const time = await step('time', async () => {
    await page.waitForSelector(SELECTORS.timeRadio, { timeout: 5_000 });
    await page.locator(SELECTORS.timeRadio).first().check({ timeout: 5_000 });
  });
  if (time) return time;

  if (screenshotPath) {
    await step('screenshot', () => page.screenshot({ path: screenshotPath, fullPage: false }));
  }

  return { ok: true, step: 'ready' };
}

/** "a=1; b=2" -> [{name,value}], tolerating stray spaces and empty segments. */
export function parseCookieHeader(header) {
  return String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}

/**
 * Open a browser carrying a captured session's cookies.
 *
 * The pool workflow closes each capture's browser so that twenty of them can be
 * taken in a row, which left nothing to pre-fill when a slot turned up — the
 * monitor runs in its own process and Playwright's --remote-debugging-pipe
 * makes attaching to someone else's browser impossible. So it opens its own.
 *
 * Whether the portal restores the wizard at the date step or drops you at step
 * one is up to the server: the flow's state lives in the session, not the URL.
 * Either way this beats having no window at all, and the cookies are the same
 * ones the monitor has been polling with successfully.
 */
export async function openSessionBrowser(chromium, session, startUrl, { executablePath } = {}) {
  const browser = await chromium.launch({
    headless: false,
    executablePath: executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK', userAgent: session.userAgent || undefined });

  const cookies = parseCookieHeader(session.cookie).map((c) => ({ ...c, url: 'https://portal.minv.sk/' }));
  if (cookies.length > 0) await context.addCookies(cookies);

  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  return { browser, page };
}
