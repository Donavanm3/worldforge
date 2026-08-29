import { type Kysely, sql } from 'kysely';

/**
 * Deeds, foot traffic and unit revenue (spec 14-17).
 *
 * The deed and the rooms inside a building are separate property. Buying the
 * deed does not evict anyone: existing unit owners keep their units, and the
 * deed holder gets the unsold units plus a cut of everything the occupied ones
 * earn. That split is what makes a building worth owning as a whole rather
 * than merely a container for rooms.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('buildings')
    // The deed itself trades, independently of the units inside.
    .addColumn('for_sale', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('sale_price', 'numeric(20, 4)')
    // What the building as a whole is reckoned to be worth, refreshed by the
    // tick from the units inside it.
    .addColumn('appraised_value', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    // Passing trade, from how much street frontage the site has. Drives the
    // revenue of everything inside.
    .addColumn('foot_traffic', 'numeric(6, 2)', (c) => c.notNull().defaultTo('1'))
    // NPC landlords give a new player something to buy on day one.
    .addColumn('npc_owner_name', 'text')
    .execute();

  await db.schema
    .alterTable('buildings')
    .addCheckConstraint(
      'buildings_sale_price_present_when_for_sale',
      sql`not for_sale or sale_price is not null`,
    )
    .execute();

  await db.schema
    .alterTable('building_units')
    // Per-tick earnings, recomputed when the building or its trade changes.
    .addColumn('revenue_per_tick', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('total_earned', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .execute();

  await db.schema
    .createIndex('buildings_for_sale_idx')
    .on('buildings')
    .column('sale_price')
    .where(sql.ref('for_sale'), '=', true)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists buildings_for_sale_idx`.execute(db);
  await db.schema
    .alterTable('building_units')
    .dropColumn('revenue_per_tick')
    .dropColumn('total_earned')
    .execute();
  await db.schema
    .alterTable('buildings')
    .dropConstraint('buildings_sale_price_present_when_for_sale')
    .execute();
  await db.schema
    .alterTable('buildings')
    .dropColumn('for_sale')
    .dropColumn('sale_price')
    .dropColumn('appraised_value')
    .dropColumn('foot_traffic')
    .dropColumn('npc_owner_name')
    .execute();
}
