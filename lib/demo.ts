// Demo identities. These private keys are PUBLIC: they are derived from fixed
// strings so the demo works out of the box in one browser. They only ever
// guard test sats. Never reuse them for anything real.

import { computeMessageDigest } from '@cashu/cashu-ts';
import { fromPrivkey, type KeyPair } from './keys';

export interface DemoIdentity extends KeyPair {
  id: 'host' | 'guest' | 'hosting';
  name: string;
  split: number;
  fee: boolean;
}

const derive = (label: string) => fromPrivkey(computeMessageDigest(`nutcast demo key: ${label}`, true));

export const DEMO_IDENTITIES: DemoIdentity[] = [
  { id: 'host', name: 'Demo Host', split: 80, fee: false, ...derive('host') },
  { id: 'guest', name: 'Demo Guest', split: 15, fee: false, ...derive('guest') },
  { id: 'hosting', name: 'Demo Hosting Co', split: 5, fee: true, ...derive('hosting') },
];

export const DEMO_EPISODE_GUID = 'nutcast-demo-episode-1';
