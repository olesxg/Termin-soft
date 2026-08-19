import test from 'node:test';
import assert from 'node:assert/strict';

import { extractServices, bodyForService, buildRotation } from '../src/bodies.js';

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
