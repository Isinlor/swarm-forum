'use strict';

/**
 * Resolves the address to attribute a request to.
 *
 * With `trustProxyHops` 0 (default, direct connections) this is always
 * the raw socket peer — X-Forwarded-For is never consulted, since any
 * client can set it to anything at zero cost.
 *
 * With N trusted proxy hops in front of this server, the real client
 * address is the Nth entry from the *right* of X-Forwarded-For: each hop
 * appends what it saw on its inbound connection, so only the rightmost N
 * entries were written by hops we actually trust — anything to their
 * left could be attacker-supplied and is ignored.
 */
function clientIp(req, headerName, hops = 0) {
  if (hops > 0 && headerName) {
    const header = req.headers[headerName.toLowerCase()];
    if (header) {
      const parts = header.split(',').map((part) => part.trim()).filter(Boolean);
      const index = parts.length - hops;
      if (index >= 0 && parts[index]) return parts[index];
    }
  }
  return req.socket.remoteAddress;
}

module.exports = { clientIp };
