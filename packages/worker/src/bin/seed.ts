import { createDb } from '@wf/db';
import { seedWorld } from '../seed/world.js';

/** CLI entrypoint: `pnpm seed`. */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exitCode = 1;
    return;
  }

  const db = createDb({ connectionString });
  try {
    console.log('Seeding starter world...');
    const summary = await seedWorld(db);
    console.log(
      `  ${summary.countries} countries, ${summary.regions} regions, ` +
        `${summary.cities} cities, ${summary.parcels} land parcels`,
    );
    console.log('Seed complete.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
