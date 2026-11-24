import { describe, expect, test } from 'vitest';
import { decodePaymentRequest } from '@cashu/cashu-ts';
import { buildDemoFeed } from '@/lib/demoFeed';
import { DEMO_IDENTITIES } from '@/lib/demo';
import { parseFeed, valueFor } from '@/lib/feed';
import { newKeyPair, signInbox, verifyInbox } from '@/lib/keys';
import { computeSplit } from '@/lib/splits';
import { targetFor } from '@/lib/pay';

const MINT = 'https://testnut.cashu.space';

describe('demo feed', () => {
  const feed = parseFeed(buildDemoFeed('http://localhost:3000', MINT));

  test('parses the show, the episode and three payable recipients', () => {
    expect(feed.title).toBe('The Nutcast Demo Show');
    expect(feed.episodes).toHaveLength(1);
    expect(feed.episodes[0].audioUrl).toBe('http://localhost:3000/demo-episode.mp3');
    const value = valueFor(feed, feed.episodes[0])!;
    expect(value.recipients.map((r) => [r.name, r.split, r.fee])).toEqual([
      ['Demo Host', 80, false],
      ['Demo Guest', 15, false],
      ['Demo Hosting Co', 5, true],
    ]);
    expect(computeSplit(100, value.recipients).payable).toBe(100);
    expect(feed.showCashuRequest).toMatch(/^creqA/);
  });

  test('each recipient address is a locked, mint-pinned NUT-18 request', () => {
    const value = valueFor(feed, feed.episodes[0])!;
    value.recipients.forEach((r, i) => {
      const pr = decodePaymentRequest(r.address);
      expect(pr.unit).toBe('sat');
      expect(pr.amount).toBeUndefined();
      expect(pr.singleUse).toBe(false);
      expect(pr.mints).toEqual([MINT]);
      expect(pr.nut10).toMatchObject({ kind: 'P2PK', data: DEMO_IDENTITIES[i].pubkey });
    });
  });

  test('a creator key replaces the demo host', () => {
    const kp = newKeyPair();
    const mine = parseFeed(buildDemoFeed('http://localhost:3000', MINT, kp.pubkey));
    const host = mine.value!.recipients[0];
    expect(decodePaymentRequest(host.address).nut10?.data).toBe(kp.pubkey);
  });

  test('stream and boost go to the same endpoint with different actions', () => {
    const creq = feed.value!.recipients[0].address;
    const s = new URL(targetFor(creq, 'stream', 'ep 1'));
    expect(s.pathname).toBe('/api/ecash');
    expect(s.searchParams.get('action')).toBe('stream');
    expect(s.searchParams.get('episode')).toBe('ep 1');
    expect(s.searchParams.get('to')).toBe(DEMO_IDENTITIES[0].pubkey);
    expect(new URL(targetFor(creq, 'boost')).searchParams.get('action')).toBe('boost');
  });
});

describe('real-world feed shapes', () => {
  test('item-level block overrides the channel, and non-Cashu recipients are kept', () => {
    const xml = `<rss><channel><title>Show</title>
      <podcast:value type="lightning" method="keysend">
        <podcast:valueRecipient name="Node" type="node" address="02abc" split="100"/>
      </podcast:value>
      <item><title>One</title><guid>g1</guid>
        <podcast:value type="lightning" method="lnaddress">
          <podcast:valueRecipient name="Host" type="lnaddress" address="host@example.com" split="90"/>
          <podcast:valueRecipient name="App" type="lnaddress" address="app@example.com" split="10" fee="true"/>
        </podcast:value>
      </item>
      <item><title>Two</title><guid>g2</guid></item>
    </channel></rss>`;
    const feed = parseFeed(xml);
    expect(valueFor(feed, feed.episodes[0])!.recipients).toHaveLength(2);
    expect(valueFor(feed, feed.episodes[1])!.recipients[0].type).toBe('node');
    const plan = computeSplit(100, valueFor(feed, feed.episodes[0])!.recipients);
    expect(plan.payable).toBe(0);
    expect(plan.kept).toBe(100);
  });

  test('rejects something that is not a feed', () => {
    expect(() => parseFeed('<html></html>')).toThrow();
  });
});

describe('inbox handshake', () => {
  test('a creator signature verifies, anything else does not', () => {
    const kp = newKeyPair();
    const other = newKeyPair();
    const { pubkey, ts, sig } = signInbox(kp, 'list');
    expect(verifyInbox(pubkey, ts, sig, 'list')).toBe(true);
    expect(verifyInbox(pubkey, ts, sig, 'redeem')).toBe(false);
    expect(verifyInbox(other.pubkey, ts, sig, 'list')).toBe(false);
    expect(verifyInbox(pubkey, ts, sig, 'list', ts + 10 * 60 * 1000)).toBe(false);
  });
  test('demo identities sign too', () => {
    for (const d of DEMO_IDENTITIES) {
      const s = signInbox(d, 'list');
      expect(verifyInbox(s.pubkey, s.ts, s.sig, 'list')).toBe(true);
    }
  });
});
