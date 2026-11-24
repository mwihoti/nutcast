# Notes for the Nut November submission form

Paste into the form's Notes field and trim to fit. Lines in [brackets] need your decision.

---

Nutcast is a new project. All code, documentation and design in this repository were written in November 2026 for Nut November. Nothing in this repo existed before 1 November 2026.

[Keep only if true: I am a first-time Cashu contributor.] I also build PaidDrop (creator payments) and Ubu-Tangaza (referral rewards). Those products existed before November and none of their code is in this repository.

Nutcast is a listener-and-creator Value4Value kit: a Cashu wallet in the browser; streaming sats while an episode plays, with an episode and daily budget that mint fees cannot push past, and a pause; boosts with a message; payouts split across a podcast's Podcasting 2.0 value block as ecash over NUT-18; and a creator inbox to redeem and cash out to Lightning.

It pays ecash recipients only. Lightning-address, keysend and nutzap recipients are shown but not paid in this build.

It follows Nodesignal's CASHU_STREAMING conventions where they apply (the purpose="cashu" tag, action=stream, batching). It is not a fork of Hopp.

Prior work I learned from and credit in the README: Hopp (streaming with a budget over Lightning, ADR 0014), nutboost (Cashu boosts across value-block splits), Squirrel (offline Cashu gifts) and nutsplit (show-side ecash receiving).

AI coding tools were used, as the rules allow. [Add what you tested yourself against the public test mint.]

---

## Before you submit

- [ ] Run the five README steps against the public test mint, not just the fake mint.
- [ ] Public repo, MIT `LICENSE` at the root, default branch builds.
- [ ] Demo video under 3 minutes, linked in the form and README.
- [ ] A `#NutNovember` post with the repo link.
- [ ] Submit well before the deadline: Friday 27 November 2026, 23:59 UTC.
