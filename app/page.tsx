'use client';

// Listener page: wallet, player with streaming sats, boost, receipts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodePaymentRequest } from '@cashu/cashu-ts';
import { Copy } from '@/components/Copy';
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
  type Accrual,
} from '@/lib/accrual';
import { localDay } from '@/lib/day';
import { parseFeed, valueFor, type Episode, type Feed } from '@/lib/feed';
import { loadJournal, paySplit, retryDeliveries, type Action, type PayResult } from '@/lib/pay';
import { computeSplit } from '@/lib/splits';
import { NutWallet, type FundQuote } from '@/lib/wallet';

const NS = 'listener';
const FLUSH_SECONDS = 300; // five minutes of listening, as CASHU_STREAMING suggests
const DEMO_FLUSH_SECONDS = 30;

interface Settings {
  rate: number;
  episodeCap: number;
  dailyCap: number;
  demo: boolean;
}
const DEFAULT_SETTINGS: Settings = { rate: 4, episodeCap: 20, dailyCap: 100, demo: true };

interface Receipt {
  id: string;
  at: number;
  action: Action;
  total: number;
  sent: number;
  fees: number;
  message?: string;
  lines: { name: string; sats: number; status: string; note?: string }[];
}

const today = localDay;
const clampInt = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function receiptFrom(action: Action, total: number, res: PayResult, message?: string): Receipt {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    action,
    total,
    sent: res.sent,
    fees: res.fees,
    message,
    lines: res.results.map((r) => ({
      name: r.share.recipient.name || r.share.recipient.type,
      sats: r.share.sats,
      status: r.status,
      note: r.error,
    })),
  };
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'paid',
  queued: 'sent, delivery pending',
  failed: 'not sent',
  kept: 'kept',
};

