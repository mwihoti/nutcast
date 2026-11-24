// Browser walk-through against the local fake mint. See README, "Checks".
// Needs Chrome; set CHROME_PATH if it is not at /usr/bin/google-chrome.
import { chromium } from 'playwright';
const base = 'http://127.0.0.1:3111';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 1500 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(base + '/');
await page.getByRole('button', { name: 'Start streaming sats' }).waitFor();
await page.getByRole('button', { name: 'Get invoice' }).click();
await page.getByText('200 test sats added.').waitFor({ timeout: 15000 });
console.log('funded:', await page.locator('.big').first().innerText());

await page.getByPlaceholder('Great episode, thank you!').fill('Great episode, thank you!');
await page.getByLabel('Your name (optional)').fill('Daniel');
await page.getByRole('button', { name: /^Send 64 sats$/ }).click();
await page.getByText(/Boost sent: 64 sats/).waitFor({ timeout: 15000 });
console.log('boost:', await page.locator('.note').first().innerText());
console.log('balance after boost:', await page.locator('.big').first().innerText());

await page.getByLabel('Sats per minute').fill('60');
await page.getByRole('button', { name: 'Start streaming sats' }).click();
await page.evaluate(async () => { const a = document.querySelector('audio'); a.muted = true; a.playbackRate = 4; await a.play(); });
await page.waitForTimeout(4000);
console.log('mid-stream legend:', (await page.locator('.legend').innerText()).replace(/\n/g, ' '));
// pause streaming while audio keeps playing: accrual must freeze
await page.getByRole('button', { name: 'Pause streaming' }).click();
await page.waitForTimeout(2500);
const frozen1 = (await page.locator('.legend').innerText()).replace(/\n/g, ' ');
await page.waitForTimeout(2500);
const frozen2 = (await page.locator('.legend').innerText()).replace(/\n/g, ' ');
console.log('paused legend A:', frozen1); console.log('paused legend B:', frozen2, frozen1 === frozen2 ? '(frozen OK)' : '(CHANGED!)');
await page.getByRole('button', { name: 'Start streaming sats' }).click();
await page.waitForTimeout(12000);
console.log('after cap legend:', (await page.locator('.legend').innerText()).replace(/\n/g, ' '));
console.log('pill:', await page.locator('.pill').first().innerText());
await page.evaluate(() => document.querySelector('audio').pause());
await page.waitForTimeout(2500);
console.log('final legend:', (await page.locator('.legend').innerText()).replace(/\n/g, ' '));
console.log('final balance:', await page.locator('.big').first().innerText());
await page.screenshot({ path: 'docs/screenshots/listener.png', fullPage: true });

// reload: state persists, nothing in flight
await page.reload();
await page.getByRole('button', { name: 'Start streaming sats' }).waitFor();
console.log('after reload legend:', (await page.locator('.legend').innerText()).replace(/\n/g, ' '), '| balance', await page.locator('.big').first().innerText());

await page.goto(base + '/creator');
await page.getByRole('button', { name: 'Redeem all' }).waitFor();
await page.waitForFunction(() => document.querySelector('.big')?.textContent !== '0', null, { timeout: 15000 });
console.log('creator waiting:', await page.locator('.big').first().innerText());
await page.screenshot({ path: 'docs/screenshots/creator-inbox.png', fullPage: true });
await page.getByRole('button', { name: 'Redeem all' }).click();
await page.getByText(/Redeemed \d+ test sats/).waitFor({ timeout: 15000 });
console.log('redeem:', await page.locator('.note').first().innerText());
const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const inv = 'lnbcrt400n1' + Array.from({ length: 40 }, (_, i) => alphabet[(i * 7) % 32]).join('');
await page.getByPlaceholder('lnbc…').fill(inv);
await page.getByRole('button', { name: 'Show fees' }).click();
await page.getByRole('button', { name: /Send 40 sats to Lightning/ }).click();
await page.getByText(/Paid 40 sats/).waitFor({ timeout: 15000 });
console.log('cashout:', await page.locator('.note').first().innerText());
console.log('creator balances:', await page.locator('.big').allInnerTexts());
await page.screenshot({ path: 'docs/screenshots/creator-cashout.png', fullPage: true });

const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
await m.goto(base + '/'); await m.getByRole('button', { name: /streaming/ }).first().waitFor();
await m.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
console.log('mobile overflow px:', await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
console.log('errors:', JSON.stringify(errors));
await browser.close();
