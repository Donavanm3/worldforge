import { type Kysely, sql } from 'kysely';

/**
 * Land everywhere, not just in seeded cities (spec 5).
 *
 * Pre-generating parcels for the whole planet is not possible — the street
 * network of Earth runs to hundreds of millions of blocks. Instead the world is
 * divided into a fixed grid of tiles, and a tile's parcels are cut the first
 * time a player looks at it. `land_tiles` records which tiles have been done, so
 * the work happens once and never repeats.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createType('land_tile_status')
    .asEnum(['pending', 'ready', 'empty', 'failed'])
    .execute();

  await db.schema
    .createTable('land_tiles')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Integer grid indices, so a tile has exactly one identity and two clients
    // looking at the same street cannot generate it twice.
    .addColumn('tile_x', 'integer', (c) => c.notNull())
    .addColumn('tile_y', 'integer', (c) => c.notNull())
    .addColumn('status', sql`land_tile_status`, (c) => c.notNull().defaultTo('pending'))
    .addColumn('parcel_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .addUniqueConstraint('land_tiles_unique_cell', ['tile_x', 'tile_y'])
    .execute();

  // Generated parcels sit outside any seeded city or region, so both links have
  // to become optional. The columns stay, and are filled in when a parcel falls
  // near a city we know about.
  await sql`alter table land_parcels alter column region_id drop not null`.execute(db);

  // A city's land rate was a seeder constant; valuing land anywhere in the
  // world means the nearest city has to be able to tell us its rate.
  await db.schema
    .alterTable('cities')
    .addColumn('base_rate_per_sqm', 'numeric(10, 4)', (c) => c.notNull().defaultTo('0.5'))
    .execute();

  // Nearest-city lookups run on every generated tile.
  await sql`create index if not exists cities_center_gix on cities using gist (center)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists cities_center_gix`.execute(db);
  await db.schema.alterTable('cities').dropColumn('base_rate_per_sqm').execute();
  await db.schema.dropTable('land_tiles').ifExists().execute();
  await db.schema.dropType('land_tile_status').ifExists().execute();
}
