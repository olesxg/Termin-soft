#!/usr/bin/env node
/**
 * Where to point four calls.
 *
 *   npm run when
 *
 * Reads the monitor's own records — experiment.jsonl for every check it made,
 * monitor.log for the slots it announced, which reach further back. Touches
 * nothing on the portal, so it is free to run as often as you like.
 */
import fs from 'node:fs';

import { str, num } from '../src/config.js';
import {
  WEEKDAYS, eventsFromExperiment, hitsFromLog, dedupe, tally, blindHours, asRanges, hotspots, verdict,
} from '../src/timing.js';

const experimentFile = process.argv[2] ?? str('EXPERIMENT_LOG', 'experiment.jsonl');
const logFile = process.argv[3] ?? str('LOG_FILE', 'monitor.log');
const budget = num('CALL_BUDGET', 4);

function readJsonl(file) {
  try {
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
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const rows = readJsonl(experimentFile);
const log = readText(logFile);
const events = dedupe([...eventsFromExperiment(rows), ...hitsFromLog(log)]);

if (events.length === 0) {
  console.error(`\nNothing to read in ${experimentFile} / ${logFile}.`);
  console.error('Run the monitor for a while, then come back.\n');
  process.exit(1);
}

const counted = tally(events);
const spots = hotspots(counted);

const pad2 = (n) => String(n).padStart(2, '0');
const hourRange = ([from, to]) => (from === to ? `${pad2(from)}:00` : `${pad2(from)}:00–${pad2((to + 1) % 24)}:00`);

console.log(`\nПеревірки: ${counted.totalChecks}   знайдено слотів: ${counted.totalHits}`);
console.log(`Джерела: ${experimentFile}, ${logFile}\n`);

// Only hours anyone ever touched: a full 24-row grid is mostly zeroes and
// hides the three rows that carry the information.
const used = [...Array(24).keys()].filter((hour) => counted.checks.some((day) => day[hour] > 0));

console.log('  год   ' + WEEKDAYS.slice(1).concat(WEEKDAYS[0]).map((d) => d.padStart(4)).join(''));
for (const hour of used) {
  const cells = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const checks = counted.checks[day][hour];
    const hits = counted.hits[day][hour];
    if (checks === 0) return '   ·';
    return (hits > 0 ? `${checks}★` : `${checks}`).padStart(4);
  });
  console.log(`  ${pad2(hour)}:00${cells.join('')}`);
}
console.log('\n  число = перевірок, ★ = був слот, · = не дивився');

const blind = asRanges(blindHours(counted));
if (blind.length > 0) {
  console.log('\nСліпі зони — години, в які ти не дивився жодного разу:');
  console.log(`  ${blind.map(hourRange).join(', ')}`);
  console.log('  Слот не знайдеться там, куди ніхто не дивився.');
}

if (spots.length > 0) {
  console.log('\nДе слоти вже бували:');
  for (const spot of spots.slice(0, 5)) {
    console.log(`  ${WEEKDAYS[spot.day]} ${pad2(spot.hour)}:00 — ${spot.hits} з ${spot.checks} перевірок`);
  }
}

const out = verdict(counted, spots);
console.log(`\nВисновок:\n  ${out.text}`);

console.log(`\nБюджет: ${budget} перевірки на одну капчу. Рознеси їх так:`);
if (out.level === 'usable') {
  const top = spots[0];
  console.log(`  знімай сесію за ~15 хв до ${WEEKDAYS[top.day]} ${pad2(top.hour)}:00 і став BUDGET_WINDOW_MIN=60`);
} else if (blind.length > 0) {
  console.log(`  наступну сесію — у сліпу зону ${hourRange(blind[0])}, щоб закрити карту`);
} else {
  console.log('  карта вже рівномірна — просто став більше сесій у робочі години');
}
console.log('');
