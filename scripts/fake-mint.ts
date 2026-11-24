// Run a local fake mint for offline development:
//   npx tsx scripts/fake-mint.ts   (prints the URL; use it as NUTCAST_MINTS)
import { startFakeMint } from '../test/fakeMint';

const fee = Number(process.env.FEE_PPK ?? 100);
startFakeMint({ feePpk: fee, port: Number(process.env.PORT ?? 3338), cors: true }).then((m) => {
  console.log(`fake mint listening on ${m.url} (input fee ${fee} ppk)`);
});
