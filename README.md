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
