import test from 'node:test';
import assert from 'node:assert/strict';

import { bestMatch, pickPinInput } from '../src/wizard.js';

/** Exactly the shape identity.js collectInputs returns. */
const box = (index, label, type = 'text') => ({ index, id: null, name: null, type, label, value: '' });

// Step 1 as the portal renders it. The last entry is the trap that broke the
// 2026-10-05 run: no <label>, so identity.js took the preceding paragraph.
const STEP_ONE = [
  box(0, 'Meno'),
  box(1, 'Priezvisko'),
  box(2, 'Deň'),
  box(3, 'Mesiac'),
  box(4, 'Rok'),
  box(5, 'Číslo cestovného dokladu'),
  box(6, 'SMS kontakt'),
  box(7, 'Emailová adresa'),
  box(8, 'Na Vaše telefónne číslo bude zaslaný PIN kód pre overenie.'),
];

const PIN_STEP = [box(0, 'Kód z SMS')];

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

test('step 1 never yields a PIN field, however its prose is worded', () => {
  assert.equal(
    pickPinInput(STEP_ONE),
    null,
    'claiming one here skips the CAPTCHA and asks for an SMS that was never sent',
  );
});

test('the real code step is found', () => {
  assert.equal(pickPinInput(PIN_STEP).index, 0);
  assert.equal(pickPinInput([box(0, 'Overovací kód')]).index, 0);
  assert.equal(pickPinInput([box(0, 'PIN kód')]).index, 0);
});

test('an unlabelled single box on its own step is the code field', () => {
  assert.equal(pickPinInput([box(0, '')]).index, 0);
  assert.equal(pickPinInput([box(0, ''), box(1, '')]), null, 'two boxes is a form, not a code step');
});

test('one identity field left over does not open the unlabelled fallback', () => {
  assert.equal(pickPinInput([box(0, 'Meno'), box(1, '')]), null);
});

test('a code step still showing one identity field is found by label', () => {
  assert.equal(pickPinInput([box(0, 'SMS kontakt'), box(1, 'Kód z SMS')]).index, 1);
});

test('an empty page is not a code step', () => {
  assert.equal(pickPinInput([]), null);
  assert.equal(pickPinInput(undefined), null);
});

test('a checkbox-only step yields nothing, since a code is typed', () => {
  assert.equal(pickPinInput([box(0, 'Súhlasím', 'checkbox')]), null);
});

test('an office is found by its town, which is all the radio shows', () => {
  const offices = [
    { index: 0, id: 'input-vyberPracoviska-BA1', label: 'OCP PZ Bratislava' },
    { index: 1, id: 'input-vyberPracoviska-KE1', label: 'OCP PZ Košice' },
  ];
  assert.equal(bestMatch(offices, 'kosice').id, 'input-vyberPracoviska-KE1');
});
