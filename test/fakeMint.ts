// A tiny in-process Cashu mint for tests. It speaks just enough of NUT-00..08,
// NUT-11 and NUT-12 for the wallet to mint, swap, check state and melt, and it
// "pays" every invoice, like the public FakeWallet test mints.
//
// It exists because CI (and the sandbox this was written in) cannot reach the
// public test mints. It is NOT a real mint and must never hold real value.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  hashToCurve,
  isP2PKSpendAuthorised,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** bolt11-shaped string: cashu-ts reads the amount from the prefix. */
export function fakeInvoice(sats: number): string {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const tail = Array.from(randomBytes(40), (b) => alphabet[b % 32]).join('');
  return `lnbcrt${sats * 10}n1${tail}`;
}

interface Quote {
  quote: string;
  request: string;
  amount: number;
  state: string;
}

export interface FakeMint {
  url: string;
  close(): Promise<void>;
  /** Number of swaps served, for assertions. */
  swaps(): number;
}

export async function startFakeMint(
  opts: { feePpk?: number; port?: number; cors?: boolean; payDelayMs?: number } = {},
): Promise<FakeMint> {
  const feePpk = opts.feePpk ?? 0;
  const pair = createNewMintKeys(20, randomBytes(32), { input_fee_ppk: feePpk, unit: 'sat' });
  const id = pair.keysetId;
  const spent = new Set<string>();
  const mintQuotes = new Map<string, Quote>();
  const meltQuotes = new Map<string, Quote & { fee_reserve: number }>();
  let swapCount = 0;

  const pubKeys: Record<string, string> = {};
  for (const [amt, key] of Object.entries(pair.pubKeys)) pubKeys[amt] = hex(key);

  const Y = (secret: string) => hashToCurve(utf8(secret)).toHex(true);
  const fee = (n: number) => Math.ceil((n * feePpk) / 1000);

  function sign(out: { amount: number | string; B_: string }) {
    const priv = pair.privKeys[String(out.amount)];
    if (!priv) throw err(400, `no key for amount ${out.amount}`);
    const B = pointFromHex(out.B_);
    const sig = createBlindSignature(B, priv, id);
    const dleq = createDLEQProof(B, priv);
    return {
      id,
      amount: Number(out.amount),
      C_: sig.C_.toHex(true),
      dleq: { e: hex(dleq.e), s: hex(dleq.s) },
    };
  }

  function verifyInputs(inputs: Proof[]): number {
    let total = 0;
    const seen = new Set<string>();
    for (const p of inputs) {
      const amount = Number(p.amount);
      const priv = pair.privKeys[String(amount)];
      if (!priv || p.id !== id) throw err(400, 'unknown keyset or amount');
      const y = Y(p.secret);
      if (spent.has(y) || seen.has(y)) throw err(400, 'Token already spent.', 11001);
      seen.add(y);
      const expected = hashToCurve(utf8(p.secret)).multiply(BigInt('0x' + hex(priv)));
      if (expected.toHex(true) !== p.C) throw err(400, 'Proof could not be verified', 10003);
      if (p.secret.startsWith('["P2PK"') && !isP2PKSpendAuthorised({ ...p, amount: p.amount } as Proof)) {
        throw err(400, 'Witness is missing or invalid for P2PK proof', 20008);
      }
      total += amount;
    }
    return total;
  }

  const burn = (inputs: Proof[]) => inputs.forEach((p) => spent.add(Y(p.secret)));
  const sumOut = (outs: Array<{ amount: number | string }>) => outs.reduce((a, o) => a + Number(o.amount), 0);

  function err(status: number, detail: string, code = 0) {
    return Object.assign(new Error(detail), { status, body: { detail, code } });
  }

  async function route(method: string, path: string, body: any): Promise<unknown> {
    if (method === 'GET' && path === '/v1/info') {
      return {
        name: 'Nutcast fake test mint',
        pubkey: pubKeys['1'],
        version: 'fake/0.0.1',
        nuts: {
          '4': { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 500000 }], disabled: false },
          '5': { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 500000 }], disabled: false },
          '7': { supported: true },
          '8': { supported: true },
          '10': { supported: true },
          '11': { supported: true },
          '12': { supported: true },
        },
      };
    }
    if (method === 'GET' && path === '/v1/keysets') {
      return { keysets: [{ id, unit: 'sat', active: true, input_fee_ppk: feePpk }] };
    }
    if (method === 'GET' && (path === '/v1/keys' || path === `/v1/keys/${id}`)) {
      return { keysets: [{ id, unit: 'sat', active: true, input_fee_ppk: feePpk, keys: pubKeys }] };
    }

    if (method === 'POST' && path === '/v1/mint/quote/bolt11') {
      const q: Quote = {
        quote: hex(randomBytes(12)),
        request: fakeInvoice(Number(body.amount)),
        amount: Number(body.amount),
        // FakeWallet behaviour: every invoice gets paid by itself. With
        // payDelayMs it stays unpaid for a moment, like a real payment would.
        state: opts.payDelayMs ? 'UNPAID' : 'PAID',
      };
      mintQuotes.set(q.quote, q);
      if (opts.payDelayMs) setTimeout(() => (q.state = 'PAID'), opts.payDelayMs).unref();
      return { ...q, unit: 'sat', expiry: Math.floor(Date.now() / 1000) + 3600 };
    }
    if (method === 'GET' && path.startsWith('/v1/mint/quote/bolt11/')) {
      const q = mintQuotes.get(path.split('/').pop()!);
      if (!q) throw err(404, 'quote not found');
      return { ...q, unit: 'sat', expiry: Math.floor(Date.now() / 1000) + 3600 };
    }
    if (method === 'POST' && path === '/v1/mint/bolt11') {
      const q = mintQuotes.get(body.quote);
      if (!q) throw err(404, 'quote not found');
      if (q.state !== 'PAID') throw err(400, 'quote not paid or already issued', 20002);
      if (sumOut(body.outputs) !== q.amount) throw err(400, 'outputs do not match quote amount');
      q.state = 'ISSUED';
      return { signatures: body.outputs.map(sign) };
    }

    if (method === 'POST' && path === '/v1/swap') {
      const total = verifyInputs(body.inputs);
      if (total - fee(body.inputs.length) !== sumOut(body.outputs)) {
        throw err(400, 'Transaction is not balanced', 11002);
      }
      burn(body.inputs);
      swapCount += 1;
      return { signatures: body.outputs.map(sign) };
    }

    if (method === 'POST' && path === '/v1/checkstate') {
      return {
        states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? 'SPENT' : 'UNSPENT', witness: null })),
      };
    }

    if (method === 'POST' && path === '/v1/melt/quote/bolt11') {
      const m = /^lnbcrt(\d+)n1/.exec(String(body.request));
      if (!m) throw err(400, 'not a fake invoice');
      const amount = Number(m[1]) / 10;
      const q = {
        quote: hex(randomBytes(12)),
        request: String(body.request),
        amount,
        fee_reserve: Math.max(2, Math.ceil(amount / 100)),
        state: 'UNPAID',
      };
      meltQuotes.set(q.quote, q);
      return { ...q, unit: 'sat', expiry: Math.floor(Date.now() / 1000) + 3600, payment_preimage: null };
    }
    if (method === 'GET' && path.startsWith('/v1/melt/quote/bolt11/')) {
      const q = meltQuotes.get(path.split('/').pop()!);
      if (!q) throw err(404, 'quote not found');
      return { ...q, unit: 'sat', expiry: Math.floor(Date.now() / 1000) + 3600, payment_preimage: null };
    }
    if (method === 'POST' && path === '/v1/melt/bolt11') {
      const q = meltQuotes.get(body.quote);
      if (!q) throw err(404, 'quote not found');
      if (q.state === 'PAID') throw err(400, 'quote already paid', 20006);
      const total = verifyInputs(body.inputs);
      const need = q.amount + q.fee_reserve + fee(body.inputs.length);
      if (total < need) throw err(400, 'not enough inputs for amount plus fees', 11002);
      burn(body.inputs);
      q.state = 'PAID';
      // The fake "payment" costs nothing, so the whole reserve (and any
      // overpayment) comes back as NUT-08 change on the blank outputs.
      let back = total - q.amount - fee(body.inputs.length);
      const change = [];
      for (const out of (body.outputs ?? []) as Array<{ B_: string }>) {
        if (back <= 0) break;
        const amt = 2 ** Math.floor(Math.log2(back));
        change.push(sign({ amount: amt, B_: out.B_ }));
        back -= amt;
      }
      return {
        ...q,
        unit: 'sat',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        payment_preimage: '00'.repeat(32),
        change,
      };
    }
    throw err(404, `no route ${method} ${path}`);
  }

  const cors: Record<string, string> = opts.cors
    ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    : {};
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const out = await route(req.method ?? 'GET', path, raw ? JSON.parse(raw) : undefined);
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify(out));
      } catch (e: any) {
        res.writeHead(e.status ?? 500, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify(e.body ?? { detail: String(e?.message ?? e), code: 0 }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    swaps: () => swapCount,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
