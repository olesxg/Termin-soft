#!/usr/bin/env node
/**
 * `npm run health` — answers "is it still watching, and is it still working?"
 * for a monitor that is running detached somewhere else.
 *
 * Exit code 0 = healthy, 1 = needs attention. Safe to run any time; it makes
 * no request to the portal, so it cannot burn your rate limit.
 */
import { str } from '../src/config.js';
import { readStatus, isAlive } from '../src/status.js';

const status = readStatus();

if (!status) {
  console.log('No monitor has run in this directory yet.');
  console.log('Start one with:  npm run monitor');
  process.exit(1);
}

const now = Date.now();
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};
const secondsSince = (iso) => (iso ? (now - new Date(iso).getTime()) / 1000 : Infinity);

const running = isAlive(status.pid) && !status.stoppedAt;
// One missed poll is jitter; two means it is wedged.
const budget = ((status.intervalMs ?? 60_000) + (status.jitterMs ?? 15_000)) / 1000;
const stale = secondsSince(status.lastPingAt ?? status.startedAt) > budget * 2 + 30;

const problems = [];
if (!running) problems.push(status.stoppedAt ? `stopped (exit ${status.exitCode ?? '?'})` : 'process is gone');
else if (stale) problems.push(`no poll for ${ago(status.lastPingAt)} — expected one every ~${Math.round(budget)}s`);
if (String(status.lastResult ?? '').startsWith('rejected')) problems.push('the portal rejected the session');
if (!status.telegram) problems.push('Telegram is not configured — an alert would reach nobody');
// One is normal after a restart; a run of them means the backoff is losing.
if ((status.callLimitHits ?? 0) >= 3) {
  problems.push(`throttled ${status.callLimitHits}x in a row — polls are now minutes apart`);
}

const line = (k, v) => console.log(`  ${k.padEnd(14)} ${v}`);

console.log(`\n${status.lastResult === 'SLOT' ? '*** SLOT FOUND ***' : running && !stale ? 'HEALTHY' : 'NEEDS ATTENTION'}\n`);
line('state', running ? `running (pid ${status.pid})` : status.stoppedAt ? `stopped ${ago(status.stoppedAt)}` : 'not running');
line('started', `${ago(status.startedAt)}`);
line('last poll', `${ago(status.lastPingAt)}  (#${status.pings ?? 0})`);
line('last result', `${status.lastResult ?? '?'}${status.lastReason ? ` — ${status.lastReason}` : ''}`);
line('cadence', `every ${Math.round((status.intervalMs ?? 0) / 1000)}s + up to ${Math.round((status.jitterMs ?? 0) / 1000)}s jitter`);
line('throttled', `${status.callLimitHits ?? 0}x CALL_LIMIT`);
line('telegram', status.telegram ? `on -> chat ${str('TELEGRAM_CHAT_ID') || '(set)'}` : 'OFF');

if (status.slotFoundAt) {
  console.log(`\n  A slot was found ${ago(status.slotFoundAt)}: ${status.slotDetail ?? ''}`);
  console.log('  Open the portal and book it.');
}

if (problems.length > 0) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  - ${p}`);
  if (!running) console.log('\nRestart with:  npm run monitor');
  if (String(status.lastResult ?? '').startsWith('rejected')) {
    console.log('A rejected session cannot be revived — run: npm run capture');
  }
  console.log('');
  process.exit(1);
}

console.log('\nNothing to do — it is watching. Leave it running.\n');
