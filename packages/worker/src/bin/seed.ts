import { sql } from 'kysely';
import { createDb } from '@wf/db';
import { seedCatalog } from '../seed/catalog.js';
import { seedWorld } from '../seed/world.js';

/** CLI entrypoint: `pnpm seed`. */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes('--reset-world');

  const db = createDb({ connectionString });
  try {
    if (reset) {
      // Deliberately narrow: this drops the geography and every claim on it,
      // and nothing else. Player accounts, companies and balances survive —
      // but any land they bought is gone, so this is a pre-launch tool.
      console.log('Resetting the world (land, cities, regions, countries)...');
      await sql`truncate table land_parcels, cities, regions, countries restart identity cascade`.execute(
        db,
      );
    }

    console.log('Seeding item catalogue...');
    const catalog = await seedCatalog(db);
    console.log(`  ${catalog.items} items, ${catalog.recipes} recipes`);

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
