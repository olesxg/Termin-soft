import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSlots, normalize } from '../src/detect.js';

const NO_SLOTS = ['Nie sú momentálne dostupné žiadne termíny'];

test('normalize strips diacritics and case', () => {
  assert.equal(normalize('Nie sú MOMENTÁLNE'), 'nie su momentalne');
});

test('matches the no-slots sentence in an HTML fragment', () => {
  const html = '<div class="msg">Nie sú momentálne dostupné žiadne termíny.</div>';
  const result = detectSlots(html, { noSlotsPhrases: NO_SLOTS });
  assert.equal(result.available, false);
});

test('matches the no-slots sentence even without diacritics', () => {
  const html = '<div>Nie su momentalne dostupne ziadne terminy</div>';
  assert.equal(detectSlots(html, { noSlotsPhrases: NO_SLOTS }).available, false);
});

test('matches the no-slots sentence through JSON unicode escapes', () => {
  const body = JSON.stringify({ message: 'Nie sú momentálne dostupné žiadne termíny' })
    .replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.ok(body.includes('\\u'), 'fixture should contain escapes');
  assert.equal(detectSlots(body, { noSlotsPhrases: NO_SLOTS }).available, false);
});

test('empty JSON array means no slots', () => {
  const result = detectSlots('[]', { noSlotsPhrases: NO_SLOTS });
  assert.equal(result.available, false);
});

test('non-empty JSON array means a slot', () => {
  const result = detectSlots('["2026-08-14T09:00","2026-08-14T09:20"]', { noSlotsPhrases: NO_SLOTS });
  assert.equal(result.available, true);
  assert.match(result.reason, /2 entries/);
});

test('finds a nested dates array without configuration', () => {
  const body = JSON.stringify({ status: 'ok', data: { terms: [{ date: '2026-08-14' }] } });
  const result = detectSlots(body, { noSlotsPhrases: NO_SLOTS });
  assert.equal(result.available, true);
  assert.match(result.reason, /data\.terms/);
});

test('an explicit json path wins over auto-discovery', () => {
  const body = JSON.stringify({ errors: [], data: { terms: [] } });
  assert.equal(detectSlots(body, { jsonPath: 'data.terms' }).available, false);
});

test('the no-slots phrase beats a non-empty array', () => {
  const body = JSON.stringify({ messages: ['Nie sú momentálne dostupné žiadne termíny'] });
  assert.equal(detectSlots(body, { noSlotsPhrases: NO_SLOTS }).available, false);
});

test('an unrecognised response is inconclusive, not a false positive', () => {
  const result = detectSlots('<html><body>Prihláste sa</body></html>', { noSlotsPhrases: NO_SLOTS });
  assert.equal(result.available, null);
  assert.ok(result.sample);
});

test('a positive phrase is honoured', () => {
  const result = detectSlots('<div>Vyberte si termín</div>', {
    noSlotsPhrases: NO_SLOTS,
    slotPhrases: ['Vyberte si termín'],
  });
  assert.equal(result.available, true);
});
