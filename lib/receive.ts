// The NUT-18 receive endpoint's logic, kept out of the route file so it can be
// tested without a web server.

import { getStore, type InboxEntry, type InboxStore } from './store';
import { PaymentError, verifyPayment } from './verify';

export interface ReceiveResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function receivePayment(
  params: URLSearchParams,
  rawBody: string,
  store: InboxStore = getStore(),
): Promise<ReceiveResponse> {
  const to = (params.get('to') ?? '').toLowerCase();
  const action = params.get('action') === 'stream' ? 'stream' : 'boost';
  const episode = params.get('episode')?.slice(0, 200) || undefined;

  if (rawBody.length > 200_000) {
    return { status: 413, body: { success: false, error: 'too_large' } };
  }

  try {
    const payment = await verifyPayment(to, rawBody);
    const entry: InboxEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      to,
      mint: payment.mint,
      amount: payment.amount,
      action,
      // A stream tick is silent by definition, whatever the payer sent.
      memo: action === 'boost' ? payment.memo : undefined,
      episode,
      receivedAt: Date.now(),
      status: 'received',
      proofs: payment.proofs,
    };
    // Durable before we say yes.
    const fresh = await store.add(entry);
    if (!fresh) return { status: 409, body: { success: false, error: 'duplicate' } };
    return { status: 200, body: { success: true, amount_sats: payment.amount, mint_url: payment.mint } };
  } catch (err) {
    if (err instanceof PaymentError) {
      return { status: err.status, body: { success: false, error: err.code, message: err.message, ...err.extra } };
    }
    console.error('ecash receive failed', err);
    return { status: 500, body: { success: false, error: 'internal' } };
  }
}
