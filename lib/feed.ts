// Podcast feed parsing: just enough RSS to find episodes, the podcast:value
// block and the podcast:txt tags Nutcast cares about.

import { XMLParser } from 'fast-xml-parser';
import type { Recipient } from './splits';

export interface ValueBlock {
  type: string;
  method: string;
  /** Feed's suggested amount, as written. A default, never a requirement. */
  suggested?: string;
  recipients: Recipient[];
}

export interface Episode {
  guid: string;
  title: string;
  audioUrl?: string;
  /** Item-level value block, if the episode overrides the show's. */
  value?: ValueBlock;
}

export interface Feed {
  title: string;
  /** Channel-level value block. */
  value?: ValueBlock;
  /** `<podcast:txt purpose="cashu">`: a show-level NUT-18 request (unofficial). */
  showCashuRequest?: string;
  episodes: Episode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    name === 'item' || name === 'podcast:valueRecipient' || name === 'podcast:txt' || name === 'podcast:value',
});

type Node = Record<string, unknown>;

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Node)) return String((v as Node)['#text']);
  return '';
}

function parseValue(nodes: unknown): ValueBlock | undefined {
  const list = (nodes as Node[] | undefined) ?? [];
  // Prefer a lightning block; it is the only kind in the wild that also
  // carries the unofficial Cashu recipient types.
  const node = list.find((n) => String(n['@type'] ?? '').toLowerCase() === 'lightning') ?? list[0];
  if (!node) return undefined;
  const recipients = ((node['podcast:valueRecipient'] as Node[] | undefined) ?? []).map(
    (r): Recipient => ({
      name: String(r['@name'] ?? ''),
      type: String(r['@type'] ?? ''),
      address: String(r['@address'] ?? '').trim(),
      split: Number(r['@split'] ?? 0),
      fee: String(r['@fee'] ?? '').toLowerCase() === 'true',
    }),
  );
  return {
    type: String(node['@type'] ?? ''),
    method: String(node['@method'] ?? ''),
    suggested: node['@suggested'] != null ? String(node['@suggested']) : undefined,
    recipients,
  };
}
