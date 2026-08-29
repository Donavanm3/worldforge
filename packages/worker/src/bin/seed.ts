import { sql } from 'kysely';
import { createDb } from '@wf/db';
import { seedCatalog } from '../seed/catalog.js';
import { seedWorld } from '../seed/world.js';
import { seedNpcLandlords } from '../seed/landlords.js';

/** CLI entrypoint: `pnpm seed`. */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes('--reset-world');
  // Opt in, because it makes tens of requests to a volunteer OSM service and
  // turns a two-second seed into a several-minute one.
  const realBlocks = process.argv.includes('--real-blocks');
  // Safe to re-run on a live world: it only fills parcels that are still
  // unowned and unbuilt, so it can top up newly surveyed areas.
  const landlords = process.argv.includes('--landlords');

  const db = createDb({ connectionString });
  try {
    if (reset) {
      // DELETE, never TRUNCATE CASCADE. Cascading truncation empties every
      // table holding a foreign key into these — users.home_city_id points at
      // cities, so a CASCADE here would delete every player account. DELETE
      // instead fires the ON DELETE SET NULL the schema declares, detaching
      // companies and players from the land rather than destroying them.
      //
      // Any land a player bought is still gone, so this stays a pre-launch
      // tool. Take a backup first.
      console.log('Resetting the world (land, cities, regions, countries)...');
      await sql`delete from land_parcels`.execute(db);
      await sql`delete from cities`.execute(db);
      await sql`delete from regions`.execute(db);
      await sql`delete from countries`.execute(db);
    }

    console.log('Seeding item catalogue...');
    const catalog = await seedCatalog(db);
    console.log(`  ${catalog.items} items, ${catalog.recipes} recipes`);

    console.log(
      realBlocks
        ? 'Seeding world with parcels cut from the OpenStreetMap street network...'
        : 'Seeding starter world (grid parcels; pass --real-blocks for real city blocks)...',
    );
    const summary = await seedWorld(db, {
      useRealBlocks: realBlocks,
      onProgress: (message) => console.log(message),
    });
    console.log(
      `  ${summary.countries} countries, ${summary.regions} regions, ` +
        `${summary.cities} cities, ${summary.parcels} land parcels`,
    );
    if (realBlocks) {
      console.log(
        `  ${summary.citiesFromStreets} of ${summary.cities} cities follow real streets; ` +
          `the rest fell back to the grid.`,
      );
    }
    if (landlords) {
      console.log('Placing NPC landlords...');
      const npcs = await seedNpcLandlords(db, {
        onProgress: (message) => console.log(message),
      });
      console.log(
        `  ${npcs.buildings} buildings, ${npcs.units} units, ${npcs.skipped} parcels skipped`,
      );
    }

    console.log('Seed complete.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
