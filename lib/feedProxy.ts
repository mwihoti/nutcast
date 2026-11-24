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

async function assertPublic(url: URL) {
  if (url.protocol !== 'https:') throw new FeedError(400, 'only https feed addresses are allowed');
  if (url.username || url.password) throw new FeedError(400, 'feed address must not contain a login');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new FeedError(400, 'could not find that host');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new FeedError(400, 'that address is not public');
}

export async function fetchFeed(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError(400, 'not a valid address');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      await assertPublic(url);
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*', 'User-Agent': 'Nutcast/0.1' },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next) throw new FeedError(502, 'the feed redirected nowhere');
        url = new URL(next, url);
        continue;
      }
      if (!res.ok) throw new FeedError(502, `the feed host answered ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new FeedError(413, 'feed is too large');
      const reader = res.body?.getReader();
      if (!reader) throw new FeedError(502, 'empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new FeedError(413, 'feed is too large');
        }
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    }
    throw new FeedError(502, 'too many redirects');
  } catch (err) {
    if (err instanceof FeedError) throw err;
    throw new FeedError(502, ctrl.signal.aborted ? 'the feed host took too long' : 'could not fetch the feed');
  } finally {
    clearTimeout(timer);
  }
}
