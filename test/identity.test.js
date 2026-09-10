import test from 'node:test';
import assert from 'node:assert/strict';

import { matchFields, readIdentity, IDENTITY_FIELDS } from '../src/identity.js';

/** The labels exactly as the portal renders them on step 1. */
const REAL_FORM = [
  { index: 0, label: 'Meno (povinné)', type: 'text' },
  { index: 1, label: 'Priezvisko (povinné)', type: 'text' },
  { index: 2, label: 'Deň', type: 'text' },
  { index: 3, label: 'Mesiac', type: 'text' },
  { index: 4, label: 'Rok', type: 'text' },
  { index: 5, label: 'Číslo cestovného dokladu (povinné)', type: 'text' },
  { index: 6, label: 'SMS kontakt (povinné)', type: 'text' },
  { index: 7, label: 'Emailová adresa (povinné)', type: 'text' },
];

const assigned = (pairs) =>
  Object.fromEntries(pairs.filter((p) => p.input).map((p) => [p.field.key, p.input.index]));

test('every field of the real form is found, and in the right box', () => {
  const map = assigned(matchFields(REAL_FORM));
  assert.deepEqual(map, {
    name: 0, surname: 1, day: 2, month: 3, year: 4, doc: 5, phone: 6, email: 7,
  });
});

test('diacritics do not matter — the labels carry them, the patterns do not', () => {
  const stripped = REAL_FORM.map((i) => ({ ...i, label: i.label.replace('Deň', 'Den').replace('Číslo', 'Cislo') }));
  const map = assigned(matchFields(stripped));
  assert.equal(map.day, 2);
  assert.equal(map.doc, 5);
});

test('no two fields may claim the same input', () => {
  const indexes = Object.values(assigned(matchFields(REAL_FORM)));
  assert.equal(new Set(indexes).size, indexes.length);
});

test('a paragraph that mentions several fields loses to the tight label', () => {
  // When the label has to be guessed from surrounding text it can swallow a
  // whole block — that blob must not win over the real one-word label.
  const noisy = [
    { index: 0, label: 'Zadajte Meno, Priezvisko a Rok narodenia do formulára nižšie', type: 'text' },
    { index: 1, label: 'Meno', type: 'text' },
    { index: 2, label: 'Priezvisko', type: 'text' },
  ];
  const map = assigned(matchFields(noisy));
  assert.equal(map.name, 1, 'the short "Meno" label wins over the paragraph');
  assert.equal(map.surname, 2);
});

test('a missing field is reported, not silently skipped', () => {
  const partial = [{ index: 0, label: 'Meno (povinné)', type: 'text' }];
  const pairs = matchFields(partial);
  assert.equal(pairs.find((p) => p.field.key === 'name').input.index, 0);
  assert.equal(pairs.find((p) => p.field.key === 'email').input, null);
});

test('inputs with no label at all are ignored', () => {
  const blank = [{ index: 0, label: '', type: 'text' }, { index: 1, label: null, type: 'text' }];
  assert.deepEqual(assigned(matchFields(blank)), {});
});

test('readIdentity takes only the keys that are set', () => {
  const identity = readIdentity({
    ID_NAME: 'Anastasiia',
    ID_SURNAME: '  Humeniak  ',
    ID_BIRTH_DAY: '11',
    ID_EMAIL: '',
  });
  assert.deepEqual(identity, { name: 'Anastasiia', surname: 'Humeniak', day: '11' });
  assert.equal('email' in identity, false, 'a blank value must not become an empty string');
});

test('every field declares an env key and they are unique', () => {
  const envs = IDENTITY_FIELDS.map((f) => f.env);
  assert.equal(new Set(envs).size, envs.length);
  assert.ok(envs.every((e) => /^ID_[A-Z_]+$/.test(e)));
});
