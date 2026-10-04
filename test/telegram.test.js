import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCode, codesFromUpdates, awaitCode } from '../src/telegram.js';

const update = (id, text, chatId = 777) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chatId }, text },
});

test('digits are read out of whatever was typed around them', () => {
  assert.equal(extractCode('123456'), '123456');
  assert.equal(extractCode('kod 4821'), '4821');
  assert.equal(extractCode('the code is 90210, hurry'), '90210');
});

test('text with no code reads as no code, not as an empty one', () => {
  assert.equal(extractCode('no idea'), null);
  assert.equal(extractCode(''), null);
  assert.equal(extractCode(undefined), null);
  assert.equal(extractCode('123'), null, 'three digits is too short to be a PIN');
});

test('only the configured chat is read', () => {
  const payload = { result: [update(1, '1111', 999), update(2, '2222', 777)] };
  assert.deepEqual(codesFromUpdates(payload, 777).codes, ['2222']);
  assert.equal(codesFromUpdates(payload, 777).lastId, 2, 'the offset advances past foreign chats too');
});

test('the newest code wins, so a correction replaces a typo', () => {
  const payload = { result: [update(1, '1111'), update(2, 'oops, 2222')] };
  assert.deepEqual(codesFromUpdates(payload, 777).codes, ['1111', '2222']);
});

test('an empty or malformed payload yields nothing and no offset', () => {
  assert.deepEqual(codesFromUpdates({ result: [] }, 777), { codes: [], lastId: null });
  assert.deepEqual(codesFromUpdates(null, 777), { codes: [], lastId: null });
  assert.deepEqual(codesFromUpdates({ result: [{ update_id: 5 }] }, 777), { codes: [], lastId: 5 });
});

test('a code sent before the wait started is not reused', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const offset = new URL(url).searchParams.get('offset');
    if (offset === '-1') return { ok: true, json: async () => ({ result: [update(40, '0000')] }) };
    return { ok: true, json: async () => ({ result: [update(41, '5678')] }) };
  };

  const code = await awaitCode({ token: 't', chatId: '777', fetchImpl, timeoutMs: 5000, pollSeconds: 0 });
  assert.equal(code, '5678');
  assert.match(calls[1], /offset=41/, 'the wait resumes after the stale message');
});

test('no bot configured means no waiting at all', async () => {
  assert.equal(await awaitCode({ token: '', chatId: '777' }), null);
  assert.equal(await awaitCode({ token: 't', chatId: '' }), null);
});

test('a chat that cannot be read falls back to a human, rather than hanging', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.equal(await awaitCode({ token: 't', chatId: '777', fetchImpl, timeoutMs: 1000 }), null);
});

test('a silent chat times out and returns null', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: [] }) });
  assert.equal(await awaitCode({ token: 't', chatId: '777', fetchImpl, timeoutMs: 120, pollSeconds: 0 }), null);
});
