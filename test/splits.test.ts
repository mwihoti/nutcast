import { describe, expect, test } from 'vitest';
import { apportion, computeSplit, type Recipient } from '@/lib/splits';

const r = (name: string, split: number, over: Partial<Recipient> = {}): Recipient => ({
  name,
  type: 'cashu',
  address: 'creqAexample',
  split,
  fee: false,
  ...over,
});
const sats = (plan: ReturnType<typeof computeSplit>) => plan.shares.map((s) => s.sats);

describe('apportion', () => {
  test('always hands out exactly the total', () => {
    for (const total of [0, 1, 2, 7, 20, 99, 100, 1001]) {
      for (const w of [[1], [1, 1], [80, 15], [1, 1, 1], [50, 30, 20], [3, 7, 11, 13]]) {
        expect(apportion(total, w).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
  test('ties go to the earlier recipient', () => {
    expect(apportion(1, [1, 1])).toEqual([1, 0]);
    expect(apportion(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });
  test('largest remainder wins the spare sat', () => {
    // 10 * 2/3 = 6.67, 10 * 1/3 = 3.33
    expect(apportion(10, [2, 1])).toEqual([7, 3]);
  });
});

describe('computeSplit', () => {
  test('fee comes off the top, the rest is shared by weight', () => {
    const plan = computeSplit(100, [r('Host', 80), r('Guest', 15), r('Hosting', 5, { fee: true })]);
    expect(sats(plan)).toEqual([80, 15, 5]);
    expect(plan.payable).toBe(100);
    expect(plan.kept).toBe(0);
  });

  test('a 20-sat stream flush still splits three ways in whole sats', () => {
    const plan = computeSplit(20, [r('Host', 80), r('Guest', 15), r('Hosting', 5, { fee: true })]);
    // fee: floor(20 * 5%) = 1. Remaining 19 at 80:15 = 16 and 3.
    expect(sats(plan)).toEqual([16, 3, 1]);
  });

  test('shares need not add to 100', () => {
    expect(sats(computeSplit(90, [r('A', 2), r('B', 1)]))).toEqual([60, 30]);
  });

  test('single recipient gets everything', () => {
    expect(sats(computeSplit(21, [r('Solo', 100)]))).toEqual([21]);
  });

  test('a tiny amount never invents sats', () => {
    const plan = computeSplit(1, [r('Host', 80), r('Guest', 15), r('Hosting', 5, { fee: true })]);
    expect(sats(plan)).toEqual([1, 0, 0]);
  });

  test('fee-only block is shared by weight', () => {
    expect(sats(computeSplit(10, [r('A', 3, { fee: true }), r('B', 1, { fee: true })]))).toEqual([8, 2]);
  });

  test('unpayable recipients keep their place and their sats stay with the listener', () => {
    const plan = computeSplit(100, [
      r('Host', 50),
      r('Old node', 30, { type: 'node', address: '02abc' }),
      r('Friend', 20, { type: 'lnaddress', address: 'friend@example.com' }),
    ]);
    expect(sats(plan)).toEqual([50, 30, 20]);
    expect(plan.shares.map((s) => s.rail)).toEqual(['cashu', 'unpayable', 'unpayable']);
    expect(plan.payable).toBe(50);
    expect(plan.kept).toBe(50);
  });

  test('zero and negative splits are ignored', () => {
    expect(sats(computeSplit(10, [r('A', 1), r('B', 0), r('C', -5)]))).toEqual([10]);
  });

  test('no recipients means nothing is sent', () => {
    const plan = computeSplit(10, []);
    expect(plan.payable).toBe(0);
    expect(plan.kept).toBe(10);
  });

  test('rejects fractional sats', () => {
    expect(() => computeSplit(1.5, [r('A', 1)])).toThrow();
  });
});
