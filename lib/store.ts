// Inbox storage for the NUT-18 receive endpoint.
//
// The server never holds spendable money: every proof it stores is locked to
// the creator's key. It still must not lose them, so each payment is written
// to durable storage before the endpoint answers.
//
// Two adapters:
//   - file:  .data/inbox.json. For `npm run dev` and a single long-lived server.
//   - redis: Upstash-style REST. Set UPSTASH_REDIS_REST_URL and
//            UPSTASH_REDIS_REST_TOKEN on a serverless host.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StoredProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r?: string };
  p2pk_e?: string;
}

export interface InboxEntry {
  id: string;
  to: string;
  mint: string;
  amount: number;
  action: 'boost' | 'stream';
  memo?: string;
  episode?: string;
  receivedAt: number;
  status: 'received' | 'redeemed';
  /** Emptied once redeemed. */
  proofs: StoredProof[];
}

export interface InboxStore {
  /** Returns false when any of the proofs was already delivered. */
  add(entry: InboxEntry): Promise<boolean>;
  list(pubkey: string): Promise<InboxEntry[]>;
  markRedeemed(pubkey: string, ids: string[]): Promise<void>;
}

// --- file adapter ------------------------------------------------------------

interface FileShape {
  entries: InboxEntry[];
  secrets: string[];
}

class FileStore implements InboxStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}

  private async read(): Promise<FileShape> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as FileShape;
    } catch {
      return { entries: [], secrets: [] };
    }
  }

  private async write(data: FileShape) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.file);
  }

  /** One writer at a time, so two payments cannot overwrite each other. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  add(entry: InboxEntry) {
    return this.locked(async () => {
      const data = await this.read();
      const seen = new Set(data.secrets);
      if (entry.proofs.some((p) => seen.has(p.secret))) return false;
      data.entries.push(entry);
      data.secrets.push(...entry.proofs.map((p) => p.secret));
      await this.write(data);
      return true;
    });
  }

  async list(pubkey: string) {
    return (await this.read()).entries.filter((e) => e.to === pubkey);
  }

  markRedeemed(pubkey: string, ids: string[]) {
    return this.locked(async () => {
      const data = await this.read();
      for (const e of data.entries) {
        if (e.to === pubkey && ids.includes(e.id)) {
          e.status = 'redeemed';
          e.proofs = [];
        }
      }
      await this.write(data);
    });
  }
}

let cached: InboxStore | undefined;

export function getStore(): InboxStore {
  if (cached) return cached;
  cached = new FileStore(process.env.NUTCAST_DATA_FILE ?? path.join(process.cwd(), '.data', 'inbox.json'));
  return cached;
}

export function makeFileStore(file: string): InboxStore {
  return new FileStore(file);
}
