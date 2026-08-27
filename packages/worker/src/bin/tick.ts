import { createDb } from '@wf/db';
import { runEconomyTick } from '../tick.js';

/**
 * Economy tick runner: `pnpm tick` for one pass, or `pnpm tick --loop` to keep
 * running on an interval. PM2 or a cron entry drives this in production.
 */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const loop = process.argv.includes('--loop');
  const intervalMs = Number(process.env['TICK_INTERVAL_MS'] ?? 300_000);
  const db = createDb({ connectionString });

  const once = async () => {
    const result = await runEconomyTick(db);
    console.log(
      `tick: ${result.runsCompleted} runs completed, ${result.itemsRepriced} items repriced, ` +
        `${result.loansAccrued} loans accrued, index ${result.priceIndex.toFixed(3)}`,
    );
  };

  try {
    if (!loop) {
      await once();
      return;
    }

    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        stopping = true;
      });
    }

    while (!stopping) {
      // A failing tick must not kill the loop; log and try again next interval.
      await once().catch((error) => console.error('tick failed:', error));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.destroy();
  }
}

await main();
