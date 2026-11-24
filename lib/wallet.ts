// A small Cashu wallet: one mint, one unit, proofs kept in a key-value store
// (localStorage in the browser). cashu-ts is stateless, so everything that
// touches the proof list goes through one queue here; two payments can never
// spend the same proofs.

import {
  Amount,
  MintQuoteState,
  Wallet,
  decodePaymentRequest,
  getEncodedToken,
  type MeltQuoteBolt11Response,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts';
import type { StoredProof } from './store';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const toStored = (p: Proof): StoredProof => ({
  id: p.id,
  amount: Amount.from(p.amount).toNumber(),
  secret: p.secret,
  C: p.C,
  ...(p.dleq ? { dleq: p.dleq } : {}),
  ...(p.p2pk_e ? { p2pk_e: p.p2pk_e } : {}),
});

export const toProof = (p: StoredProof): Proof => ({ ...p, amount: Amount.from(p.amount) });

export const sumStored = (ps: Array<{ amount: number }>) => ps.reduce((a, p) => a + p.amount, 0);

/** Everything a prepared swap takes out of the wallet: the amount sent plus all fees. */
function costOf(preview: SwapPreview): number {
  const inputs = preview.inputs.reduce((a, p) => a + Amount.from(p.amount).toNumber(), 0);
  const kept = (preview.keepOutputs ?? []).reduce((a, o) => a + Amount.from(o.blindedMessage.amount).toNumber(), 0);
  return inputs - kept;
}

export interface FundQuote {
  quote: string;
  request: string;
  amount: number;
}

export interface PaidRequest {
  /** Proofs locked to the payee. Deliver these; the wallet no longer has them. */
  send: Proof[];
  /** What the payee nets. */
  amount: number;
  /** What the listener paid on top (mint input fees). */
  fee: number;
}

export class NutWallet {
  private wallet?: Promise<Wallet>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly mintUrl: string,
    private readonly ns: string,
    private readonly kv: KV,
  ) {}

  private key(name: string) {
    return `nutcast:${this.ns}:${name}`;
  }

  /** Loads mint info and keys on first use. */
  ready(): Promise<Wallet> {
    if (!this.wallet) {
      const w = new Wallet(this.mintUrl, { unit: 'sat' });
      this.wallet = w.loadMint().then(() => w);
      this.wallet.catch(() => (this.wallet = undefined));
    }
    return this.wallet;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  proofs(): StoredProof[] {
    try {
      return JSON.parse(this.kv.getItem(this.key('proofs')) ?? '[]') as StoredProof[];
    } catch {
      return [];
    }
  }

  private save(proofs: StoredProof[]) {
    this.kv.setItem(this.key('proofs'), JSON.stringify(proofs));
  }

  balance(): number {
    return sumStored(this.proofs());
  }

  // --- funding (NUT-04) ------------------------------------------------------

  async fundStart(amount: number): Promise<FundQuote> {
    const w = await this.ready();
    const q = await w.createMintQuoteBolt11(amount);
    const fq = { quote: q.quote, request: q.request, amount };
    this.kv.setItem(this.key('fund'), JSON.stringify(fq));
    return fq;
  }

  /** A top-up that was started but not finished, e.g. before a reload. */
  pendingFund(): FundQuote | undefined {
    try {
      const raw = this.kv.getItem(this.key('fund'));
      return raw ? (JSON.parse(raw) as FundQuote) : undefined;
    } catch {
      return undefined;
    }
  }

  cancelFund() {
    this.kv.removeItem(this.key('fund'));
  }

  /** Returns true once the invoice is paid and the ecash is in the wallet. */
  fundFinish(fq: FundQuote): Promise<boolean> {
    return this.exclusive(async () => {
      const w = await this.ready();
      const q = await w.checkMintQuoteBolt11(fq.quote);
      if (q.state === MintQuoteState.UNPAID) return false;
      if (q.state === MintQuoteState.PAID) {
        const minted = await w.mintProofsBolt11(fq.amount, fq.quote);
        this.save([...this.proofs(), ...minted.map(toStored)]);
      }
      this.cancelFund();
      return true;
    });
  }

  // --- paying a NUT-18 request ------------------------------------------------

  /**
   * Swap `amount` out of the wallet into proofs that satisfy the request: its
   * lock, its mint list and its unit, with input fees added on top so the
   * payee nets `amount`. The remaining proofs are saved before this returns.
   *
   * With `maxCost`, the whole debit (amount plus fees) is guaranteed not to
   * exceed it: the amount is trimmed until it fits, and null is returned when
   * nothing would be left for the payee. The cost is read from the prepared
   * swap before anything is sent to the mint, so the guarantee is exact.
   */
  payRequest(creq: string, amount: number, maxCost?: number): Promise<PaidRequest | null> {
    return this.exclusive(async () => {
      const w = await this.ready();
      const pr = decodePaymentRequest(creq);
      const before = this.proofs();
      let amt = amount;
      let preview = await w.ops.sendToRequest(pr, before.map(toProof), amt).prepare();
      for (let i = 0; maxCost !== undefined && costOf(preview) > maxCost; i++) {
        amt -= costOf(preview) - maxCost;
        if (amt <= 0 || i >= 4) return null;
        preview = await w.ops.sendToRequest(pr, before.map(toProof), amt).prepare();
      }
      const cost = costOf(preview);
      const { keep, send } = await w.completeSwap(preview);
      const bySecret = new Map<string, StoredProof>();
      for (const p of [...(preview.unselectedProofs ?? []), ...keep]) bySecret.set(p.secret, toStored(p));
      this.save([...bySecret.values()]);
      return { send, amount: amt, fee: cost - amt };
    });
  }

  /** What paying `amount` to this request would cost in fees right now. Sends nothing. */
  quoteFee(creq: string, amount: number): Promise<number> {
    return this.exclusive(async () => {
      const w = await this.ready();
      const preview = await w.ops
        .sendToRequest(decodePaymentRequest(creq), this.proofs().map(toProof), amount)
        .prepare();
      return costOf(preview) - amount;
    });
  }

  // --- receiving ----------------------------------------------------------------

  /** Swap incoming proofs or a token for fresh ones. Returns the sats gained. */
  receive(input: string | StoredProof[], privkey?: string): Promise<number> {
    return this.exclusive(async () => {
      const w = await this.ready();
      const arg = typeof input === 'string' ? input : input.map(toProof);
      const fresh = await w.receive(arg, privkey ? { privkey } : undefined);
      const stored = fresh.map(toStored);
      this.save([...this.proofs(), ...stored]);
      return sumStored(stored);
    });
  }

  /** The whole balance as one `cashuB…` token. This is the backup. */
  exportToken(): string {
    return getEncodedToken({ mint: this.mintUrl, unit: 'sat', proofs: this.proofs().map(toProof) });
  }

  // --- cashing out (NUT-05) -------------------------------------------------------

  async meltQuote(invoice: string): Promise<{ quote: MeltQuoteBolt11Response; amount: number; feeReserve: number }> {
    const w = await this.ready();
    const quote = await w.createMeltQuoteBolt11(invoice.trim());
    return { quote, amount: quote.amount.toNumber(), feeReserve: quote.fee_reserve.toNumber() };
  }

  /** Pay the quoted invoice. Returns what left the wallet in total. */
  melt(quote: MeltQuoteBolt11Response): Promise<number> {
    return this.exclusive(async () => {
      const w = await this.ready();
      const before = this.proofs();
      const need = quote.amount.add(quote.fee_reserve);
      const { keep, send } = await w.send(need, before.map(toProof), { includeFees: true });
      // The swap succeeded: `keep` and `send` together are the wallet now.
      this.save([...keep, ...send].map(toStored));
      try {
        const res = await w.meltProofsBolt11(quote, send);
        this.save([...keep, ...res.change].map(toStored));
      } catch (err) {
        // Unknown outcome. Ask the mint which proofs are really gone.
        await this.reconcileLocked(w);
        throw err;
      }
      return sumStored(before) - this.balance();
    });
  }

  /** Drop proofs the mint says are spent. Safe to call at any time. */
  reconcile(): Promise<number> {
    return this.exclusive(async () => this.reconcileLocked(await this.ready()));
  }

  private async reconcileLocked(w: Wallet): Promise<number> {
    const all = this.proofs();
    if (all.length === 0) return 0;
    const { unspent, pending } = await w.groupProofsByState(all.map(toProof));
    const live = [...unspent, ...pending].map(toStored);
    this.save(live);
    return sumStored(all) - sumStored(live);
  }
}

/** In-memory KV for tests and server-side rendering. */
export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
