// Payee-side checks for the NUT-18 receive endpoint. Server only.

import {
  CheckStateEnum,
  PaymentRequest,
  PaymentRequestTransportType,
  Wallet,
  sumProofs,
} from '@cashu/cashu-ts';
import { DEFAULT_MINT, isPubkey } from './keys';
import { toStored } from './wallet';
import type { StoredProof } from './store';

export class PaymentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const norm = (u: string) => u.trim().replace(/\/+$/, '');

export function acceptedMints(): string[] {
  const raw = process.env.NUTCAST_MINTS;
  return (raw ? raw.split(',') : [DEFAULT_MINT]).map(norm).filter(Boolean);
}

const wallets = new Map<string, Promise<Wallet>>();

function walletFor(mint: string): Promise<Wallet> {
  let w = wallets.get(mint);
  if (!w) {
    const wallet = new Wallet(mint, { unit: 'sat' });
    w = wallet.loadMint().then(() => wallet);
    w.catch(() => wallets.delete(mint));
    wallets.set(mint, w);
  }
  return w;
}

export interface VerifiedPayment {
  mint: string;
  /** What the creator nets after the mint's input fees. */
  amount: number;
  memo?: string;
  proofs: StoredProof[];
}

/**
 * Accept a payload only if every proof:
 *   - comes from a mint this server chose (never dial a mint named by a payer),
 *   - is in sats,
 *   - carries exactly the P2PK lock for `to`, with no refund path,
 *   - has a valid mint signature (DLEQ), and
 *   - is unspent at the mint right now.
 */
export async function verifyPayment(to: string, rawBody: string): Promise<VerifiedPayment> {
  if (!isPubkey(to)) throw new PaymentError(400, 'bad_recipient', 'unknown recipient key');

  let payload;
  try {
    payload = PaymentRequest.decodePayload(rawBody);
  } catch {
    throw new PaymentError(400, 'bad_payload', 'body is not a NUT-18 payment payload');
  }
  if (payload.unit !== 'sat') throw new PaymentError(400, 'bad_unit', 'only sat is accepted');
  if (!payload.proofs?.length) throw new PaymentError(400, 'empty', 'no proofs in payload');
  if (payload.proofs.length > 64) throw new PaymentError(400, 'too_many', 'too many proofs in one payment');

  const mint = norm(payload.mint ?? '');
  const mints = acceptedMints();
  if (!mints.includes(mint)) {
    throw new PaymentError(400, 'untrusted_mint', 'mint not accepted', { accepted_mints: mints });
  }

  let wallet: Wallet;
  try {
    wallet = await walletFor(mint);
  } catch {
    throw new PaymentError(503, 'mint_unreachable', 'could not reach the mint, try again');
  }

  // The request this endpoint stands behind. isPaymentRequestSatisfied checks
  // the lock exactly, so a proof with an extra refund path is refused.
  const request = new PaymentRequest(
    [{ type: PaymentRequestTransportType.POST, target: 'https://self' }],
    undefined,
    undefined,
    'sat',
    [mint],
    undefined,
    false,
    { kind: 'P2PK', data: to },
  );
  let ok = false;
  try {
    ok = wallet.isPaymentRequestSatisfied(request, payload.proofs, 1);
  } catch {
    ok = false;
  }
  if (!ok) throw new PaymentError(400, 'wrong_lock', 'proofs are not locked to this recipient, or net nothing');

  const { invalid } = await wallet.verifyMintSignatures(payload.proofs, { require: true });
  if (invalid.length) throw new PaymentError(400, 'bad_signature', 'proofs failed the mint signature check');

  let states;
  try {
    states = await wallet.checkProofsStates(payload.proofs);
  } catch {
    throw new PaymentError(503, 'mint_unreachable', 'could not check proofs with the mint, try again');
  }
  if (states.some((s) => s.state !== CheckStateEnum.UNSPENT)) {
    throw new PaymentError(400, 'spent', 'one or more proofs are already spent');
  }

  const gross = sumProofs(payload.proofs);
  const net = gross.subtract(wallet.getFeesForProofs(payload.proofs)).toNumber();
  return {
    mint,
    amount: net,
    memo: payload.memo?.slice(0, 500),
    proofs: payload.proofs.map(toStored),
  };
}