export default function ListenerPage() {
  const [feed, setFeed] = useState<Feed>();
  const [loadError, setLoadError] = useState<string>();
  const [balance, setBalance] = useState(0);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [accrual, setAccrual] = useState<Accrual>();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState<{ kind: 'bad' | 'good' | 'info'; text: string }>();
  const [flushing, setFlushing] = useState(false);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [fallbackMint, setFallbackMint] = useState<string>();
  const [feedSource, setFeedSource] = useState<string>();
  const [feedInput, setFeedInput] = useState('');
  const dayRef = useRef(localDay());
  const [waitingOnFees, setWaitingOnFees] = useState(false);

  const [fundAmount, setFundAmount] = useState(200);
  const [fund, setFund] = useState<FundQuote>();
  const [funding, setFunding] = useState(false);
  const [backup, setBackup] = useState<string>();

  const [boostAmount, setBoostAmount] = useState(64);
  const [boostName, setBoostName] = useState('');
  const [boostMessage, setBoostMessage] = useState('');
  const [boosting, setBoosting] = useState(false);

  const walletRef = useRef<NutWallet | undefined>(undefined);
  const accrualRef = useRef<Accrual | undefined>(undefined);
  const settingsRef = useRef(settings);
  const flushingRef = useRef(false);
  const heldForFees = useRef(false);
  const lastPos = useRef(0);
  const lastFlushMedia = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const episode: Episode | undefined = feed?.episodes[episodeIndex] ?? feed?.episodes[0];
  const recipients = useMemo(() => (feed && episode ? valueFor(feed, episode)?.recipients ?? [] : []), [feed, episode]);
  const mintUrl = useMemo(() => {
    for (const r of recipients) {
      try {
        const m = decodePaymentRequest(r.address).mints?.[0];
        if (m) return m;
      } catch {
        /* not a payment request */
      }
    }
    // A show with no ecash recipients still needs a wallet to exist.
    return fallbackMint;
  }, [recipients, fallbackMint]);

  const accrualKey = episode ? `nutcast:${NS}:accrual:${episode.guid}` : undefined;

  const commit = useCallback(
    (a: Accrual) => {
      accrualRef.current = a;
      setAccrual(a);
      if (accrualKey) localStorage.setItem(accrualKey, JSON.stringify(a));
      localStorage.setItem(`nutcast:${NS}:day`, JSON.stringify({ date: today(), sent: a.sentTodaySats }));
    },
    [accrualKey],
  );

  const refresh = useCallback(() => {
    if (walletRef.current) setBalance(walletRef.current.balance());
    setPending(loadJournal(localStorage, NS).length);
  }, []);

  const addReceipt = useCallback((r: Receipt) => {
    setReceipts((prev) => {
      const next = [r, ...prev].slice(0, 30);
      localStorage.setItem(`nutcast:${NS}:receipts`, JSON.stringify(next));
      return next;
    });
  }, []);

  // --- load the feed ----------------------------------------------------------
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const external = q.get('feed') ?? undefined;
    setFeedSource(external);
    setFeedInput(external ?? '');
    // Any public feed goes through the server, because podcast hosts rarely
    // allow browsers to read their feeds directly.
    const feedUrl = external
      ? `/api/feed?url=${encodeURIComponent(external)}`
      : `/api/demo-feed${q.get('host') ? `?host=${encodeURIComponent(q.get('host')!)}` : ''}`;
    fetch(feedUrl)
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().then((j) => j.error as string).catch(() => undefined);
          throw new Error(detail ?? `the server answered ${r.status}`);
        }
        return r.text();
      })
      .then((xml) => {
        const parsed = parseFeed(xml);
        if (parsed.episodes.length === 0) throw new Error('this feed has no episodes');
        setFeed(parsed);
      })
      .catch((e) => setLoadError(`Could not load the show: ${e.message}`));
    fetch('/api/config')
      .then((r) => r.json())
      .then((c: { mints: string[] }) => setFallbackMint(c.mints[0]))
      .catch(() => undefined);
    setSettings(readJSON(`nutcast:${NS}:settings`, DEFAULT_SETTINGS));
    setReceipts(readJSON(`nutcast:${NS}:receipts`, []));
  }, []);

  // --- wallet and saved accrual, once the feed tells us the mint ----------------
  useEffect(() => {
    if (!mintUrl || !accrualKey) return;
    // One wallet per mint: ecash from different mints must never be mixed.
    const w = new NutWallet(mintUrl, `${NS}@${mintUrl}`, localStorage);
    walletRef.current = w;

    const s = readJSON(`nutcast:${NS}:settings`, DEFAULT_SETTINGS);
    const day = readJSON(`nutcast:${NS}:day`, { date: today(), sent: 0 });
    const saved = readJSON<Accrual | null>(accrualKey, null);
    const base =
      saved ?? newAccrual({ rateSatsPerMin: s.rate, episodeCapSats: s.episodeCap, dailyCapSats: s.dailyCap });
    const a = recoverAfterReload({
      ...base,
      rateSatsPerMin: s.rate,
      episodeCapSats: s.episodeCap,
      dailyCapSats: s.dailyCap,
      sentTodaySats: day.date === today() ? day.sent : 0,
      streaming: false,
    });
    lastFlushMedia.current = a.mediaSeconds;
    commit(a);
    refresh();

    // Finish anything a closed tab left behind.
    const pendingFund = w.pendingFund();
    if (pendingFund) setFund(pendingFund);
    retryDeliveries(localStorage, NS).then(refresh).catch(() => undefined);
    w.reconcile().then(refresh).catch(() => undefined);
  }, [mintUrl, accrualKey, commit, refresh]);

  // --- settings ------------------------------------------------------------------
  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    localStorage.setItem(`nutcast:${NS}:settings`, JSON.stringify(next));
    if (accrualRef.current) {
      commit({
        ...accrualRef.current,
        rateSatsPerMin: next.rate,
        episodeCapSats: next.episodeCap,
        dailyCapSats: next.dailyCap,
      });
    }
  };
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // --- settlement ------------------------------------------------------------------
  const flush = useCallback(async () => {
    const w = walletRef.current;
    const current = accrualRef.current;
    if (!w || !current || flushingRef.current) return;
    const { accrual: taken, sats } = takeFlush(current);
    if (sats <= 0) return;

    flushingRef.current = true;
    setFlushing(true);
    commit(taken);
    try {
      const plan = computeSplit(sats, recipients);
      // Fees come out of what was set aside, never on top.
      const res = await paySplit(w, localStorage, NS, plan, { action: 'stream', episode: episode?.guid, budget: sats });
      const retry = res.failed + res.deferred;
      const kept = sats - res.sent - res.fees - retry;
      let next = settleFlush(accrualRef.current!, sats, { paid: res.sent, fees: res.fees, failed: retry, kept });
      if (res.failed > 0) {
        next = setStreaming(next, false);
        setNotice({
          kind: 'bad',
          text: `Streaming stopped: ${res.failed} sats could not be sent (${res.results.find((r) => r.status === 'failed')?.error ?? 'unknown error'}). They stay set aside.`,
        });
      }
      heldForFees.current = res.deferred > 0;
      setWaitingOnFees(res.deferred > 0);
      commit(next);
      if (res.sent > 0) addReceipt(receiptFrom('stream', sats, res));
    } catch (e) {
      commit(settleFlush(accrualRef.current!, sats, { paid: 0, fees: 0, failed: sats, kept: 0 }));
      setNotice({ kind: 'bad', text: `Flush failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      lastFlushMedia.current = accrualRef.current!.mediaSeconds;
      flushingRef.current = false;
      setFlushing(false);
      refresh();
    }
  }, [addReceipt, commit, episode?.guid, recipients, refresh]);

  // Flush after enough listening, and when the tab goes to the background.
  useEffect(() => {
    const timer = setInterval(() => {
      let a = accrualRef.current;
      if (!a) return;
      // Local midnight: the daily budget starts again.
      if (dayRef.current !== localDay()) {
        dayRef.current = localDay();
        a = { ...a, sentTodaySats: 0 };
        commit(a);
      }
      const every = settingsRef.current.demo ? DEMO_FLUSH_SECONDS : FLUSH_SECONDS;
      // Also settle straight away once the budget is reached: no more listening
      // time will accrue to trigger the next batch.
      const capped = a.streaming && capReached(a) && setAsideSats(a) > 0 && !heldForFees.current;
      if (a.mediaSeconds - lastFlushMedia.current >= every || capped) void flush();
    }, 1000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flush, commit]);

  // --- player events ----------------------------------------------------------------
  const onTimeUpdate = () => {
    const audio = audioRef.current;
    const a = accrualRef.current;
    if (!audio || !a) return;
    const heard = heardSeconds(lastPos.current, audio.currentTime);
    lastPos.current = audio.currentTime;
    if (heard > 0 && !audio.paused) {
      const next = tick(a, heard);
      if (next !== a) commit(next);
    }
  };
  const resync = () => {
    if (audioRef.current) lastPos.current = audioRef.current.currentTime;
  };

  const toggleStreaming = () => {
    const a = accrualRef.current;
    if (!a) return;
    setNotice(undefined);
    if (a.streaming) {
      commit(setStreaming(a, false));
      void flush(); // settle what was heard so far
    } else {
      if (computeSplit(100, recipients).payable <= 0) {
        setNotice({ kind: 'bad', text: 'This show has no ecash recipients, so there is nobody Nutcast can pay yet.' });
        return;
      }
      if (balance <= 0) {
        setNotice({ kind: 'bad', text: 'Add some sats to the wallet first.' });
        return;
      }
      commit(setStreaming(a, true));
    }
  };

  // --- funding -------------------------------------------------------------------------
  const startFund = async () => {
    const w = walletRef.current;
    if (!w) return;
    setFunding(true);
    setNotice(undefined);
    try {
      setFund(await w.fundStart(clampInt(String(fundAmount), 1, 5000)));
    } catch (e) {
      setNotice({ kind: 'bad', text: `Could not get an invoice from the mint: ${e instanceof Error ? e.message : e}` });
    } finally {
      setFunding(false);
    }
  };

  // Poll the mint until the invoice is paid, then mint the ecash.
  useEffect(() => {
    if (!fund) return;
    let stop = false;
    let tries = 0;
    const poll = async () => {
      const w = walletRef.current;
      if (stop || !w) return;
      try {
        if (await w.fundFinish(fund)) {
          setFund(undefined);
          refresh();
          setNotice({ kind: 'good', text: `${fund.amount} test sats added.` });
          return;
        }
      } catch (e) {
        if (++tries > 5) {
          setNotice({ kind: 'bad', text: `Top-up failed: ${e instanceof Error ? e.message : e}` });
          w.cancelFund();
          setFund(undefined);
          return;
        }
      }
      if (!stop) setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [fund, refresh]);

  // --- boost -----------------------------------------------------------------------------
  const boostPlan = useMemo(() => {
    const amt = clampInt(String(boostAmount), 0, 100000);
    return amt > 0 && recipients.length ? computeSplit(amt, recipients) : undefined;
  }, [boostAmount, recipients]);

  const sendBoost = async () => {
    const w = walletRef.current;
    if (!w || !boostPlan) return;
    setBoosting(true);
    setNotice(undefined);
    const text = boostMessage.trim();
    const memo = [boostName.trim(), text].filter(Boolean).join(': ') || undefined;
    try {
      const res = await paySplit(w, localStorage, NS, boostPlan, { action: 'boost', memo, episode: episode?.guid });
      addReceipt(receiptFrom('boost', boostPlan.total, res, memo));
      if (res.failed > 0) {
        setNotice({
          kind: 'bad',
          text: `${res.failed} of ${boostPlan.total} sats were not sent (${res.results.find((r) => r.status === 'failed')?.error ?? 'unknown error'}).`,
        });
      } else {
        setNotice({ kind: 'good', text: `Boost sent: ${res.sent} sats${res.fees ? ` plus ${res.fees} in mint fees` : ''}.` });
        setBoostMessage('');
      }
    } catch (e) {
      setNotice({ kind: 'bad', text: `Boost failed: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBoosting(false);
      refresh();
    }
  };

  // --- render ------------------------------------------------------------------------------
  if (loadError) {
    return (
      <main className="wrap">
        <p className="note bad">{loadError}</p>
        <p className="gap-top">
          <a href="/">Back to the demo show</a>
        </p>
      </main>
    );
  }
  if (!feed || !episode || !accrual) {
    return (
      <main className="wrap">
        <p className="muted">Loading the show…</p>
      </main>
    );
  }

  const aside = setAsideSats(accrual) + accrual.inFlightSats;
  const remaining = remainingSats(accrual);
  const cap = Math.max(1, accrual.episodeCapSats);
  const flushEvery = settings.demo ? DEMO_FLUSH_SECONDS : FLUSH_SECONDS;
  const untilFlush = Math.max(0, Math.ceil(flushEvery - (accrual.mediaSeconds - lastFlushMedia.current)));
  const payableOf100 = computeSplit(100, recipients).payable;
  const unpayable = recipients.filter((r) => computeSplit(100, [r]).payable === 0);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="brand">
            Nut<span>cast</span>
          </div>
          <div className="tag">Stream sats in ecash while you listen. Set a budget. Pause any time.</div>
        </div>
        <nav className="nav">
          <a href="/creator">Creator inbox →</a>
        </nav>
      </header>

      {notice && (
        <p className={`note ${notice.kind === 'info' ? '' : notice.kind}`} role="status" style={{ marginBottom: 16 }}>
          {notice.text}
        </p>
      )}

      <div className="grid">
        <div className="col">
          <section className="card">
            <h2>{feed.title}</h2>
            <h3>{episode.title}</h3>
            {feed.episodes.length > 1 && (
              <label className="field gap-top">
                Episode
                <select
                  value={feed.episodes.indexOf(episode)}
                  onChange={async (e) => {
                    const i = Number(e.target.value);
                    audioRef.current?.pause();
                    if (accrualRef.current) commit(setStreaming(accrualRef.current, false));
                    await flush();
                    setEpisodeIndex(i);
                  }}
                >
                  {feed.episodes.slice(0, 50).map((ep, i) => (
                    <option key={ep.guid} value={i}>
                      {ep.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {episode.audioUrl ? (
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={episode.audioUrl}
                onTimeUpdate={onTimeUpdate}
                onPlay={resync}
                onSeeked={resync}
                onPause={() => void flush()}
                onEnded={() => void flush()}
              />
            ) : (
              <p className="note bad gap-top">This episode has no audio file.</p>
            )}
            {!feedSource && (
              <p className="muted small">Demo audio is an original generated tone clip, four minutes long.</p>
            )}
            {payableOf100 === 0 && (
              <p className="note gap-top">
                This show lists no ecash recipients yet, so Nutcast can play it but cannot pay it. Its creators can add
                one from the <a href="/creator">creator page</a>.
              </p>
            )}
          </section>

          <section className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Streaming sats</h2>
              <span className={`pill ${accrual.streaming ? 'on' : 'off'}`}>
                {accrual.streaming ? (capReached(accrual) ? 'budget reached' : 'on while playing') : 'paused'}
              </span>
            </div>

            <div className="gap-top">
              <div className="meter" aria-hidden="true">
                <i className="sent" style={{ width: `${Math.min(100, (accrual.sentEpisodeSats / cap) * 100)}%` }} />
                <i className="aside" style={{ width: `${Math.min(100, (aside / cap) * 100)}%` }} />
              </div>
              <div className="legend">
                <div className="sent">
                  <b>{accrual.sentEpisodeSats}</b>
                  <span>spent this episode</span>
                </div>
                <div className="aside">
                  <b>{aside}</b>
                  <span>set aside, not sent yet</span>
                </div>
                <div>
                  <b>{remaining}</b>
                  <span>left in budget</span>
                </div>
              </div>
            </div>

            <button
              type="button"
              className={`btn wide gap-top ${accrual.streaming ? 'stop' : 'amber'}`}
              onClick={toggleStreaming}
            >
              {accrual.streaming ? 'Pause streaming' : 'Start streaming sats'}
            </button>
            <p className="muted small gap-top">
              {!accrual.streaming
                ? 'Playback carries on without paying while this is paused.'
                : capReached(accrual)
                  ? 'Budget reached. Nothing more is set aside until you raise it.'
                  : `Counting only what you hear. Next payment after ${untilFlush}s more listening, or when you pause.`}
              {flushing ? ' Sending…' : ''}
            </p>
            {waitingOnFees && aside > 0 && (
              <p className="note gap-top">
                Holding {aside} sats for now: this mint’s fees would take more than half of such a small payment. They go
                out once more has built up.
              </p>
            )}

            <div className="fields gap-top">
              <label className="field">
                Sats per minute
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={settings.rate}
                  onChange={(e) => updateSettings({ rate: clampInt(e.target.value, 1, 1000) })}
                />
              </label>
              <label className="field">
                Episode budget
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={settings.episodeCap}
                  onChange={(e) => updateSettings({ episodeCap: clampInt(e.target.value, 1, 100000) })}
                />
              </label>
              <label className="field">
                Daily budget
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={settings.dailyCap}
                  onChange={(e) => updateSettings({ dailyCap: clampInt(e.target.value, 1, 100000) })}
                />
              </label>
            </div>
            <div className="row between gap-top small">
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={settings.demo} onChange={(e) => updateSettings({ demo: e.target.checked })} />
                Demo mode: pay every 30 seconds instead of every 5 minutes
              </label>
              <span className="muted mono">
                today {accrual.sentTodaySats}/{accrual.dailyCapSats}
              </span>
            </div>
            <p className="muted small gap-top">
              Mint fees come out of your budget, never on top of it. Boosts are separate from the budget.
            </p>
          </section>

          <section className="card">
            <h2>Who gets paid</h2>
            <table>
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Paid by</th>
                  <th className="num">Of 100 sats</th>
                </tr>
              </thead>
              <tbody>
                {computeSplit(100, recipients).shares.map((s, i) => (
                  <tr key={i}>
                    <td>
                      {s.recipient.name || '(unnamed)'}
                      {s.recipient.fee ? <span className="muted small"> · fee, off the top</span> : null}
                    </td>
                    <td>
                      {s.rail === 'cashu' ? (
                        <span className="pill on">ecash, NUT-18</span>
                      ) : (
                        <span className="pill off" title={s.reason}>
                          not payable here
                        </span>
                      )}
                    </td>
                    <td className="num">{s.sats}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unpayable.length > 0 && (
              <p className="muted small gap-top">
                Shares marked “not payable here” are never sent. They stay in your wallet and show on the receipt.
              </p>
            )}
          </section>
        </div>

        <div className="col">
          <section className="card">
            <h2>Your wallet</h2>
            <div className="row between">
              <div>
                <span className="big">{balance}</span>
                <span className="unit">test sats</span>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setBackup(balance > 0 ? walletRef.current?.exportToken() : undefined)}
                disabled={balance <= 0}
              >
                Back up
              </button>
            </div>
            <p className="muted small">Mint: {mintUrl}</p>
            {pending > 0 && (
              <p className="note gap-top">
                {pending} payment{pending === 1 ? '' : 's'} left the wallet and will be delivered when the receiver is
                reachable.{' '}
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => retryDeliveries(localStorage, NS).then(refresh)}
                >
                  Retry now
                </button>
              </p>
            )}

            {backup && (
              <div className="stack gap-top">
                <p className="small">
                  This token <strong>is</strong> your balance. Anyone who has it can spend it. Clearing this browser
                  without a copy loses the sats.
                </p>
                <div className="code">{backup}</div>
                <div className="row">
                  <Copy text={backup} label="Copy token" />
                  <button type="button" className="btn ghost small" onClick={() => setBackup(undefined)}>
                    Hide
                  </button>
                </div>
              </div>
            )}

            <div className="row gap-top" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 1 }}>
                Top up (sats)
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={fundAmount}
                  onChange={(e) => setFundAmount(clampInt(e.target.value, 1, 5000))}
                />
              </label>
              <button type="button" className="btn" onClick={startFund} disabled={funding || !!fund}>
                {funding ? 'Asking mint…' : 'Get invoice'}
              </button>
            </div>
            {fund && (
              <div className="stack gap-top">
                <p className="small">
                  Lightning invoice for {fund.amount} sats. On a real mint you would pay this from any Lightning wallet.
                  The test mint marks it paid by itself.
                </p>
                <div className="code">{fund.request}</div>
                <p className="muted small">Waiting for the mint…</p>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Boost with a message</h2>
            <div className="stack">
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <label className="field" style={{ flex: 1 }}>
                  Sats
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={boostAmount}
                    onChange={(e) => setBoostAmount(clampInt(e.target.value, 0, 100000))}
                  />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  Your name (optional)
                  <input type="text" maxLength={40} value={boostName} onChange={(e) => setBoostName(e.target.value)} />
                </label>
              </div>
              <label className="field">
                Message
                <textarea
                  maxLength={300}
                  value={boostMessage}
                  placeholder="Great episode, thank you!"
                  onChange={(e) => setBoostMessage(e.target.value)}
                />
              </label>
              {boostPlan && (
                <p className="muted small mono">
                  {boostPlan.shares
                    .filter((s) => s.sats > 0)
                    .map((s) => `${s.recipient.name || 'recipient'} ${s.sats}${s.rail === 'cashu' ? '' : ' (kept)'}`)
                    .join('  ·  ')}
                </p>
              )}
              <button
                type="button"
                className="btn"
                onClick={sendBoost}
                disabled={boosting || !boostPlan || boostPlan.payable <= 0 || balance < boostPlan.payable}
              >
                {boosting ? 'Sending…' : `Send ${boostPlan?.payable ?? 0} sats`}
              </button>
              {boostPlan && balance < boostPlan.payable && <p className="muted small">Not enough balance for this boost.</p>}
            </div>
          </section>

          <section className="card">
            <h2>Listen to another show</h2>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                const url = feedInput.trim();
                window.location.search = url ? `?feed=${encodeURIComponent(url)}` : '';
              }}
            >
              <label className="field">
                Podcast feed address (https)
                <input
                  type="text"
                  inputMode="url"
                  value={feedInput}
                  placeholder="https://example.com/feed.xml"
                  onChange={(e) => setFeedInput(e.target.value)}
                />
              </label>
              <div className="row">
                <button type="submit" className="btn ghost">
                  Load show
                </button>
                {feedSource && <a href="/">Back to the demo show</a>}
              </div>
            </form>
            <p className="muted small gap-top">
              Any public Podcasting 2.0 feed loads. Only recipients with an ecash payment request can be paid.
            </p>
          </section>

          <section className="card">
            <h2>Receipts</h2>
            {receipts.length === 0 && <p className="muted">Nothing sent yet.</p>}
            {receipts.map((r) => (
              <div className="receipt" key={r.id}>
                <div className="row between">
                  <span className={`pill ${r.action === 'boost' ? '' : 'on'}`}>{r.action}</span>
                  <span className="mono small">
                    {r.sent} sats{r.fees ? ` + ${r.fees} fee` : ''} · {new Date(r.at).toLocaleTimeString()}
                  </span>
                </div>
                {r.message && <p className="msg">“{r.message}”</p>}
                <table>
                  <tbody>
                    {r.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{l.name}</td>
                        <td className="small muted" title={l.note}>
                          {STATUS_LABEL[l.status] ?? l.status}
                        </td>
                        <td className="num">{l.sats}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}
