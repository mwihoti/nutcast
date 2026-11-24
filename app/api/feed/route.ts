// GET /api/feed?url=https://… : fetch any public podcast feed for the player.
// Set NUTCAST_FEED_PROXY=off to disable it on a public deployment.

import { FeedError, fetchFeed } from '@/lib/feedProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (process.env.NUTCAST_FEED_PROXY === 'off') {
    return Response.json({ error: 'the feed loader is turned off on this server' }, { status: 403 });
  }
  try {
    const xml = await fetchFeed(new URL(req.url).searchParams.get('url') ?? '');
    return new Response(xml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const e = err instanceof FeedError ? err : new FeedError(500, 'unexpected error');
    return Response.json({ error: e.message }, { status: e.status });
  }
}
