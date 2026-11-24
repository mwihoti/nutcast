// Fetch a podcast feed on the listener's behalf. Server only.
//
// Most podcast hosts do not send CORS headers, so a browser cannot read their
// feeds directly. This proxy can, and because it fetches URLs chosen by
// strangers it is deliberately narrow: https only, public addresses only,
// redirects re-checked, small responses, short timeout.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 3;

export class FeedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('::ffff:');
  }
  return true; // not an IP at all
}
