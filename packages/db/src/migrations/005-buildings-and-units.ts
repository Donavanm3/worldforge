import { type Kysely, sql } from 'kysely';

/**
 * Phase 4: buildings, floors and units (spec 14-16).
 *
 * A parcel holds at most one building; a building stacks floors; a floor is cut
 * into units. Units are what players actually occupy, buy and rent, which makes
 * a single downtown block support dozens of tenants rather than one owner.
 *
 * Floors are stored rather than derived from a count, because each carries its
 * own use — retail at street level, offices above — and units hang off them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createType('building_type')
    .asEnum(['residential', 'office', 'retail', 'industrial', 'mixed_use', 'civic'])
    .execute();

  await db.schema
    .createType('building_status')
    .asEnum(['under_construction', 'complete', 'demolished'])
    .execute();

  await db.schema
    .createType('unit_use')
    .asEnum(['apartment', 'office', 'shop', 'workshop', 'storage'])
    .execute();

  // --- Buildings -----------------------------------------------------------

  await db.schema
    .createTable('buildings')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // One building per parcel. Demolition frees the parcel by deleting the row,
    // so the constraint can stay unconditional.
    .addColumn('parcel_id', 'uuid', (c) =>
      c.notNull().unique().references('land_parcels.id').onDelete('cascade'),
    )
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    // Corporate ownership is optional: a player may build personally.
    .addColumn('company_id', 'uuid', (c) => c.references('companies.id').onDelete('set null'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('type', sql`building_type`, (c) => c.notNull())
    .addColumn('status', sql`building_status`, (c) => c.notNull().defaultTo('under_construction'))
    .addColumn('floors', 'integer', (c) => c.notNull())
    .addColumn('footprint_sqm', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('construction_cost', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('completes_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('buildings_floors_positive', sql`floors between 1 and 120`)
    .addCheckConstraint('buildings_footprint_positive', sql`footprint_sqm > 0`)
    .addCheckConstraint('buildings_cost_positive', sql`construction_cost > 0`)
    .execute();

  await db.schema.createIndex('buildings_owner_idx').on('buildings').column('owner_id').execute();
  await db.schema
    .createIndex('buildings_status_completes_idx')
    .on('buildings')
    .columns(['status', 'completes_at'])
    .execute();

  // --- Floors --------------------------------------------------------------

  await db.schema
    .createTable('building_floors')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('building_id', 'uuid', (c) =>
      c.notNull().references('buildings.id').onDelete('cascade'),
    )
    // Ground floor is 0; basements are negative, so the ordering stays natural.
    .addColumn('level', 'integer', (c) => c.notNull())
    .addColumn('floor_area_sqm', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('use', sql`unit_use`, (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('building_floors_unique_level', ['building_id', 'level'])
    .execute();

  // --- Units ---------------------------------------------------------------

  await db.schema
    .createTable('building_units')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('building_id', 'uuid', (c) =>
      c.notNull().references('buildings.id').onDelete('cascade'),
    )
    .addColumn('floor_id', 'uuid', (c) =>
      c.notNull().references('building_floors.id').onDelete('cascade'),
    )
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('area_sqm', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('use', sql`unit_use`, (c) => c.notNull())
    // Null owner means the developer still holds it; the building owner is the
    // seller of record until someone buys.
    .addColumn('owner_id', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('market_value', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('for_sale', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('sale_price', 'numeric(20, 4)')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('building_units_unique_label', ['building_id', 'label'])
    .addCheckConstraint('building_units_area_positive', sql`area_sqm > 0`)
    .addCheckConstraint(
      'building_units_sale_price_present_when_for_sale',
      sql`not for_sale or sale_price is not null`,
    )
    .execute();

  await db.schema
    .createIndex('building_units_owner_idx')
    .on('building_units')
    .column('owner_id')
    .execute();

  // Powers the "units for sale" board, which is read far more than it is written.
  await db.schema
    .createIndex('building_units_for_sale_idx')
    .on('building_units')
    .column('building_id')
    .where(sql.ref('for_sale'), '=', true)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('building_units').ifExists().execute();
  await db.schema.dropTable('building_floors').ifExists().execute();
  await db.schema.dropTable('buildings').ifExists().execute();
  await db.schema.dropType('unit_use').ifExists().execute();
  await db.schema.dropType('building_status').ifExists().execute();
  await db.schema.dropType('building_type').ifExists().execute();
}
