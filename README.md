# Nutcast

Stream sats in ecash while you listen, with a budget you cannot overspend and a pause button. Every payment is split across a show's Podcasting 2.0 value block, and creators claim it and cash out to Lightning.

Built in November 2026 for [Nut November](https://nutnovember.org/), Value4Value track.

> **Test sats only.** The default mint is a public test mint whose invoices pay themselves. Do not point this at a real mint and send real funds: it is a hackathon build.

## What it does

**For listeners** (`/`)

- A Cashu wallet in the browser: top up from a Lightning invoice, see the balance, export a backup token.
- **Streaming sats**: pick sats per minute, an episode budget and a daily budget. Only audio you actually hear counts; seeking does not. "Pause streaming" stops paying at once while playback carries on.
- **A budget that is a hard limit**: mint fees are paid out of the budget, never on top of it. The cost of each payment is read from the prepared swap before anything is sent.
- **Boost with a message**: an amount and a note, split the same way.
- A receipt for every payment, per recipient.

**For creators** (`/creator`)

- A reusable NUT-18 payment request locked to your key, and the feed line to paste into a value block.
- An inbox: boosts with their messages, stream payments kept separate.
- Redeem into your wallet, then pay a Lightning invoice with the fees shown first.

**For anyone, anywhere**

- Nothing in Nutcast is tied to a country, a currency or a payment provider. It needs a browser, a Cashu mint and, to top up or cash out, any Lightning wallet.
- Load any public Podcasting 2.0 feed by address, not only the demo show.
- The operator chooses the mint (`NUTCAST_MINTS`); each mint gets its own wallet in the browser.
- The daily budget resets at the listener's local midnight, and times are shown in the browser's own locale.
- The interface is English only for now.

**Why ecash for this**: a 20-sat payment split three ways is below most Lightning-address minimums. In ecash it is three small tokens.

## Run it

Needs Node.js 22.4 or newer (a cashu-ts requirement). Written and tested on Node 22.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

1. **Top up.** Click "Get invoice". The test mint marks the invoice paid and the balance appears.
2. **Boost.** Type a message, click "Send 64 sats". The receipt shows each recipient's share.
3. **Stream.** Click "Start streaming sats", press play. Watch "set aside" grow. With demo mode on, a payment goes out every 30 seconds of listening. Click "Pause streaming" and it stops growing while the audio carries on.
4. **Claim.** Open `/creator`. The demo host's inbox shows the boost message and the stream payments. Click "Redeem all".
5. **Cash out.** Click "Get a test invoice", then "Show fees", then "Send to Lightning".

To receive as yourself instead of the demo host, click "Create my own key" on the creator page and follow the link back to the listener page.

### Offline, against a local fake mint

The repo includes a tiny fake mint for tests. It also runs standalone, so you can develop with no network:

```bash
npm run fake-mint                                  # http://127.0.0.1:3338
NUTCAST_MINTS=http://127.0.0.1:3338 npm run dev    # in a second terminal
```

For the cash-out step, paste any invoice-shaped string such as `lnbcrt400n1qpzry9x8gf2tvdw0s3jn54khce6mua7l` (40 sats); "Get a test invoice" needs the public test mints.

## Checks

```bash
npm test          # 54 tests
npm run typecheck
npm run build
```

- `test/splits.test.ts`: whole-sat split maths (fees off the top, largest remainder, unpayable recipients).
- `test/accrual.test.ts`: media-time accrual, pause, both budget caps, failed and partial flushes.
- `test/feed.test.ts`: feed parsing, payment requests, the signed inbox handshake.
- `test/global.test.ts`: local-day budget reset and the feed loader's address guard.
- `test/flow.test.ts`: the whole money path against the fake mint, with and without mint input fees: fund, split, pay over NUT-18, receive endpoint, replay and wrong-lock refusals, offline retry, creator redeem, cash-out with change, backup.

`npm run e2e` drives the real pages in Chrome against the fake mint (start the fake mint and `NUTCAST_MINTS=http://127.0.0.1:3338 npx next start -p 3111` first).

**What has not been verified:** everything above ran against the in-repo fake mint, which implements only the parts of the protocol Nutcast uses. The build environment could not reach `testnut.cashu.space`, so the app has **not yet been run against a real mint implementation**. Do the five steps above against the public test mint before recording a demo. The Redis inbox adapter is also untested, and the feed loader has only been tested for what it refuses, not against live podcast hosts.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `NUTCAST_MINTS` | Mints the receive endpoint accepts, comma separated. The first is used by the demo feed and wallets. | `https://testnut.cashu.space` |
| `NUTCAST_ORIGIN` | Public origin, if a proxy hides it. | from the request |
| `NUTCAST_FEED_PROXY` | Set to `off` to disable loading other shows' feeds through the server. | on |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Inbox storage on a serverless host. | file at `.data/inbox.json` |

If the default mint charges input fees, each recipient payment costs a few sats and small stream payments are held back until fees are under half of them. To see every 30-second payment go out in a demo, use `NUTCAST_MINTS=https://nofees.testnut.cashu.space`.

**Hosting:** the file inbox needs a server with a disk that persists. On a serverless host it will lose payments between invocations, so set the Redis variables there.
