// Streaming accrual: how many sats the listener owes for what they have heard.
//
// This module is pure. It never talks to a mint. The player feeds it media
// time, the settlement code asks it for whole sats to send, and the budget is
// enforced here, before any payment is attempted, so a runaway timer cannot
// spend more than the listener allowed.
//
// Money is tracked in "sat-seconds" (sats per minute x seconds heard), so 60
// sat-seconds is one sat. Only whole sats are ever handed to settlement; the
// fraction stays here until it adds up.

export interface Accrual {
  /** Listener's chosen rate. */
  rateSatsPerMin: number;
  /** Most the listener will spend on this episode. */
  episodeCapSats: number;
  /** Most the listener will spend today, across episodes. */
  dailyCapSats: number;
  /** False means "keep playing, stop paying". */
  streaming: boolean;
  /** Heard but not yet handed to settlement, in sat-seconds. */
  satSeconds: number;
  /** Whole sats handed to settlement and not yet confirmed either way. */
  inFlightSats: number;
  /** Confirmed spend on this episode, fees included. */
  sentEpisodeSats: number;
  /** Confirmed spend today, fees included. */
  sentTodaySats: number;
  /** Media seconds that accrued. */
  mediaSeconds: number;
}

export function newAccrual(opts: {
  rateSatsPerMin: number;
  episodeCapSats: number;
  dailyCapSats: number;
  sentTodaySats?: number;
}): Accrual {
  return {
    rateSatsPerMin: opts.rateSatsPerMin,
    episodeCapSats: opts.episodeCapSats,
    dailyCapSats: opts.dailyCapSats,
    streaming: false,
    satSeconds: 0,
    inFlightSats: 0,
    sentEpisodeSats: 0,
    sentTodaySats: opts.sentTodaySats ?? 0,
    mediaSeconds: 0,
  };
}

/** Sat-seconds that can still accrue before a cap is reached. */
export function roomSatSeconds(a: Accrual): number {
  const episode = a.episodeCapSats - a.sentEpisodeSats - a.inFlightSats;
  const daily = a.dailyCapSats - a.sentTodaySats - a.inFlightSats;
  return Math.max(0, Math.min(episode, daily) * 60 - a.satSeconds);
}

/** Whole sats waiting to be sent. */
export function setAsideSats(a: Accrual): number {
  return Math.floor(a.satSeconds / 60);
}

/** Sats left under the tighter of the two caps. */
export function remainingSats(a: Accrual): number {
  return Math.floor(roomSatSeconds(a) / 60);
}

export function capReached(a: Accrual): boolean {
  return roomSatSeconds(a) <= 0;
}

/**
 * Turn two consecutive player positions into media seconds heard.
 * A jump backwards or a jump of more than a few seconds is a seek, and seeks
 * do not accrue. Playback speed needs no handling: at 1.5x the position simply
 * advances 1.5 media seconds per wall-clock second.
 */
export function heardSeconds(prev: number, now: number, maxStep = 5): number {
  const d = now - prev;
  if (!Number.isFinite(d) || d <= 0 || d > maxStep) return 0;
  return d;
}

/** Accrue for `mediaSeconds` of listening. Clamped to the budget. */
export function tick(a: Accrual, mediaSeconds: number): Accrual {
  if (!a.streaming || mediaSeconds <= 0 || a.rateSatsPerMin <= 0) return a;
  const want = a.rateSatsPerMin * mediaSeconds;
  const add = Math.min(want, roomSatSeconds(a));
  if (add <= 0) return a;
  return {
    ...a,
    satSeconds: a.satSeconds + add,
    mediaSeconds: a.mediaSeconds + mediaSeconds * (add / want),
  };
}

export function setStreaming(a: Accrual, on: boolean): Accrual {
  return a.streaming === on ? a : { ...a, streaming: on };
}

/** Move every whole sat that is set aside into "in flight" for settlement. */
export function takeFlush(a: Accrual): { accrual: Accrual; sats: number } {
  const sats = setAsideSats(a);
  if (sats <= 0) return { accrual: a, sats: 0 };
  return {
    sats,
    accrual: {
      ...a,
      satSeconds: a.satSeconds - sats * 60,
      inFlightSats: a.inFlightSats + sats,
    },
  };
}

export interface FlushOutcome {
  /** Sats that reached recipients. */
  paid: number;
  /** Mint fees, paid out of the flushed sats. They count against the budget. */
  fees: number;
  /** Sats that could not be sent and should be tried again later. */
  failed: number;
  /** Sats that were not sent and will not be retried (unpayable recipients, rounding). */
  kept: number;
}

/** Record what happened to a flush of `sats` taken with takeFlush. */
export function settleFlush(a: Accrual, sats: number, o: FlushOutcome): Accrual {
  if (o.paid + o.fees + o.failed + o.kept !== sats) {
    throw new Error('flush outcome does not add up to the flushed amount');
  }
  const spent = o.paid + o.fees;
  return {
    ...a,
    inFlightSats: Math.max(0, a.inFlightSats - sats),
    satSeconds: a.satSeconds + o.failed * 60,
    sentEpisodeSats: a.sentEpisodeSats + spent,
    sentTodaySats: a.sentTodaySats + spent,
  };
}
