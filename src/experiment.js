import { appendFileSync } from 'node:fs';

/**
 * The call-budget hypotheses, measured rather than remembered — the budget is
 * documented as both ~4 and ~6 in this repository for want of exactly this.
 *
 * One JSON object per line: labels, ages, counts and verdicts, no cookies and
 * no identity, so the file is safe to keep and to paste.
 */

/** Append one row; a broken log must never take the monitor down. */
export function record(file, row) {
  if (!file) return false;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Hypothesis 3: `tida` looks like a tab id, so the counter may be per tab. */
export function withTabId(url, tabId) {
  const text = String(url ?? '');
  if (/[?&]tida=/.test(text)) return text.replace(/([?&]tida=)[^&]*/, `$1${tabId}`);
  return `${text}${text.includes('?') ? '&' : '?'}tida=${tabId}`;
}

/** Next tab id this session has not tried yet, or null when they are spent. */
export function nextTabId(session, values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const tried = new Set(session?.triedTabIds ?? []);
  return values.find((value) => !tried.has(String(value))) ?? null;
}

/** Note a tab id as tried, so the rotation cannot loop over the same one. */
export function markTabId(session, tabId) {
  session.triedTabIds = [...(session.triedTabIds ?? []), String(tabId)];
  session.tabId = String(tabId);
  return session;
}

/** The three numbers that answer the hypotheses: calls managed, refreshes behind them, age at death. */
export function summarise(rows) {
  const sessions = new Map();

  for (const row of rows) {
    if (!row?.label) continue;
    if (!sessions.has(row.label)) {
      sessions.set(row.label, {
        label: row.label,
        dateCalls: 0,
        refreshes: 0,
        refreshFailures: 0,
        callsBeforeLimit: null,
        ageAtDeathMin: null,
        reason: null,
      });
    }
    const session = sessions.get(row.label);

    if (row.kind === 'date') {
      session.dateCalls = row.dateCalls ?? session.dateCalls + 1;
      if (row.outcome === 'call-limit' && session.callsBeforeLimit === null) {
        session.callsBeforeLimit = session.dateCalls;
      }
    }
    if (row.kind === 'refresh') {
      if (row.ok) session.refreshes += 1;
      else session.refreshFailures += 1;
    }
    if (row.kind === 'retire') {
      session.reason = row.reason ?? null;
      session.ageAtDeathMin = row.ageMin ?? null;
      if (row.dateCalls !== undefined) session.dateCalls = row.dateCalls;
    }
  }

  const all = [...sessions.values()];
  const withRefresh = all.filter((s) => s.refreshes > 0);
  const without = all.filter((s) => s.refreshes === 0);
  const mean = (list) => {
    const numbers = list.map((s) => s.dateCalls).filter((n) => n > 0);
    if (numbers.length === 0) return null;
    return Math.round((numbers.reduce((a, b) => a + b, 0) / numbers.length) * 10) / 10;
  };

  return {
    sessions: all,
    callsWithRefresh: mean(withRefresh),
    callsWithoutRefresh: mean(without),
    deathAges: all.map((s) => s.ageAtDeathMin).filter((age) => age !== null),
  };
}
