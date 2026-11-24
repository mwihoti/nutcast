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
