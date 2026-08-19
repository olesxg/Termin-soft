import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEnvText, readEnvValues } from '../src/envfile.js';

test('reads the quoting styles capture-session emits', () => {
  const v = parseEnvText([
    "TELEGRAM_BOT_TOKEN='123:AAE-abc_def'",
    'TELEGRAM_CHAT_ID="987654321"',
    'PLAIN=novalue_quotes',
  ].join('\n'));
  assert.equal(v.TELEGRAM_BOT_TOKEN, '123:AAE-abc_def');
  assert.equal(v.TELEGRAM_CHAT_ID, '987654321');
  assert.equal(v.PLAIN, 'novalue_quotes');
});

test('commented-out and empty keys are not values', () => {
  const v = parseEnvText('# TELEGRAM_CHAT_ID=\nTELEGRAM_BOT_TOKEN=\n#TELEGRAM_BOT_TOKEN=nope');
  assert.equal(v.TELEGRAM_CHAT_ID, undefined);
  assert.equal(v.TELEGRAM_BOT_TOKEN, undefined, 'empty must not count as configured');
});

test('a trailing comment is stripped from an unquoted value', () => {
  assert.equal(parseEnvText('REQUEST_BODY_FILE=captured/b.txt  # both quote types').REQUEST_BODY_FILE,
    'captured/b.txt');
});

test('a value containing = or # survives when quoted', () => {
  const v = parseEnvText(`COOKIE_HEADER='JSESSIONID=ab#cd; wizard=step4'`);
  assert.equal(v.COOKIE_HEADER, 'JSESSIONID=ab#cd; wizard=step4');
});

test('junk lines are skipped, not thrown on', () => {
  const v = parseEnvText('not a pair\n=novalue\n123BAD=x\n\n   \nOK=1');
  assert.deepEqual(v, { OK: '1' });
});

test('readEnvValues prefers the first file that has the key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const a = path.join(dir, 'a.env');
  const b = path.join(dir, 'b.env');
  fs.writeFileSync(a, "TELEGRAM_CHAT_ID='111'\n");
  fs.writeFileSync(b, "TELEGRAM_CHAT_ID='222'\nTELEGRAM_BOT_TOKEN='tok'\n");

  const found = readEnvValues([a, b], ['TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']);
  assert.equal(found.TELEGRAM_CHAT_ID, '111', 'first file wins');
  assert.equal(found.TELEGRAM_BOT_TOKEN, 'tok', 'falls through for keys it lacks');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing files are not an error', () => {
  assert.deepEqual(readEnvValues(['./definitely-not-here.env'], ['X']), {});
});
