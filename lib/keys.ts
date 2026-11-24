// Creator keys, payment requests and the signed inbox handshake.

import {
  PaymentRequest,
  PaymentRequestTransportType,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  schnorrSignMessage,
  schnorrVerifyMessage,
} from '@cashu/cashu-ts';

export const DEFAULT_MINT = 'https://testnut.cashu.space';
export const NOFEES_MINT = 'https://nofees.testnut.cashu.space';

/**
 * A different test mint, used only to produce an invoice for the cash-out
 * demo. It stands in for the creator's own Lightning wallet.
 */
export function secondTestMint(primary: string): string {
  return primary.replace(/\/+$/, '') === NOFEES_MINT ? DEFAULT_MINT : NOFEES_MINT;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));

export interface KeyPair {
  privkey: string;
  /** 33-byte compressed public key, hex. This is what ecash is locked to. */
  pubkey: string;
}

export function newKeyPair(): KeyPair {
  return fromPrivkey(hex(createRandomSecretKey()));
}

export function fromPrivkey(privkey: string): KeyPair {
  return { privkey, pubkey: hex(getPubKeyFromPrivKey(unhex(privkey))) };
}

export function isPubkey(s: string): boolean {
  return /^0[23][0-9a-f]{64}$/.test(s);
}

/**
 * A reusable, amountless NUT-18 request: "send ecash locked to this key, by
 * HTTP POST to this URL". The mint list is strict so a payer cannot hand over
 * tokens from a mint the creator never chose.
 */
export function makeCreq(origin: string, pubkey: string, mint: string, description?: string): string {
  const req = new PaymentRequest(
    [{ type: PaymentRequestTransportType.POST, target: `${origin}/api/ecash?to=${pubkey}` }],
    undefined,
    undefined,
    'sat',
    [mint],
    description,
    false,
    { kind: 'P2PK', data: pubkey },
  );
  return req.toEncodedCreqA();
}

// --- inbox handshake -------------------------------------------------------
// The inbox holds locked tokens nobody else can spend, but boost messages are
// personal, so reading it needs a signature from the creator's key.

const WINDOW_MS = 5 * 60 * 1000;

export function inboxMessage(pubkey: string, ts: number, action: string): string {
  return `nutcast:${action}:${pubkey}:${ts}`;
}

export function signInbox(kp: KeyPair, action: string, ts = Date.now()) {
  return { pubkey: kp.pubkey, ts, sig: schnorrSignMessage(inboxMessage(kp.pubkey, ts, action), kp.privkey) };
}

export function verifyInbox(
  pubkey: string,
  ts: number,
  sig: string,
  action: string,
  now = Date.now(),
): boolean {
  if (!isPubkey(pubkey) || !Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) return false;
  try {
    return schnorrVerifyMessage(sig, inboxMessage(pubkey, ts, action), pubkey);
  } catch {
    return false;
  }
}
