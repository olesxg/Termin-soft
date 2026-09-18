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
export async function prepareBooking(page, offer, { screenshotPath, officeTimeoutMs = 10 * 60_000 } = {}) {
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

  // A browser opened on a session's cookies lands wherever the portal decides,
  // and that is usually step one — so the office radio does not exist yet. It
  // appears only once the human has done the CAPTCHA and the SMS. Failing after
  // five seconds meant the pre-fill never had a chance and everything was left
  // to be retyped by hand; waiting is the whole point.
  const office = await step('office', async () => {
    await page.waitForSelector(SELECTORS.office(offer.branchPublicId), { timeout: officeTimeoutMs });
    await page.check(SELECTORS.office(offer.branchPublicId), { timeout: 5_000 });
  });
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
/**
 * Write down every call this page makes to the portal.
 *
 * Booking cannot be automated while the request that creates a reservation has
 * never been seen: no capture has ever gone past the date step, and the portal's
 * own bundle is obfuscated — every resource id is a lookup into an encoded
 * string array, so "create-pincode" and "offices-service-date" do not appear in
 * it as text. Guessing the endpoint would mean firing an invented POST carrying
 * real identity data at a government backend, which is not something to try.
 *
 * Observing it costs nothing, though, and does not even need the booking to
 * succeed: pressing "Pokračovať" sends the request whether the slot is still
 * free or already taken. One press — won or lost — and the id and payload are
 * known exactly, including any token the step carries.
 *
 * capture-session already records its own window. This is the window the
 * monitor opens, which until now recorded nothing.
 */
export function recordRequests(page, file, { fs, maxBodyChars = 20_000 } = {}) {
  if (!file || !fs) return;

  page.on('response', async (response) => {
    const request = response.request();
    const url = response.url();
    if (!/minv\.sk/.test(url)) return;
    if (!['xhr', 'fetch', 'document'].includes(request.resourceType())) return;

    let body = '';
    try {
      body = (await response.text()).slice(0, maxBodyChars);
    } catch {
      // body already discarded — the metadata is the valuable part anyway
    }

    const entry = {
      at: new Date().toISOString(),
      method: request.method(),
      url,
      status: response.status(),
      resourceId: (url.match(/res\/id=([^/]+)/) ?? [])[1] ?? null,
      requestHeaders: await request.allHeaders().catch(() => ({})),
      postData: request.postData() ?? '',
      responseBody: body,
    };

    try {
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // never let bookkeeping break a booking in progress
    }
  });
}

export async function openSessionBrowser(chromium, session, startUrl, { executablePath, recordTo, fs } = {}) {
  const browser = await chromium.launch({
    headless: false,
    executablePath: executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: null, locale: 'sk-SK', userAgent: session.userAgent || undefined });

  const cookies = parseCookieHeader(session.cookie).map((c) => ({ ...c, url: 'https://portal.minv.sk/' }));
  if (cookies.length > 0) await context.addCookies(cookies);

  const page = await context.newPage();
  recordRequests(page, recordTo, { fs });
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  return { browser, page };
}
