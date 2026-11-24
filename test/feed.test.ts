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
