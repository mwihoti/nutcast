// Creator inbox. Every call is signed with the creator's key (see lib/keys.ts).

import { verifyInbox } from '@/lib/keys';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const pubkey = (q.get('pubkey') ?? '').toLowerCase();
  if (!verifyInbox(pubkey, Number(q.get('ts')), q.get('sig') ?? '', 'list')) {
    return Response.json({ error: 'bad_signature' }, { status: 401 });
  }
  return Response.json({ entries: await getStore().list(pubkey) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  let body: { pubkey?: string; ts?: number; sig?: string; ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  const pubkey = (body.pubkey ?? '').toLowerCase();
  if (!verifyInbox(pubkey, Number(body.ts), body.sig ?? '', 'redeem')) {
    return Response.json({ error: 'bad_signature' }, { status: 401 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  await getStore().markRedeemed(pubkey, ids);
  return Response.json({ ok: true });
}
