// Whole-sat split maths for a Podcasting 2.0 value block.
//
// Rules implemented here (written from the published podcast:value spec, not
// copied from another project):
//   1. Recipients with fee="true" are taken off the top. Their `split` is read
//      as a percentage of the whole amount and rounded down.
//   2. What is left is shared among the other recipients in proportion to their
//      `split` shares (shares do not have to add to 100).
//   3. Shares are whole sats. Leftover sats go to the largest fractional
//      remainder first; ties go to the recipient listed earlier.
//   4. If every recipient is a fee recipient, or fees add up to 100% or more,
//      the whole amount is shared by weight across all of them.
//   5. A recipient this build cannot pay keeps its place in the maths, so the
//      others are not overpaid. Its sats stay in the listener's wallet.

export type Rail = 'cashu' | 'unpayable';

export interface Recipient {
  name: string;
  /** Raw `type` attribute from the feed, e.g. "cashu", "lnaddress", "node". */
  type: string;
  address: string;
  split: number;
  fee: boolean;
}

export interface Share {
  recipient: Recipient;
  rail: Rail;
  sats: number;
  /** Why the share is not paid, when rail is "unpayable". */
  reason?: string;
}

export interface SplitPlan {
  total: number;
  shares: Share[];
  /** Sum of shares that will actually be sent. */
  payable: number;
  /** Sum of shares that stay with the listener. */
  kept: number;
}

const CASHU_TYPES = new Set(['cashu', 'nut18', 'creq']);

export function railFor(r: Recipient): { rail: Rail; reason?: string } {
  const type = r.type.toLowerCase();
  if (CASHU_TYPES.has(type)) {
    if (/^creq[ab]/i.test(r.address.trim())) return { rail: 'cashu' };
    return { rail: 'unpayable', reason: 'not a Cashu payment request' };
  }
  if (type === 'lnaddress') {
    return { rail: 'unpayable', reason: 'Lightning address: not paid in this build' };
  }
  if (type === 'node' || type === 'keysend') {
    return { rail: 'unpayable', reason: 'keysend: a mint cannot pay it' };
  }
  if (type === 'nutzap' || type === 'nostr' || type === 'npub') {
    return { rail: 'unpayable', reason: 'nutzap: not paid in this build' };
  }
  return { rail: 'unpayable', reason: `unknown recipient type "${r.type}"` };
}

/** Largest-remainder apportionment of `total` whole sats across `weights`. */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  // Integer maths throughout: floor(total * w / sum) and the remainder of the
  // same division, so there is no floating point to disagree about.
  const base = weights.map((w) => Math.floor((total * w) / sum));
  const rem = weights.map((w, i) => ({ i, r: (total * w) % sum }));
  let left = total - base.reduce((a, b) => a + b, 0);
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i, r } of rem) {
    if (left <= 0) break;
    if (r === 0) continue;
    base[i] += 1;
    left -= 1;
  }
  return base;
}
