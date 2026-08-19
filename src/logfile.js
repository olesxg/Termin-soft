import { createWriteStream } from 'node:fs';

/**
 * Mirror console output into a file.
 *
 * Piping through `tee` instead looked equivalent but was not: a shell pipeline
 * reports the LAST command's status, so tee's 0 masked the monitor's exit 1 and
 * a dead session was announced as a clean finish. Writing the log from inside
 * the process keeps the exit code honest.
 */
export function mirrorConsoleTo(file) {
  if (!file) return () => {};

  const stream = createWriteStream(file, { flags: 'a' });
  stream.on('error', () => {}); // a broken log must never take the monitor down

  const originals = {};
  for (const method of ['log', 'warn', 'error']) {
    originals[method] = console[method].bind(console);
    console[method] = (...args) => {
      originals[method](...args);
      stream.write(`${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
    };
  }

  return () => {
    for (const [method, fn] of Object.entries(originals)) console[method] = fn;
    stream.end();
  };
}
