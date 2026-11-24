import { describe, expect, test } from 'vitest';
import {
  capReached,
  heardSeconds,
  newAccrual,
  recoverAfterReload,
  remainingSats,
  setAsideSats,
  setStreaming,
  settleFlush,
  takeFlush,
  tick,
} from '@/lib/accrual';

const start = (over: Partial<Parameters<typeof newAccrual>[0]> = {}) =>
  setStreaming(newAccrual({ rateSatsPerMin: 4, episodeCapSats: 20, dailyCapSats: 100, ...over }), true);

describe('accrual', () => {
  test('one minute at 4 sats per minute sets aside 4 sats', () => {
    expect(setAsideSats(tick(start(), 60))).toBe(4);
  });

  test('fractions carry over instead of being lost', () => {
    let a = start({ rateSatsPerMin: 1 });
    for (let i = 0; i < 59; i++) a = tick(a, 1);
    expect(setAsideSats(a)).toBe(0);
    a = tick(a, 1);
    expect(setAsideSats(a)).toBe(1);
  });

  test('nothing accrues while streaming is paused', () => {
    let a = tick(start(), 30);
    a = setStreaming(a, false);
    const frozen = a.satSeconds;
    a = tick(a, 600);
    expect(a.satSeconds).toBe(frozen);
    a = tick(setStreaming(a, true), 30);
    expect(setAsideSats(a)).toBe(4);
  });

  test('the episode cap cannot be exceeded however long playback runs', () => {
    let a = start();
    for (let i = 0; i < 10_000; i++) a = tick(a, 1);
    expect(setAsideSats(a)).toBe(20);
    expect(capReached(a)).toBe(true);
    expect(remainingSats(a)).toBe(0);
  });

  test('the daily cap wins when it is the tighter one', () => {
    let a = start({ dailyCapSats: 50, sentTodaySats: 45 });
    for (let i = 0; i < 1000; i++) a = tick(a, 1);
    expect(setAsideSats(a)).toBe(5);
  });

  test('sats in flight and fees count against the cap', () => {
    let a = tick(start(), 150); // 10 sats
    const f = takeFlush(a);
    expect(f.sats).toBe(10);
    a = f.accrual;
    expect(remainingSats(a)).toBe(10);
    a = settleFlush(a, 10, { paid: 8, fees: 2, failed: 0, kept: 0 });
    expect(a.sentEpisodeSats).toBe(10);
    expect(remainingSats(a)).toBe(10);
    for (let i = 0; i < 1000; i++) a = tick(a, 1);
    expect(a.sentEpisodeSats + setAsideSats(a)).toBe(20);
  });

  test('a failed flush is owed again, a kept share is not', () => {
    let a = tick(start(), 150);
    const f = takeFlush(a);
    a = settleFlush(f.accrual, 10, { paid: 5, fees: 0, failed: 3, kept: 2 });
    expect(setAsideSats(a)).toBe(3);
    expect(a.sentEpisodeSats).toBe(5);
    expect(a.inFlightSats).toBe(0);
  });

  test('a flush outcome must add up', () => {
    const f = takeFlush(tick(start(), 150));
    expect(() => settleFlush(f.accrual, 10, { paid: 5, fees: 0, failed: 0, kept: 0 })).toThrow();
  });

  test('takeFlush with less than one sat does nothing', () => {
    const a = tick(start(), 10);
    expect(takeFlush(a).sats).toBe(0);
  });

  test('after a reload, in-flight sats are counted as spent, never forgotten', () => {
    const f = takeFlush(tick(start(), 150));
    const a = recoverAfterReload(f.accrual);
    expect(a.inFlightSats).toBe(0);
    expect(a.sentEpisodeSats).toBe(10);
  });
});

describe('heardSeconds', () => {
  test('normal playback counts', () => {
    expect(heardSeconds(10, 10.25)).toBeCloseTo(0.25);
  });
  test('faster playback counts more media time', () => {
    expect(heardSeconds(10, 10.5)).toBeCloseTo(0.5);
  });
  test('seeking forward or back does not count', () => {
    expect(heardSeconds(10, 200)).toBe(0);
    expect(heardSeconds(200, 10)).toBe(0);
    expect(heardSeconds(10, 10)).toBe(0);
  });
});
