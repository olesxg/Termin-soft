import test from 'node:test';
import assert from 'node:assert/strict';

import { bestMatch } from '../src/wizard.js';

const candidates = [
  { index: 0, id: 'input-sluzba-aaa', label: 'Registrácia dočasného útočiska' },
  { index: 1, id: 'input-sluzba-bbb', label: 'Žiadosť o vydanie dokladu o dočasnom útočisku' },
  { index: 2, id: null, label: 'Vyberte si službu a pokračujte. Registrácia dočasného útočiska je prvá v zozname.' },
];

test('matching ignores case and diacritics, as the portal writes both ways', () => {
  assert.equal(bestMatch(candidates, 'registracia').id, 'input-sluzba-aaa');
  assert.equal(bestMatch(candidates, 'REGISTRÁCIA').id, 'input-sluzba-aaa');
});

test('the shortest matching label wins, so a paragraph cannot outrank a control', () => {
  const match = bestMatch(candidates, 'Registrácia dočasného útočiska');
  assert.equal(match.index, 0, 'the help text mentions it too, and must not be clicked');
});

test('no match is null, never a nearest guess', () => {
  assert.equal(bestMatch(candidates, 'vodicsky preukaz'), null);
  assert.equal(bestMatch(candidates, ''), null);
  assert.equal(bestMatch(candidates, undefined), null);
  assert.equal(bestMatch([], 'registracia'), null);
  assert.equal(bestMatch(undefined, 'registracia'), null);
});

test('candidates with no label are skipped rather than matching everything', () => {
  assert.equal(bestMatch([{ index: 0, label: '' }, { index: 1, label: null }], 'x'), null);
});

test('an office is found by its town, which is all the radio shows', () => {
  const offices = [
    { index: 0, id: 'input-vyberPracoviska-BA1', label: 'OCP PZ Bratislava' },
    { index: 1, id: 'input-vyberPracoviska-KE1', label: 'OCP PZ Košice' },
  ];
  assert.equal(bestMatch(offices, 'kosice').id, 'input-vyberPracoviska-KE1');
});
