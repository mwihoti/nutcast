// Split-and-pay: one function behind both boosts and stream flushes.
//
// For each payable share it swaps the sats into proofs locked to the
// recipient, writes the delivery to a journal, then POSTs it (NUT-18 HTTP
// transport). The journal is written before the network call, so a closed tab
// or a dead connection never loses a payment: it is retried on next open.

import { decodePaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { computeSplit, type Share, type SplitPlan } from './splits';
import type { KV, NutWallet } from './wallet';

export type Action = 'boost' | 'stream';

export interface Delivery {
  id: string;
  recipient: string;
  target: string;
  body: string;
  amount: number;
  action: Action;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /** The receiver refused it for good. Kept so the token is never lost. */
  dead?: boolean;
}

export interface ShareResult {
  share: Share;
  /**
   * paid:   delivered and accepted.
   * queued: left the wallet, journaled, delivery not confirmed yet.
   * failed: nothing left the wallet. Safe to try again.
   * kept:   this build cannot pay the recipient. Sats stay with the listener.
   */
  status: 'paid' | 'queued' | 'failed' | 'kept';
  fee: number;
  error?: string;
}

export interface PayResult {
  results: ShareResult[];
  /** Sats that left the wallet for recipients (paid + queued). */
  sent: number;
  fees: number;
  failed: number;
  kept: number;
  /**
   * Budget mode only: sats held back because fees would have taken more than
   * half of them. Nothing was sent; they should stay set aside for next time.
   */
  deferred: number;
}

export interface PayOptions {
  action: Action;
  /** Boost message. Stream flushes are silent. */
  memo?: string;
  episode?: string;
  /**
   * Hard ceiling on what may leave the wallet, fees included. When set, fees
   * come out of the plan's total, never on top of it. Stream flushes use this
   * so a budget is a real limit. Boosts leave it unset: the creator gets the
   * amount typed and the fee is shown separately.
   */
  budget?: number;
  fetchImpl?: typeof fetch;
}

const journalKey = (ns: string) => `nutcast:${ns}:deliveries`;

export function loadJournal(kv: KV, ns: string): Delivery[] {
  try {
    return JSON.parse(kv.getItem(journalKey(ns)) ?? '[]') as Delivery[];
  } catch {
    return [];
  }
}

function saveJournal(kv: KV, ns: string, list: Delivery[]) {
  kv.setItem(journalKey(ns), JSON.stringify(list));
}

function updateJournal(kv: KV, ns: string, fn: (list: Delivery[]) => Delivery[]) {
  saveJournal(kv, ns, fn(loadJournal(kv, ns)));
}

/** Where to POST, with the Sovereigncast-style action and episode hints. */
export function targetFor(creq: string, action: Action, episode?: string): string {
  const post = decodePaymentRequest(creq).getTransport(PaymentRequestTransportType.POST);
  if (!post) throw new Error('payment request has no HTTP POST transport');
  const url = new URL(post.target);
  url.searchParams.set('action', action);
  if (episode && !url.searchParams.has('episode')) url.searchParams.set('episode', episode);
  return url.toString();
}

/** Try one delivery. Resolves to how the journal entry should change. */
async function attempt(d: Delivery, fetchImpl: typeof fetch): Promise<'done' | 'retry' | 'dead'> {
  try {
    const res = await fetchImpl(d.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: d.body,
    });
    // 409 means the receiver already has these proofs: an earlier attempt landed.
    if (res.ok || res.status === 409) return 'done';
    d.lastError = `receiver answered ${res.status}`;
    return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'dead' : 'retry';
  } catch (err) {
    d.lastError = err instanceof Error ? err.message : String(err);
    return 'retry';
  }
}

export async function paySplit(
  wallet: NutWallet,
  kv: KV,
  ns: string,
  plan: SplitPlan,
  opts: PayOptions,
): Promise<PayResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const results: ShareResult[] = [];
  let room = opts.budget;

  if (opts.budget !== undefined) {
    // Fees are paid out of the budget. Estimate them, shrink the plan to what
    // is left, and wait for a bigger batch if fees would take most of it.
    let estimate = 0;
    for (const share of plan.shares) {
      if (share.rail !== 'cashu' || share.sats <= 0) continue;
      try {
        estimate += await wallet.quoteFee(share.recipient.address, share.sats);
      } catch {
        /* the real attempt below reports the error */
      }
    }
    if (estimate > 0) {
      if (estimate * 2 > opts.budget) {
        return { results: [], sent: 0, fees: 0, failed: 0, kept: 0, deferred: opts.budget };
      }
      plan = computeSplit(opts.budget - estimate, plan.shares.map((s) => s.recipient));
    }
  }

  for (const planned of plan.shares) {
    let share = planned;
    if (share.sats <= 0) continue;
    if (share.rail !== 'cashu') {
      results.push({ share, status: 'kept', fee: 0, error: share.reason });
      continue;
    }

    let delivery: Delivery;
    let fee = 0;
    try {
      const creq = share.recipient.address;
      const target = targetFor(creq, opts.action, opts.episode);
      const paid = await wallet.payRequest(creq, share.sats, room);
      if (!paid) {
        results.push({ share: { ...share, sats: 0 }, status: 'kept', fee: 0, error: 'nothing left after fees' });
        continue;
      }
      share = { ...share, sats: paid.amount };
      fee = paid.fee;
      if (room !== undefined) room -= paid.amount + paid.fee;
      const body = decodePaymentRequest(creq).encodePayload(wallet.mintUrl, paid.send, {
        memo: opts.action === 'boost' ? opts.memo : undefined,
        unit: 'sat',
      });
      delivery = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        recipient: share.recipient.name,
        target,
        body,
        amount: share.sats,
        action: opts.action,
        createdAt: Date.now(),
        attempts: 0,
      };
      // Journal first. From here on the sats have left the wallet.
      updateJournal(kv, ns, (l) => [...l, delivery]);
    } catch (err) {
      results.push({ share, status: 'failed', fee: 0, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    delivery.attempts += 1;
    const outcome = await attempt(delivery, fetchImpl);
    if (outcome === 'done') {
      updateJournal(kv, ns, (l) => l.filter((d) => d.id !== delivery.id));
      results.push({ share, status: 'paid', fee });
    } else {
      delivery.dead = outcome === 'dead';
      updateJournal(kv, ns, (l) => l.map((d) => (d.id === delivery.id ? delivery : d)));
      results.push({ share, status: 'queued', fee, error: delivery.lastError });
    }
  }

  const sum = (s: ShareResult['status']) =>
    results.filter((r) => r.status === s).reduce((a, r) => a + r.share.sats, 0);
  return {
    results,
    sent: sum('paid') + sum('queued'),
    fees: results.reduce((a, r) => a + r.fee, 0),
    failed: sum('failed'),
    kept: sum('kept'),
    deferred: 0,
  };
}

/** Re-send journaled deliveries. Call on page load and after reconnecting. */
export async function retryDeliveries(kv: KV, ns: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  let delivered = 0;
  for (const d of loadJournal(kv, ns)) {
    if (d.dead) continue;
    d.attempts += 1;
    const outcome = await attempt(d, fetchImpl);
    if (outcome === 'done') {
      delivered += 1;
      updateJournal(kv, ns, (l) => l.filter((x) => x.id !== d.id));
    } else {
      d.dead = outcome === 'dead';
      updateJournal(kv, ns, (l) => l.map((x) => (x.id === d.id ? d : x)));
    }
  }
  return delivered;
}
