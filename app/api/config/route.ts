import { acceptedMints } from '@/lib/verify';
import { originOf } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return Response.json({ mints: acceptedMints(), origin: originOf(req) }, { headers: { 'Cache-Control': 'no-store' } });
}
