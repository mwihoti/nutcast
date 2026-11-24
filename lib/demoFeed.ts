// The demo show: one episode, three recipients, every one payable in ecash.

import { DEMO_EPISODE_GUID, DEMO_IDENTITIES } from './demo';
import { isPubkey, makeCreq } from './keys';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param host  Optional creator key. When given, it replaces the demo host, so
 *              a creator can open the listener page and watch their own inbox.
 */
export function buildDemoFeed(origin: string, mint: string, host?: string): string {
  const recipients = DEMO_IDENTITIES.map((d) => {
    const pubkey = d.id === 'host' && host && isPubkey(host) ? host : d.pubkey;
    const name = d.id === 'host' && pubkey !== d.pubkey ? 'Host (your key)' : d.name;
    return { ...d, name, creq: makeCreq(origin, pubkey, mint, `Nutcast: ${name}`) };
  });
  const show = recipients[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>The Nutcast Demo Show</title>
    <description>A demo feed for Nutcast. Every recipient is paid in test ecash.</description>
    <!-- Unofficial: type="cashu" recipients and the purpose="cashu" txt tag are
         community conventions (CASHU_STREAMING), not registered namespace values. -->
    <podcast:value type="lightning" method="lnaddress" suggested="0.00000004">
${recipients
  .map(
    (r) =>
      `      <podcast:valueRecipient name="${esc(r.name)}" type="cashu" address="${esc(r.creq)}" split="${r.split}"${r.fee ? ' fee="true"' : ''}/>`,
  )
  .join('\n')}
    </podcast:value>
    <podcast:txt purpose="cashu">${esc(show.creq)}</podcast:txt>
    <item>
      <title>Episode 1: Four chords and a budget</title>
      <guid isPermaLink="false">${DEMO_EPISODE_GUID}</guid>
      <enclosure url="${esc(origin)}/demo-episode.mp3" type="audio/mpeg" length="1203427"/>
    </item>
  </channel>
</rss>
`;
}
