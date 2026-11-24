// NUT-18 HTTP POST transport: the creator's receive endpoint.
//   POST /api/ecash?to=<creator pubkey>&action=boost|stream&episode=<guid>
//   body: a NUT-18 PaymentRequestPayload

import { receivePayment } from '@/lib/receive';
import { CORS } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const r = await receivePayment(new URL(req.url).searchParams, await req.text());
  return Response.json(r.body, { status: r.status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
