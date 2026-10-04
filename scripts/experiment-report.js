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

import { str } from '../src/config.js';
import { summarise } from '../src/experiment.js';

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
} else if (callsWithoutRefresh === null) {
  console.log(`  With refreshes: ${callsWithRefresh} calls on average. No plain session to compare against.`);
} else {
  console.log(`  with refreshes   : ${callsWithRefresh} date calls on average`);
  console.log(`  without          : ${callsWithoutRefresh} date calls on average`);
  const verdict =
    callsWithRefresh > callsWithoutRefresh * 1.5
      ? 'SUPPORTED — the refresh is buying calls. Lower SERVICES_REFRESH_EVERY and keep going.'
      : callsWithRefresh > callsWithoutRefresh
        ? 'unclear — better, but within noise. More sessions needed.'
        : 'NOT SUPPORTED — the counter is not in the wizard context. Fall back to re-login.';
  console.log(`  verdict          : ${verdict}`);
}

console.log('\nAge at death — is there a second, time-based limit?');
if (deathAges.length === 0) {
  console.log('  No session has died with a known capture time yet.');
} else {
  const sorted = [...deathAges].sort((a, b) => a - b);
  console.log(`  ${sorted.join(', ')} minutes (${sorted.length} session(s))`);
  const aged = sorted.filter((age) => age >= 55 && age <= 75).length;
  console.log(
    aged >= 2
      ? `  ${aged} of them died in the 55-75min window — consistent with a session that expires by age.`
      : '  No cluster around an hour yet. Keep sessions alive longer to tell age from calls.',
  );
}

console.log('');
