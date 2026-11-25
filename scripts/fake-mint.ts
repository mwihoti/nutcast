// Run a local fake mint for offline development:
//   npx tsx scripts/fake-mint.ts   (prints the URL; use it as NUTCAST_MINTS)
// PAY_DELAY_MS=8000 keeps each invoice unpaid for 8 seconds, so the invoice
// screen can be seen before the balance arrives.
import { startFakeMint } from '../test/fakeMint';

const fee = Number(process.env.FEE_PPK ?? 100);
startFakeMint({ feePpk: fee, port: Number(process.env.PORT ?? 3338), cors: true, payDelayMs: Number(process.env.PAY_DELAY_MS ?? 0) }).then((m) => {
  console.log(`fake mint listening on ${m.url} (input fee ${fee} ppk)`);
});
