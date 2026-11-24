// End-to-end money path against the in-process fake mint:
// fund -> split -> pay over NUT-18 -> receive endpoint -> creator redeems -> cash out.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getEncodedToken } from '@cashu/cashu-ts';
import { buildDemoFeed } from '@/lib/demoFeed';
import { DEMO_IDENTITIES } from '@/lib/demo';
import { parseFeed } from '@/lib/feed';
import { newKeyPair } from '@/lib/keys';
import { loadJournal, paySplit, retryDeliveries } from '@/lib/pay';
import { receivePayment } from '@/lib/receive';
import { computeSplit } from '@/lib/splits';
import { makeFileStore, type InboxStore } from '@/lib/store';
import { memoryKV, NutWallet, toProof } from '@/lib/wallet';
import { fakeInvoice, startFakeMint, type FakeMint } from './fakeMint';

const ORIGIN = 'http://nutcast.test';

for (const feePpk of [0, 100]) {
  describe(`money path (mint input fee ${feePpk} ppk)`, () => {
    let mint: FakeMint;
    let store: InboxStore;
    let online = true;
    const [host, guest, hosting] = DEMO_IDENTITIES;

    /** Stands in for POST /api/ecash. */
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!online) throw new TypeError('network down');
      const u = new URL(String(url));
      const r = await receivePayment(u.searchParams, String(init?.body ?? ''), store);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;

    beforeAll(async () => {
      mint = await startFakeMint({ feePpk });
      process.env.NUTCAST_MINTS = mint.url;
      store = makeFileStore(path.join(mkdtempSync(path.join(tmpdir(), 'nutcast-')), 'inbox.json'));
    });
    afterAll(async () => {
      await mint.close();
    });

    const recipients = () => parseFeed(buildDemoFeed(ORIGIN, mint.url)).value!.recipients;

    test('boost: 100 sats split three ways, each creator nets their exact share', async () => {
      const kv = memoryKV();
      const listener = new NutWallet(mint.url, 'listener', kv);
      expect(await listener.fundFinish(await listener.fundStart(500))).toBe(true);
      expect(listener.balance()).toBe(500);

      const plan = computeSplit(100, recipients());
      const res = await paySplit(listener, kv, 'listener', plan, {
        action: 'boost',
        memo: 'Great episode, thank you!',
        episode: 'ep-1',
        fetchImpl,
      });

      expect(res.results.map((r) => r.status)).toEqual(['paid', 'paid', 'paid']);
      expect(res.sent).toBe(100);
      expect(res.failed).toBe(0);
      // The wallet is down by exactly what was sent plus the fees reported.
      expect(listener.balance()).toBe(500 - 100 - res.fees);
      if (feePpk === 0) expect(res.fees).toBe(0);
      else expect(res.fees).toBeGreaterThan(0);
      expect(loadJournal(kv, 'listener')).toHaveLength(0);

      for (const [who, want] of [[host, 80], [guest, 15], [hosting, 5]] as const) {
        const inbox = await store.list(who.pubkey);
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ amount: want, action: 'boost', episode: 'ep-1', status: 'received' });
        expect(inbox[0].memo).toBe('Great episode, thank you!');

        // Only the right key can redeem.
        const thief = new NutWallet(mint.url, 'thief', memoryKV());
        await expect(thief.receive(inbox[0].proofs, newKeyPair().privkey)).rejects.toThrow();

        const creator = new NutWallet(mint.url, `creator:${who.id}`, memoryKV());
        expect(await creator.receive(inbox[0].proofs, who.privkey)).toBe(want);
        await store.markRedeemed(who.pubkey, [inbox[0].id]);
        const after = await store.list(who.pubkey);
        expect(after[0].status).toBe('redeemed');
        expect(after[0].proofs).toHaveLength(0);
      }
    });

    test('stream flush: silent, booked as a stream, never as a boost', async () => {
      const kv = memoryKV();
      const listener = new NutWallet(mint.url, 'listener', kv);
      await listener.fundFinish(await listener.fundStart(200));
      const me = newKeyPair();
      const feed = parseFeed(buildDemoFeed(ORIGIN, mint.url, me.pubkey));

      const res = await paySplit(listener, kv, 'listener', computeSplit(20, feed.value!.recipients), {
        action: 'stream',
        memo: 'this must not be stored',
        episode: 'ep-1',
        fetchImpl,
      });
      expect(res.sent).toBe(20);

      const inbox = await store.list(me.pubkey);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ amount: 16, action: 'stream' });
      expect(inbox[0].memo).toBeUndefined();
    });

    test('budget mode: fees come out of the flush, the wallet never pays more than the budget', async () => {
      for (const budget of [20, 13, 7, 40]) {
        const kv = memoryKV();
        const listener = new NutWallet(mint.url, 'listener', kv);
        await listener.fundFinish(await listener.fundStart(200));
        const me = newKeyPair();
        const feed = parseFeed(buildDemoFeed(ORIGIN, mint.url, me.pubkey));
        const res = await paySplit(listener, kv, 'listener', computeSplit(budget, feed.value!.recipients), {
          action: 'stream',
          budget,
          fetchImpl,
        });
        const debit = 200 - listener.balance();
        expect(debit).toBeLessThanOrEqual(budget);
        expect(res.failed).toBe(0);
        if (res.deferred > 0) {
          // Too small to be worth the fees: nothing at all leaves the wallet.
          expect(res.deferred).toBe(budget);
          expect(debit).toBe(0);
          expect(feePpk).toBeGreaterThan(0);
        } else {
          expect(debit).toBe(res.sent + res.fees);
          const got = (await store.list(me.pubkey)).reduce((a, e) => a + e.amount, 0);
          expect(got).toBeGreaterThan(0);
          if (feePpk === 0) {
            expect(res.fees).toBe(0);
            expect(res.sent).toBe(budget);
          } else {
            // Fees are real money to the listener, so they must be reported.
            expect(res.fees).toBeGreaterThan(0);
            expect(res.sent).toBeLessThan(budget);
          }
        }
      }
    });

    test('offline: the payment is journaled, then delivered once on retry', async () => {
      const kv = memoryKV();
      const listener = new NutWallet(mint.url, 'listener', kv);
      await listener.fundFinish(await listener.fundStart(100));
      const me = newKeyPair();
      const feed = parseFeed(buildDemoFeed(ORIGIN, mint.url, me.pubkey));
      const hostOnly = [feed.value!.recipients[0]];

      online = false;
      const res = await paySplit(listener, kv, 'listener', computeSplit(10, hostOnly), { action: 'boost', fetchImpl });
      expect(res.results[0].status).toBe('queued');
      expect(res.sent).toBe(10);
      expect(loadJournal(kv, 'listener')).toHaveLength(1);
      expect(await store.list(me.pubkey)).toHaveLength(0);

      online = true;
      const saved = loadJournal(kv, 'listener')[0];
      expect(await retryDeliveries(kv, 'listener', fetchImpl)).toBe(1);
      expect(loadJournal(kv, 'listener')).toHaveLength(0);
      expect(await store.list(me.pubkey)).toHaveLength(1);

      // Replaying the same body is refused, so a creator is never credited twice.
      const replay = await receivePayment(new URL(saved.target).searchParams, saved.body, store);
      expect(replay.status).toBe(409);
      expect(await store.list(me.pubkey)).toHaveLength(1);
    });

    test('the endpoint refuses what it should', async () => {
      const kv = memoryKV();
      const listener = new NutWallet(mint.url, 'listener', kv);
      await listener.fundFinish(await listener.fundStart(100));
      const a = newKeyPair();
      const b = newKeyPair();
      const feedA = parseFeed(buildDemoFeed(ORIGIN, mint.url, a.pubkey));
      const creqA = feedA.value!.recipients[0].address;

      // Proofs locked to A, posted to B's inbox.
      const paid = (await listener.payRequest(creqA, 5))!;
      const body = JSON.stringify({
        unit: 'sat',
        mint: mint.url,
        proofs: paid.send.map((p) => ({ ...p, amount: Number(p.amount) })),
      });
      const wrong = await receivePayment(new URLSearchParams({ to: b.pubkey }), body, store);
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('wrong_lock');

      // Unlocked proofs: anyone could spend them, so they are not a payment to A.
      const plain = JSON.stringify({ unit: 'sat', mint: mint.url, proofs: listener.proofs().slice(0, 1) });
      expect((await receivePayment(new URLSearchParams({ to: a.pubkey }), plain, store)).body.error).toBe('wrong_lock');

      // A mint the server never chose.
      const evil = body.replace(mint.url, 'https://evil.example');
      const untrusted = await receivePayment(new URLSearchParams({ to: a.pubkey }), evil, store);
      expect(untrusted.body.error).toBe('untrusted_mint');
      expect(untrusted.body.accepted_mints).toEqual([mint.url]);

      // Garbage.
      expect((await receivePayment(new URLSearchParams({ to: a.pubkey }), 'nope', store)).status).toBe(400);
      expect((await receivePayment(new URLSearchParams({ to: 'zz' }), body, store)).body.error).toBe('bad_recipient');

      // The honest delivery still works, and spent proofs are refused afterwards.
      const ok = await receivePayment(new URLSearchParams({ to: a.pubkey }), body, store);
      expect(ok.status).toBe(200);
      expect(ok.body.amount_sats).toBe(5);
      const creator = new NutWallet(mint.url, 'creator', memoryKV());
      const inbox = await store.list(a.pubkey);
      await creator.receive(inbox[0].proofs, a.privkey);
      const store2 = makeFileStore(path.join(mkdtempSync(path.join(tmpdir(), 'nutcast-')), 'inbox.json'));
      const spent = await receivePayment(new URLSearchParams({ to: a.pubkey }), body, store2);
      expect(spent.body.error).toBe('spent');
    });

    test('not enough balance: nothing leaves the wallet and the share is marked failed', async () => {
      const kv = memoryKV();
      const listener = new NutWallet(mint.url, 'listener', kv);
      await listener.fundFinish(await listener.fundStart(10));
      const res = await paySplit(listener, kv, 'listener', computeSplit(100, recipients()), { action: 'boost', fetchImpl });
      expect(res.sent).toBeLessThan(100);
      expect(res.failed).toBeGreaterThan(0);
      expect(listener.balance()).toBe(10 - res.sent - res.fees);
    });

    test('creator cashes out to a Lightning invoice, change comes back', async () => {
      const creator = new NutWallet(mint.url, 'creator', memoryKV());
      await creator.fundFinish(await creator.fundStart(300));
      const { quote, amount, feeReserve } = await creator.meltQuote(fakeInvoice(200));
      expect(amount).toBe(200);
      expect(feeReserve).toBeGreaterThan(0);
      const spent = await creator.melt(quote);
      // The fake payment is free, so only the amount and mint input fees are gone.
      expect(spent).toBeGreaterThanOrEqual(200);
      expect(spent).toBeLessThanOrEqual(200 + feeReserve + 3);
      expect(creator.balance()).toBe(300 - spent);
      expect(await creator.reconcile()).toBe(0);
    });

    test('backup token round-trips into another wallet', async () => {
      const a = new NutWallet(mint.url, 'a', memoryKV());
      await a.fundFinish(await a.fundStart(64));
      const token = a.exportToken();
      expect(token.startsWith('cashuB')).toBe(true);
      expect(token).toBe(getEncodedToken({ mint: mint.url, unit: 'sat', proofs: a.proofs().map(toProof) }));
      const b = new NutWallet(mint.url, 'b', memoryKV());
      const got = await b.receive(token);
      expect(got).toBeGreaterThan(64 - 3);
      // The old copy is now worthless, and reconcile notices.
      expect(await a.reconcile()).toBe(64);
      expect(a.balance()).toBe(0);
    });
  });
}
