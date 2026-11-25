# Nutcast

Stream sats in ecash while you listen, with a budget you cannot overspend and a pause button. Every payment is split across a show's Podcasting 2.0 value block, and creators claim it and cash out to Lightning.

Built in November 2026 for [Nut November](https://nutnovember.org/), Value4Value track.

> **Test sats only.** The default mint is a public test mint whose invoices pay themselves. Do not point this at a real mint and send real funds: it is a hackathon build.

## What it does

**For listeners** (`/`)

- A Cashu wallet in the browser: top up from a Lightning invoice shown as a scannable QR code, see the balance, export a backup token.
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

Run the fake mint with `PAY_DELAY_MS=8000` to keep each invoice unpaid for a few seconds, so the invoice screen stays visible. For the cash-out step, paste any invoice-shaped string such as `lnbcrt400n1qpzry9x8gf2tvdw0s3jn54khce6mua7l` (40 sats); "Get a test invoice" needs the public test mints.

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

## How it works

```text
listener browser                       server                    creator browser
----------------                       ------                    ---------------
wallet (cashu-ts, localStorage)
accrual: media time -> sats, capped
split: value block -> whole sats
pay: swap to P2PK-locked proofs  --->  POST /api/ecash
     (journal first, then POST)        verify, store locked ---> GET /api/inbox (signed)
                                                                 redeem: swap with own key
                                                                 cash out: melt to bolt11
```

- **`lib/accrual.ts`**: pure. Sats are tracked in sat-seconds, so fractions carry over. The caps are enforced here, before any payment is attempted.
- **`lib/splits.ts`**: pure. Fee recipients come off the top, the rest is shared by weight in whole sats, largest remainder first, ties to the earlier recipient.
- **`lib/pay.ts`**: one function behind boosts and stream flushes. Each share is swapped into proofs locked to the recipient, written to a journal, then POSTed. A closed tab or dead connection never loses a payment: it is re-sent on next open, and the receiver refuses duplicates.
- **`lib/verify.ts`**: the receive endpoint accepts proofs only from a mint it chose, in sats, carrying exactly the recipient's P2PK lock, with a valid mint signature (DLEQ), and unspent at the mint.
- **`lib/store.ts`**: the server stores only locked proofs. It cannot spend them. Reading an inbox needs a signature from the creator's key, because boost messages are personal.

### Protocol pieces used

[NUT-04](https://cashubtc.github.io/nuts/04/) mint, [NUT-05](https://cashubtc.github.io/nuts/05/) melt, [NUT-07](https://cashubtc.github.io/nuts/07/) state check, [NUT-08](https://cashubtc.github.io/nuts/08/) fee return, [NUT-11](https://cashubtc.github.io/nuts/11/) P2PK, [NUT-12](https://cashubtc.github.io/nuts/12/) DLEQ, [NUT-18](https://cashubtc.github.io/nuts/18/) payment requests over HTTP POST, via [`@cashu/cashu-ts`](https://www.npmjs.com/package/@cashu/cashu-ts) 4.13.

### Conventions that are not official

- `<podcast:valueRecipient type="cashu" address="creqA…">` and `<podcast:txt purpose="cashu">` are community conventions, following Nodesignal's CASHU_STREAMING proposal. They are not registered Podcasting 2.0 values.
- The receive endpoint takes `?action=stream` or `?action=boost`, and `?episode=`, in the same spirit. A stream payment never stores a message.

## Limits, stated plainly

- **Ecash recipients only.** Lightning-address, keysend and nutzap recipients are shown as "not payable here". Their share is never sent and stays in the listener's wallet. Most real feeds today are Lightning-address or keysend, so most real feeds are not payable by this build.
- **No refund path.** Tokens are locked to the creator with no timelock. If the receiver permanently refuses a delivery, the token stays in the listener's journal and is not automatically recovered.
- **Closing the tab** does not reliably send what is set aside. It stays recorded and goes out on the next visit.
- **Small leftovers** under a fee-charging mint can stay set aside at the end of an episode instead of being sent.
- **The wallet is localStorage**, with random secrets and no seed phrase. The backup token is the only backup.
- **A mint is a custodian.** Whoever runs the mint holds the bitcoin behind the ecash.
- **The feed loader** fetches addresses typed by visitors. It allows only https and public addresses, re-checks redirects, and caps size and time, but it does not pin DNS between the check and the fetch. Turn it off (`NUTCAST_FEED_PROXY=off`) if you host this somewhere with a sensitive internal network.
- English only. No embed button yet.

## Next steps

Lightning-address payouts with per-recipient thresholds, NIP-61 nutzaps, cross-mint payments, a refund key with a timelock, an embeddable button, and an interop test against a Sovereigncast or nutsplit receiver.

## Prior art and thanks

Nutcast is new code, but the ideas are not all new:

- [Hopp](https://gitlab.com/nodesignal/hopp) by Nodesignal: streaming sats with a daily budget over Lightning, and the accrual rules (media time, seeks do not count) this build follows in spirit.
- [CASHU_STREAMING](https://gitlab.com/nodesignal/podcasting_tools/-/blob/demo/spilman-hackday/CASHU_STREAMING.md): the `purpose="cashu"` tag, the `action=stream` hint and the batching advice.
- [nutboost](https://github.com/HexboxTools/nutboost): Cashu boosts that honour value-block splits, including Lightning-address, nutzap and cross-mint payouts that Nutcast does not do.
- [Squirrel](https://github.com/Anthonyushie/squirrel): offline Cashu gifts for creators.
- [nutsplit](https://github.com/apeirs/nutsplit): show-side ecash receiving.

What Nutcast adds is the listening loop: streaming with a hard budget and a pause that still honours the split, plus a creator inbox to claim and cash out.

AI coding tools were used to write this project.

## License

MIT. See [LICENSE](LICENSE).
