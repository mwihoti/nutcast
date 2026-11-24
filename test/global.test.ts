import { describe, expect, test } from 'vitest';
import { localDay } from '@/lib/day';
import { fetchFeed, isPrivateAddress } from '@/lib/feedProxy';

describe('localDay', () => {
  test('uses the local calendar, not UTC', () => {
    // Built from local parts, so it holds in every time zone the tests run in.
    expect(localDay(new Date(2026, 10, 27, 23, 59))).toBe('2026-11-27');
    expect(localDay(new Date(2026, 10, 28, 0, 1))).toBe('2026-11-28');
    expect(localDay(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});

describe('feed proxy guard', () => {
  test('private and special addresses are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  test('public addresses pass', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  test('refuses plain http, logins, loopback and nonsense before any request is made', async () => {
    await expect(fetchFeed('http://example.com/feed.xml')).rejects.toThrow(/https/);
    await expect(fetchFeed('https://user:pw@example.com/feed.xml')).rejects.toThrow(/login/);
    await expect(fetchFeed('https://127.0.0.1/feed.xml')).rejects.toThrow(/not public/);
    await expect(fetchFeed('https://[::1]/feed.xml')).rejects.toThrow(/not public/);
    await expect(fetchFeed('file:///etc/passwd')).rejects.toThrow(/https/);
    await expect(fetchFeed('nope')).rejects.toThrow(/valid/);
  });
});
