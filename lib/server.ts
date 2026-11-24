import { acceptedMints } from './verify';

/** Public origin of this deployment, honouring a reverse proxy. */
export function originOf(req: Request): string {
  if (process.env.NUTCAST_ORIGIN) return process.env.NUTCAST_ORIGIN.replace(/\/+$/, '');
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export const primaryMint = () => acceptedMints()[0];

/** Other players and wallets may POST to the receive endpoint from any origin. */
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
