import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export const STATUS_FILE = '.monitor-status.json';

/**
 * The monitor usually runs detached, so "is it alive and is it still finding
 * the endpoint?" has to be answerable from outside the process. It rewrites
 * this file every poll; `npm run health` reads it.
 */
export function writeStatus(patch) {
  let current = {};
  try {
    current = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    // first write, or someone deleted it — start fresh
  }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try {
    writeFileSync(STATUS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // never let bookkeeping take the monitor down
  }
  return next;
}

export function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function clearStatus() {
  try {
    unlinkSync(STATUS_FILE);
  } catch {
    // already gone
  }
}

/** True if a process with this pid is currently alive. */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}
