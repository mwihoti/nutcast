'use client';

// Creator page: payment request, inbox of boosts and stream ticks, redeem, cash out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wallet, type MeltQuoteBolt11Response } from '@cashu/cashu-ts';
import { Copy } from '@/components/Copy';
import { DEMO_IDENTITIES } from '@/lib/demo';
import { fromPrivkey, makeCreq, newKeyPair, secondTestMint, signInbox, type KeyPair } from '@/lib/keys';
import type { InboxEntry } from '@/lib/store';
import { NutWallet } from '@/lib/wallet';

interface Identity extends KeyPair {
  id: string;
  name: string;
  demo: boolean;
}

const OWN_KEY = 'nutcast:creator:privkey';
const clampInt = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || 0)));

export default function CreatorPage() {
  const [config, setConfig] = useState<{ mints: string[]; origin: string }>();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeId, setActiveId] = useState('host');
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [balance, setBalance] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'bad' | 'good'; text: string }>();

  const [invoice, setInvoice] = useState('');
  const [testAmount, setTestAmount] = useState(50);
  const [quote, setQuote] = useState<{ quote: MeltQuoteBolt11Response; amount: number; feeReserve: number }>();

  const walletRef = useRef<NutWallet | undefined>(undefined);

  const me = identities.find((i) => i.id === activeId);
  const mint = config?.mints[0];

  // --- identities and config -----------------------------------------------------
  useEffect(() => {
    const demo: Identity[] = DEMO_IDENTITIES.map((d) => ({
      id: d.id,
      name: d.name,
      privkey: d.privkey,
      pubkey: d.pubkey,
      demo: true,
    }));
    const saved = localStorage.getItem(OWN_KEY);
    const own: Identity[] = saved ? [{ id: 'own', name: 'My key', demo: false, ...fromPrivkey(saved) }] : [];
    setIdentities([...demo, ...own]);
    if (own.length) setActiveId('own');
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setNotice({ kind: 'bad', text: 'Could not load the server configuration.' }));
  }, []);

  const createOwnKey = () => {
    const kp = newKeyPair();
    localStorage.setItem(OWN_KEY, kp.privkey);
    setIdentities((list) => [...list.filter((i) => i.id !== 'own'), { id: 'own', name: 'My key', demo: false, ...kp }]);
    setActiveId('own');
  };

  // --- wallet for the active identity -----------------------------------------------
  useEffect(() => {
    if (!me || !mint) return;
    const w = new NutWallet(mint, `creator:${me.pubkey.slice(0, 16)}`, localStorage);
    walletRef.current = w;
    setBalance(w.balance());
    setEntries([]);
    setQuote(undefined);
  }, [me, mint]);

  // --- inbox polling --------------------------------------------------------------------
  const loadInbox = useCallback(async () => {
    if (!me) return;
    const { pubkey, ts, sig } = signInbox(me, 'list');
    const res = await fetch(`/api/inbox?pubkey=${pubkey}&ts=${ts}&sig=${sig}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`inbox answered ${res.status}`);
    const json = (await res.json()) as { entries: InboxEntry[] };
    setEntries(json.entries);
  }, [me]);

  useEffect(() => {
    if (!me) return;
    let stop = false;
    const loop = async () => {
      if (stop) return;
      try {
        await loadInbox();
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(loop, 4000);
    };
    void loop();
    return () => {
      stop = true;
    };
  }, [me, loadInbox]);

  const creq = useMemo(
    () => (me && config && mint ? makeCreq(config.origin, me.pubkey, mint, `Nutcast: ${me.name}`) : ''),
    [me, config, mint],
  );

  const waiting = entries.filter((e) => e.status === 'received');
  const waitingSats = waiting.reduce((a, e) => a + e.amount, 0);
  const boosts = entries.filter((e) => e.action === 'boost').sort((a, b) => b.receivedAt - a.receivedAt);
  const ticks = entries.filter((e) => e.action === 'stream').sort((a, b) => b.receivedAt - a.receivedAt);
  const tickSats = ticks.reduce((a, e) => a + e.amount, 0);

  // --- redeem ----------------------------------------------------------------------------
  const redeemAll = async () => {
    const w = walletRef.current;
    if (!w || !me || waiting.length === 0) return;
    setBusy('redeem');
    setNotice(undefined);
    const done: string[] = [];
    let gained = 0;
    let failed = 0;
    for (const e of waiting) {
      try {
        // Swapping with the mint is what makes the sats yours: the locked
        // proofs are spent and fresh, unlocked ones land in this wallet.
        gained += await w.receive(e.proofs, me.privkey);
        done.push(e.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/spent/i.test(msg)) done.push(e.id); // already redeemed, e.g. in another tab
        else failed += 1;
      }
    }
    try {
      if (done.length) {
        const { pubkey, ts, sig } = signInbox(me, 'redeem');
        await fetch('/api/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pubkey, ts, sig, ids: done }),
        });
      }
      await loadInbox();
    } catch {
      /* the next poll will catch up */
    }
    setBalance(w.balance());
    setBusy(undefined);
    setNotice(
      failed
        ? { kind: 'bad', text: `Redeemed ${gained} sats. ${failed} payment(s) could not be redeemed yet; try again.` }
        : { kind: 'good', text: `Redeemed ${gained} test sats into your wallet.` },
    );
  };

  // --- cash out ---------------------------------------------------------------------------
  const getTestInvoice = async () => {
    setBusy('invoice');
    setNotice(undefined);
    try {
      const other = new Wallet(secondTestMint(mint ?? ''), { unit: 'sat' });
      await other.loadMint();
      const q = await other.createMintQuoteBolt11(clampInt(String(testAmount), 1, 100000));
      setInvoice(q.request);
      setQuote(undefined);
    } catch (e) {
      setNotice({ kind: 'bad', text: `Could not get a test invoice: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(undefined);
    }
  };

  const getQuote = async () => {
    const w = walletRef.current;
    if (!w || !invoice.trim()) return;
    setBusy('quote');
    setNotice(undefined);
    try {
      setQuote(await w.meltQuote(invoice));
    } catch (e) {
      setNotice({ kind: 'bad', text: `The mint would not quote this invoice: ${e instanceof Error ? e.message : e}` });
    } finally {
      setBusy(undefined);
    }
  };

  const payInvoice = async () => {
    const w = walletRef.current;
    if (!w || !quote) return;
    setBusy('melt');
    setNotice(undefined);
    try {
      const spent = await w.melt(quote.quote);
      setNotice({
        kind: 'good',
        text: `Paid ${quote.amount} sats to the invoice. Fees: ${spent - quote.amount} sats. Unused fee reserve came back as change.`,
      });
      setQuote(undefined);
      setInvoice('');
    } catch (e) {
      setNotice({ kind: 'bad', text: `Payment failed: ${e instanceof Error ? e.message : e}. Your balance was re-checked with the mint.` });
    } finally {
      setBalance(w.balance());
      setBusy(undefined);
    }
  };

  if (!me || !config || !mint) {
    return (
      <main className="wrap">
        {notice ? <p className={`note ${notice.kind}`}>{notice.text}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }

  const snippet = `<podcast:valueRecipient name="${me.name}" type="cashu" address="${creq}" split="100"/>`;

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="brand">
            Nut<span>cast</span> · creator
          </div>
          <div className="tag">Receive ecash from listeners, read the messages, cash out to Lightning.</div>
        </div>
        <nav className="nav">
          <a href={me.demo ? '/' : `/?host=${me.pubkey}`}>← Listener page{me.demo ? '' : ' (paying your key)'}</a>
        </nav>
      </header>

      {notice && (
        <p className={`note ${notice.kind}`} role="status" style={{ marginBottom: 16 }}>
          {notice.text}
        </p>
      )}

      <div className="grid">
        <div className="col">
          <section className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Inbox</h2>
              <span className="muted small">refreshes every few seconds</span>
            </div>
            <div className="row between gap-top">
              <div>
                <span className="big">{waitingSats}</span>
                <span className="unit">test sats waiting in {waiting.length} payment{waiting.length === 1 ? '' : 's'}</span>
              </div>
              <button type="button" className="btn amber" onClick={redeemAll} disabled={busy === 'redeem' || waiting.length === 0}>
                {busy === 'redeem' ? 'Redeeming…' : 'Redeem all'}
              </button>
            </div>
            <p className="muted small gap-top">
              Waiting payments are locked to your key. Nobody else, including this server, can spend them. Redeem to
              move them into your wallet.
            </p>
          </section>

          <section className="card">
            <h2>Boosts</h2>
            {boosts.length === 0 && <p className="muted">No boosts yet.</p>}
            {boosts.map((e) => (
              <div className="receipt" key={e.id}>
                <div className="row between">
                  <span className="mono">
                    <strong>{e.amount}</strong> sats
                  </span>
                  <span className="small muted">
                    {new Date(e.receivedAt).toLocaleString()} ·{' '}
                    <span className={`pill ${e.status === 'redeemed' ? 'off' : 'on'}`}>{e.status}</span>
                  </span>
                </div>
                {e.memo ? <p className="msg">“{e.memo}”</p> : <p className="muted small">No message.</p>}
              </div>
            ))}
          </section>

          <section className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Stream payments</h2>
              <span className="mono small">
                {tickSats} sats in {ticks.length}
              </span>
            </div>
            {ticks.length === 0 ? (
              <p className="muted gap-top">Nothing streamed yet.</p>
            ) : (
              <table className="gap-top">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th className="num">Sats</th>
                  </tr>
                </thead>
                <tbody>
                  {ticks.slice(0, 20).map((e) => (
                    <tr key={e.id}>
                      <td>{new Date(e.receivedAt).toLocaleTimeString()}</td>
                      <td className="small muted">{e.status}</td>
                      <td className="num">{e.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small gap-top">Stream payments carry no message and never appear among boosts.</p>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <h2>Who you are</h2>
            <label className="field">
              Receiving as
              <select value={activeId} onChange={(e) => setActiveId(e.target.value)}>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.demo ? ' (public demo key)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {me.demo ? (
              <p className="note gap-top">
                Demo keys are published in the source code so the demo works out of the box. Anyone can redeem what they
                receive. Test sats only.
              </p>
            ) : (
              <p className="muted small gap-top">
                Your key lives in this browser only. Clearing site data loses it, and anything still waiting with it.
              </p>
            )}
            {!identities.some((i) => i.id === 'own') && (
              <button type="button" className="btn ghost gap-top" onClick={createOwnKey}>
                Create my own key
              </button>
            )}
          </section>

          <section className="card">
            <h2>Your wallet</h2>
            <div>
              <span className="big">{balance}</span>
              <span className="unit">test sats, redeemed</span>
            </div>
            <p className="muted small">Mint: {mint}</p>

            <div className="stack gap-top">
              <label className="field">
                Lightning invoice to pay (bolt11)
                <textarea
                  value={invoice}
                  onChange={(e) => {
                    setInvoice(e.target.value);
                    setQuote(undefined);
                  }}
                  placeholder="lnbc…"
                />
              </label>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <label className="field" style={{ width: 110 }}>
                  Test amount
                  <input
                    type="number"
                    min={1}
                    value={testAmount}
                    onChange={(e) => setTestAmount(clampInt(e.target.value, 1, 100000))}
                  />
                </label>
                <button type="button" className="btn ghost" onClick={getTestInvoice} disabled={busy === 'invoice'}>
                  {busy === 'invoice' ? 'Asking…' : 'Get a test invoice'}
                </button>
              </div>
              <p className="muted small">
                The test invoice comes from a second test mint ({secondTestMint(mint).replace('https://', '')}), standing in
                for your own Lightning wallet.
              </p>

              {!quote ? (
                <button type="button" className="btn" onClick={getQuote} disabled={!invoice.trim() || busy === 'quote'}>
                  {busy === 'quote' ? 'Getting quote…' : 'Show fees'}
                </button>
              ) : (
                <>
                  <table>
                    <tbody>
                      <tr>
                        <td>Invoice amount</td>
                        <td className="num">{quote.amount}</td>
                      </tr>
                      <tr>
                        <td>
                          Fee reserve <span className="muted small">(unused part returns)</span>
                        </td>
                        <td className="num">{quote.feeReserve}</td>
                      </tr>
                      <tr>
                        <td>
                          <strong>Most that can leave your wallet</strong>
                        </td>
                        <td className="num">
                          <strong>{quote.amount + quote.feeReserve}</strong>
                          <span className="muted small"> + mint input fees</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <button
                    type="button"
                    className="btn amber"
                    onClick={payInvoice}
                    disabled={busy === 'melt' || balance < quote.amount + quote.feeReserve}
                  >
                    {busy === 'melt' ? 'Paying…' : `Send ${quote.amount} sats to Lightning`}
                  </button>
                  {balance < quote.amount + quote.feeReserve && (
                    <p className="muted small">Not enough redeemed balance for this invoice plus the fee reserve.</p>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="card">
            <h2>Get paid</h2>
            <p className="small">Your payment request (NUT-18, reusable, any amount):</p>
            <div className="code gap-top">{creq}</div>
            <div className="row gap-top">
              <Copy text={creq} label="Copy request" />
            </div>
            <p className="small gap-top">To receive a share of a show, add this to the feed’s value block:</p>
            <div className="code gap-top">{snippet}</div>
            <div className="row gap-top">
              <Copy text={snippet} label="Copy feed line" />
            </div>
            <p className="muted small gap-top">
              <code>type=&quot;cashu&quot;</code> is a community convention, not an official Podcasting 2.0 recipient
              type. Players that do not know it will skip this line.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
