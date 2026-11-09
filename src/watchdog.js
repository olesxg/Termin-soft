/**
 * How long to wait before the next re-login attempt.
 *
 * An empty pool used to get one attempt and then a wait with no end: at 13:58
 * on 2026-11-08 the window failed six seconds in (net::ERR_ABORTED), and the
 * monitor sat in silence until someone captured a session by hand. Nothing
 * was retried, nobody was reminded.
 *
 * An attempt that dies within seconds was not a human failing to answer — the
 * window broke — so it is worth trying again soon. One that ran its course
 * means nobody came, and asking again every few minutes would only be noise.
 * Quick retries are capped, so a browser that cannot start does not flash a
 * window every two minutes all night.
 */
export function nextAttemptDelay(durationMs, quickStreak, options = {}) {
  const { retryMs = 30 * 60_000, quickRetryMs = 2 * 60_000, quickMs = 2 * 60_000, maxQuick = 3 } = options;

  const quick = durationMs < quickMs;
  const streak = quick ? quickStreak + 1 : 0;
  const delayMs = quick && streak <= maxQuick ? quickRetryMs : retryMs;
  return { delayMs, quickStreak: streak };
}
