import dns from 'node:dns';
import net from 'node:net';

/**
 * Resolve names through public DNS first and the system resolver second.
 *
 * The home router's resolver drops out for minutes at a time: monitor.log has
 * seventeen ENOTFOUNDs, eleven in a row one night at 22:57 — inside the window
 * a new day opens in — while 8.8.8.8 answered throughout. A blind monitor is
 * worse than a slow one, and the Telegram push goes through the same resolver,
 * so it would have stayed silent too.
 *
 * Patched on dns.lookup because everything outgoing goes through it: axios's
 * agents and the global fetch alike. Only where a public answer exists is it
 * used; anything else falls through to the system untouched, so a network that
 * blocks outside DNS behaves exactly as before.
 *
 * Changes nothing about which address the portal sees: the request still
 * leaves through the same interface, it only finds the server by another route.
 */
export function preferPublicDns(servers, { dnsModule = dns, resolver = null } = {}) {
  const list = (servers ?? []).filter((server) => net.isIP(server));
  if (list.length === 0) return false;

  const publicResolver = resolver ?? new dnsModule.Resolver({ timeout: 2500, tries: 2 });
  if (!resolver) publicResolver.setServers(list);

  const system = dnsModule.lookup;

  dnsModule.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    const fallback = () => system.call(dnsModule, hostname, options, callback);

    if (!hostname || net.isIP(hostname) || hostname === 'localhost' || opts.family === 6) return fallback();

    publicResolver.resolve4(hostname, (err, addresses) => {
      if (err || !Array.isArray(addresses) || addresses.length === 0) return fallback();
      if (opts.all) return callback(null, addresses.map((address) => ({ address, family: 4 })));
      return callback(null, addresses[0], 4);
    });
  };

  return true;
}
