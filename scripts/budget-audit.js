#!/usr/bin/env node
/**
 * Hypothesis 2: count what the BROWSER spent before the monitor got a turn.
 * If the wizard calls the date endpoint more than once per pass, the monitor
 * never had six calls — it had six minus whatever the clicking cost.
 *
 * Reads a capture log, so it costs nothing and needs no session:
 *
 *   npm run audit                       captured/requests.jsonl
 *   npm run audit -- a.jsonl b.jsonl    several captures at once
 */
import fs from 'node:fs';
import path from 'node:path';

import { str } from '../src/config.js';
import { extractServices } from '../src/bodies.js';
import { countDates } from '../src/rank.js';
import { findServicesStep } from '../src/services-step.js';

const MARKER = str('DATE_ENDPOINT_MARKER', 'available-offices-service-date');
const files = process.argv.slice(2);
const logs = files.length > 0 ? files : [path.join(str('CAPTURE_DIR', 'captured'), 'requests.jsonl')];

function readLog(file) {
  return fs
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
}

let audited = 0;
const totals = [];

for (const file of logs) {
  let rows;
  try {
    rows = readLog(file);
  } catch (err) {
    console.error(`Cannot read ${file}: ${err.message}`);
    continue;
  }
  audited += 1;

  const dateCalls = rows.filter((row) => String(row.url ?? '').includes(MARKER) && row.status === 200);
  const servicesCalls = rows.filter((row) => extractServices(row.responseBody).length > 0);

  console.log(`\n${file}`);
  console.log(`  requests recorded   : ${rows.length}`);
  console.log(`  services steps      : ${servicesCalls.length}`);
  console.log(`  date endpoint calls : ${dateCalls.length}`);

  dateCalls.forEach((row, i) => {
    const clock = String(row.at ?? '').slice(11, 19);
    console.log(`    #${i + 1}  ${clock}  ${countDates(row.responseBody)} dates  ${(row.postData ?? '').slice(0, 70)}`);
  });

  if (dateCalls.length > 1) {
    console.log(`  -> this walk spent ${dateCalls.length - 1} call(s) more than the one it needed.`);
  }
  if (servicesCalls.length > dateCalls.length) {
    console.log(
      `  -> ${servicesCalls.length} services steps for ${dateCalls.length} date calls: the step can be` +
        ' replayed without a date call following it, which is what hypothesis 1 relies on.',
    );
  }
  console.log(`  services step replayable: ${findServicesStep(rows) ? 'yes' : 'no'}`);

  totals.push(dateCalls.length);
}

if (audited === 0) {
  console.error('\nNothing audited. Run `npm run capture` first, or pass a log path.');
  process.exit(1);
}

if (totals.length > 1) {
  const sum = totals.reduce((a, b) => a + b, 0);
  console.log(`\nAcross ${totals.length} captures: ${totals.join(', ')} date calls, ${(sum / totals.length).toFixed(1)} on average.`);
}

console.log(
  '\nIf the count is above 1, do not click between services while capturing:' +
    '\neach extra call is one fewer check the monitor gets.\n',
);
