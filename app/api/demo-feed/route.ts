import { buildDemoFeed } from '@/lib/demoFeed';
import { originOf, primaryMint } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const host = new URL(req.url).searchParams.get('host')?.toLowerCase() ?? undefined;
  return new Response(buildDemoFeed(originOf(req), primaryMint(), host), {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
