#!/usr/bin/env node
/**
 * Read the hypothesis log back and give a verdict.
 *
 *   npm run experiment
 *
 * The two questions it answers:
 *   1. does replaying the services step buy more date calls per session?
 *   2. does a session die of age — the 62-65 minute window — or of calls?
 *
 * Costs nothing: it reads a local file and never touches the portal.
 */
import fs from 'node:fs';

import { str, num } from '../src/config.js';
import { summarise } from '../src/experiment.js';

const baseline = num('CALL_BUDGET', 6);

/**
 * Three outcomes, not two. The services step is a different resource id from
 * the date endpoint (`id=reservation` vs `id=available-offices-service-date`),
 * and CALL_LIMIT was only ever measured on the second — so whether a refresh
 * spends date budget is itself unmeasured, and the counts answer it.
 */
function refreshVerdict(withRefresh, without, sessions) {
  if (withRefresh > without * 1.5) {
    return 'SUPPORTED — the refresh buys calls. Lower SERVICES_REFRESH_EVERY and keep going.';
  }

  const totals = sessions.map((s) => s.dateCalls + s.refreshes).filter((n) => n > 0);
  const withSteps = totals.length === 0 ? 0 : totals.reduce((a, b) => a + b, 0) / totals.length;

  if (withRefresh > without) return 'unclear — better, but within noise. More sessions needed.';
  if (withRefresh < without * 0.9 && withSteps >= without * 0.9) {
    return (
      'NOT SUPPORTED, and the refresh SHARES the counter — every replay costs a date call.' +
      '\n                     Turn SERVICES_REFRESH off; it is spending your budget for nothing.'
    );
  }
  return (
    'NOT SUPPORTED — the counter is not in the wizard context, but the refresh' +
    '\n                     did not cost date calls either. Fall back to re-login.'
  );
}

const file = process.argv[2] ?? str('EXPERIMENT_LOG', 'experiment.jsonl');

let rows;
try {
  rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
} catch (err) {
  console.error(`Cannot read ${file}: ${err.message}`);
  console.error('The monitor writes it as it runs — start one first.');
  process.exit(1);
}

if (rows.length === 0) {
  console.log(`${file} is empty — nothing measured yet.`);
  process.exit(0);
}

const { sessions, callsWithRefresh, callsWithoutRefresh, deathAges } = summarise(rows);
const refreshed = sessions.filter((session) => session.refreshes > 0);

console.log(`\n${file} — ${rows.length} rows, ${sessions.length} session(s)\n`);
console.log('  session            date calls  refreshes  died at  reason');
for (const session of sessions) {
  const age = session.ageAtDeathMin === null ? '      -' : `${String(session.ageAtDeathMin).padStart(5)}m`;
  console.log(
    `  ${session.label.padEnd(18)} ${String(session.dateCalls).padStart(10)}  ` +
      `${String(session.refreshes).padStart(9)}  ${age}  ${session.reason ?? 'still live'}`,
  );
}

console.log('\nHypothesis 1 — does replaying the services step buy more calls?');
if (callsWithRefresh === null) {
  console.log('  No session has run with SERVICES_REFRESH=true yet. Nothing to compare.');
} else {
  console.log(`  with refreshes   : ${callsWithRefresh} date calls on average`);
  console.log(
    callsWithoutRefresh === null
      ? `  without          : no plain session to compare against — using CALL_BUDGET=${baseline}`
      : `  without          : ${callsWithoutRefresh} date calls on average`,
  );
  console.log(`  verdict          : ${refreshVerdict(callsWithRefresh, callsWithoutRefresh ?? baseline, refreshed)}`);
}

/**
 * The question that decides whether this can run unattended at all.
 *
 * Measured 2026-09-03: three sessions captured within three minutes of each
 * other all answered {} between their 62nd and 65th minute. {} means the wizard
 * context was dropped — the same thing hypothesis 1 says the services step
 * builds. So if replaying that step rebuilds the context, it may restart the
 * hour as well as the call counter, and one CAPTCHA would cover a morning
 * rather than an hour. Split by refreshes, the ages answer it.
 */
console.log('\nAge at death — can a session outlive the ~65 minute ceiling?');

/**
 * A session that died of CALL_LIMIT at 14 minutes says nothing about the hour:
 * it never got near it. Only a session that ran long enough to meet the ceiling
 * can confirm or break it, so anything shorter counts as untested.
 */
const CEILING_MIN = 50;
const aged = (list) =>
  list
    .filter((session) => session.ageAtDeathMin !== null)
    .sort((a, b) => a.ageAtDeathMin - b.ageAtDeathMin);
const show = (list) =>
  list.map((s) => `${s.ageAtDeathMin}min (${/expired/i.test(s.reason ?? '') ? 'age' : 'calls'})`).join(', ');

const plain = aged(sessions.filter((session) => session.refreshes === 0));
const kept = aged(refreshed);
const oldestKept = kept.length === 0 ? null : kept[kept.length - 1].ageAtDeathMin;

if (deathAges.length === 0) {
  console.log('  No session has died with a known capture time yet.');
} else {
  if (plain.length > 0) console.log(`  without refreshes: ${show(plain)}`);
  if (kept.length > 0) console.log(`  with refreshes   : ${show(kept)}`);

  if (oldestKept === null) {
    console.log('  Nothing has run with SERVICES_REFRESH=true — the ceiling is untested.');
  } else if (oldestKept > 80) {
    console.log(`  A refreshed session reached ${oldestKept} min — the hour ceiling is NOT fixed.`);
    console.log('  This is the result that makes unattended running possible. Keep going.');
  } else if (oldestKept >= CEILING_MIN) {
    console.log(`  Refreshed sessions still die by ${oldestKept} min — the hour is a hard ceiling.`);
    console.log('  One CAPTCHA buys one hour, whatever else is done. Plan around that.');
  } else {
    console.log(`  The longest refreshed session only reached ${oldestKept} min — it died of calls,`);
    console.log(`  not of age, so the ceiling is still untested. Keep one alive past ${CEILING_MIN} min.`);
  }
}

console.log('');
