import test from 'node:test';
import assert from 'node:assert/strict';

import { extractServices, bodyForService, buildRotation, matchServices } from '../src/bodies.js';

const TREE = JSON.stringify({
  services: [
    { name: 'Dočasné útočisko', id: '242', serviceList: [
      { id: 'df816bbf', name: 'Registrácia dočasného útočiska' },
      { id: 'ab08d798', name: 'Žiadosť o vydanie dokladu' },
    ] },
    { name: 'Termíny na oddelenia', id: '217', serviceList: [{ id: 'f411f2ff', name: 'Biosnímanie' }] },
  ],
});

// Exactly the shape capture-session records.
const BODY = 'data=%7B%22serviceBranchID%22%3A%22df816bbf%22%2C%22authValue%22%3A%22false%22%7D';

test('pulls every service out of the tree', () => {
  const s = extractServices(TREE);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.id), ['df816bbf', 'ab08d798', 'f411f2ff']);
  assert.equal(s[0].group, 'Dočasné útočisko');
});

test('swaps the service id and leaves the rest byte-identical', () => {
  const out = bodyForService(BODY, 'ab08d798');
  assert.equal(out, 'data=%7B%22serviceBranchID%22%3A%22ab08d798%22%2C%22authValue%22%3A%22false%22%7D');
  assert.equal(out.replace('ab08d798', 'df816bbf'), BODY, 'nothing else may change');
});

test('handles an unencoded body too', () => {
  const plain = 'data={"serviceBranchID":"df816bbf","authValue":"false"}';
  assert.equal(bodyForService(plain, 'xyz'), 'data={"serviceBranchID":"xyz","authValue":"false"}');
});

test('a body with no serviceBranchID yields null, not garbage', () => {
  assert.equal(bodyForService('data=%7B%22pincode%22%3A%22123%22%7D', 'abc'), null);
});

test('rotation keeps the captured body first and drops duplicates', () => {
  const bodies = buildRotation(BODY, extractServices(TREE));
  assert.equal(bodies[0], BODY, 'the captured one is known to work — use it first');
  assert.equal(bodies.length, 3, 'df816bbf must not appear twice');
  assert.equal(new Set(bodies).size, bodies.length);
});

test('rotation degrades to a single body when nothing matches', () => {
  assert.deepEqual(buildRotation('data=%7B%22pincode%22%3A%221%22%7D', extractServices(TREE)),
    ['data=%7B%22pincode%22%3A%221%22%7D']);
});

test('malformed json is not fatal', () => {
  assert.deepEqual(extractServices('<html>'), []);
  assert.deepEqual(extractServices(''), []);
});

import { parseBodiesFile, interleavePrimary } from '../src/bodies.js';

// Exactly the file capture-session writes.
const FILE = [
  '# 4aef7554-48e0-4b98-a03e-3e8eb65b913c  Dočasné útočisko / Registrácia dočasného útočiska',
  '# 796dc593-0a47-4e57-b2ec-063b8eea48af  Dočasné útočisko / Žiadosť o vydanie dokladu',
  '# 3136e7da-7adf-41d6-9c73-1ae1f6305e0b  Termíny na oddelenia / Biosnímanie',
  'data=%7B%22serviceBranchID%22%3A%224aef7554-48e0-4b98-a03e-3e8eb65b913c%22%2C%22authValue%22%3A%22false%22%7D',
  'data=%7B%22serviceBranchID%22%3A%22796dc593-0a47-4e57-b2ec-063b8eea48af%22%2C%22authValue%22%3A%22false%22%7D',
  'data=%7B%22serviceBranchID%22%3A%223136e7da-7adf-41d6-9c73-1ae1f6305e0b%22%2C%22authValue%22%3A%22false%22%7D',
].join('\n');

test('each body is matched to its service name', () => {
  const entries = parseBodiesFile(FILE);
  assert.equal(entries.length, 3);
  assert.match(entries[0].label, /Registrácia dočasného útočiska/);
  assert.match(entries[1].label, /Žiadosť o vydanie dokladu/);
  assert.equal(entries[0].id, '4aef7554-48e0-4b98-a03e-3e8eb65b913c');
});

test('labels follow the id, not the line order', () => {
  // Comments deliberately out of order relative to the bodies.
  const shuffled = [
    '# 796dc593-0a47-4e57-b2ec-063b8eea48af  Second service',
    '# 4aef7554-48e0-4b98-a03e-3e8eb65b913c  First service',
    'data=%7B%22serviceBranchID%22%3A%224aef7554-48e0-4b98-a03e-3e8eb65b913c%22%7D',
    'data=%7B%22serviceBranchID%22%3A%22796dc593-0a47-4e57-b2ec-063b8eea48af%22%7D',
  ].join('\n');
  const entries = parseBodiesFile(shuffled);
  assert.equal(entries[0].label, 'First service');
  assert.equal(entries[1].label, 'Second service');
});

test('an unlabelled body still parses', () => {
  const entries = parseBodiesFile('data=%7B%22pincode%22%3A%221%22%7D');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, null);
  assert.equal(entries[0].id, null);
});

test('the primary service is polled every other time', () => {
  const entries = parseBodiesFile(FILE);
  const order = interleavePrimary(entries).map((e) => e.id.slice(0, 8));
  assert.deepEqual(order, ['4aef7554', '796dc593', '4aef7554', '3136e7da']);
});

test('interleaving a single body changes nothing', () => {
  const one = parseBodiesFile('data=%7B%22serviceBranchID%22%3A%22abc%22%7D');
  assert.deepEqual(interleavePrimary(one), one);
});

const SERVICES = [
  { id: 'a1', name: 'Registrácia dočasného útočiska', group: 'Dočasné útočisko' },
  { id: 'b2', name: 'Žiadosť o vydanie dokladu dočasné útočiska', group: 'Dočasné útočisko' },
  { id: 'c3', name: 'Biosnímanie', group: 'Termíny na oddelenia cudzineckej polície' },
  { id: 'd4', name: 'Udelenie národného víza', group: 'Víza' },
];

test('ONLY_SERVICE picks one service out of the rotation', () => {
  const hit = matchServices(SERVICES, 'Registrácia');
  assert.deepEqual(hit.map((s) => s.id), ['a1']);
});

test('the needle may be typed without diacritics or capitals', () => {
  assert.deepEqual(matchServices(SERVICES, 'registracia docasneho').map((s) => s.id), ['a1']);
});

test('it matches on the group name too', () => {
  assert.deepEqual(matchServices(SERVICES, 'Víza').map((s) => s.id), ['d4']);
});

test('a needle matching nothing returns nothing, so the caller can warn', () => {
  assert.deepEqual(matchServices(SERVICES, 'Reisepass'), []);
});

test('an empty needle selects nothing rather than everything', () => {
  assert.deepEqual(matchServices(SERVICES, ''), []);
  assert.deepEqual(matchServices(SERVICES, '   '), []);
});

test('a broad needle may legitimately match several services', () => {
  assert.deepEqual(matchServices(SERVICES, 'dočasné').map((s) => s.id), ['a1', 'b2']);
});
