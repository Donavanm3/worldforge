import { createDb } from '../client.js';
import { migrateDown, migrateToLatest, reportMigrationResults } from '../migrator.js';

/**
 * CLI entrypoint: `pnpm migrate` (up) or `pnpm migrate down`.
 * Load env with `node --env-file=.env` or export DATABASE_URL directly.
 */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exitCode = 1;
    return;
  }

  const direction = process.argv[2] ?? 'up';
  if (direction !== 'up' && direction !== 'down') {
    console.error(`Unknown direction "${direction}". Expected "up" or "down".`);
    process.exitCode = 1;
    return;
  }

  const db = createDb({ connectionString });
  try {
    console.log(`Running migrations (${direction})...`);
    const results = direction === 'up' ? await migrateToLatest(db) : await migrateDown(db);
    if (!reportMigrationResults(results)) {
      process.exitCode = 1;
      return;
    }
    console.log('Migrations complete.');
  } finally {
    await db.destroy();
  }
}

await main();
