import test from 'node:test';
import assert from 'node:assert/strict';

import { preferPublicDns } from '../src/dns.js';

/** A stand-in for node:dns: the "system" resolver records what reached it. */
function fakeDns() {
  const calls = [];
  return {
    calls,
    lookup(hostname, options, callback) {
      calls.push(hostname);
      const cb = typeof options === 'function' ? options : callback;
      cb(null, '10.0.0.1', 4);
    },
  };
}

const resolverAnswering = (addresses) => ({ resolve4: (host, cb) => cb(null, addresses) });
const resolverFailing = (code = 'ETIMEOUT') => ({ resolve4: (host, cb) => cb(Object.assign(new Error(code), { code })) });

const lookup = (mod, host, options) =>
  new Promise((resolve, reject) => {
    const done = (err, address, family) => (err ? reject(err) : resolve({ address, family }));
    if (options === undefined) mod.lookup(host, done);
    else mod.lookup(host, options, done);
  });

test('a name is answered by the public resolver when it can', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverAnswering(['213.81.171.144']) });
  assert.deepEqual(await lookup(mod, 'portal.minv.sk'), { address: '213.81.171.144', family: 4 });
  assert.deepEqual(mod.calls, [], 'the system resolver was not needed');
});

test('when public DNS fails, the system resolver still gets its turn', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverFailing() });
  assert.equal((await lookup(mod, 'portal.minv.sk')).address, '10.0.0.1');
  assert.deepEqual(mod.calls, ['portal.minv.sk']);
});

test('an empty public answer falls through too, rather than resolving to nothing', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverAnswering([]) });
  assert.equal((await lookup(mod, 'portal.minv.sk')).address, '10.0.0.1');
});

test('all:true gets the list shape fetch asks for', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverAnswering(['1.2.3.4', '5.6.7.8']) });
  const all = await new Promise((resolve) => mod.lookup('api.telegram.org', { all: true }, (err, list) => resolve(list)));
  assert.deepEqual(all, [{ address: '1.2.3.4', family: 4 }, { address: '5.6.7.8', family: 4 }]);
});

test('IP literals, localhost and IPv6-only lookups are left to the system', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverAnswering(['9.9.9.9']) });
  await lookup(mod, '127.0.0.1');
  await lookup(mod, 'localhost');
  await lookup(mod, 'portal.minv.sk', { family: 6 });
  assert.deepEqual(mod.calls, ['127.0.0.1', 'localhost', 'portal.minv.sk']);
});

test('the numeric family argument form still works', async () => {
  const mod = fakeDns();
  preferPublicDns(['8.8.8.8'], { dnsModule: mod, resolver: resolverAnswering(['213.81.171.144']) });
  assert.equal((await lookup(mod, 'portal.minv.sk', 4)).address, '213.81.171.144');
});

test('no usable servers means nothing is patched', () => {
  const mod = fakeDns();
  const original = mod.lookup;
  assert.equal(preferPublicDns([], { dnsModule: mod }), false);
  assert.equal(preferPublicDns(['off'], { dnsModule: mod }), false, '"off" switches it off');
  assert.equal(preferPublicDns(undefined, { dnsModule: mod }), false);
  assert.equal(mod.lookup, original);
});
