import { type Kysely, sql } from 'kysely';

/**
 * Phase 2: companies, the item catalogue, production, employment and the
 * marketplace (spec 6-13).
 *
 * Resources and products share one `items` table. Inventory, recipes and market
 * orders all reference an item, so splitting them would mean duplicating those
 * three systems for no gain.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createType('industry')
    .asEnum([
      'agriculture',
      'mining',
      'oil_and_gas',
      'energy',
      'manufacturing',
      'construction',
      'transportation',
      'logistics',
      'retail',
      'restaurants',
      'finance',
      'technology',
      'software',
      'telecommunications',
      'healthcare',
      'entertainment',
      'media',
      'real_estate',
    ])
    .execute();
  await db.schema.createType('item_kind').asEnum(['resource', 'product']).execute();
  await db.schema.createType('order_side').asEnum(['buy', 'sell']).execute();
  await db.schema.createType('order_status').asEnum(['open', 'filled', 'cancelled']).execute();
  await db.schema
    .createType('production_status')
    .asEnum(['running', 'completed', 'cancelled'])
    .execute();
  await db.schema
    .createType('employment_status')
    .asEnum(['active', 'resigned', 'terminated'])
    .execute();

  // --- Catalogue -----------------------------------------------------------

  await db.schema
    .createTable('items')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kind', sql`item_kind`, (c) => c.notNull())
    .addColumn('unit', 'text', (c) => c.notNull().defaultTo('unit'))
    // Anchor for market pricing before players establish real prices.
    .addColumn('base_price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('tier', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('items_base_price_positive', sql`base_price > 0`)
    .execute();

  await db.schema
    .createTable('recipes')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('output_item_id', 'uuid', (c) =>
      c.notNull().references('items.id').onDelete('cascade'),
    )
    .addColumn('output_quantity', 'numeric(20, 4)', (c) => c.notNull())
    /** Worker-hours per batch; drives how long a run takes and what it costs. */
    .addColumn('labour_hours', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('industry', sql`industry`, (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('recipes_output_positive', sql`output_quantity > 0`)
    .addCheckConstraint('recipes_labour_non_negative', sql`labour_hours >= 0`)
    .execute();

  await db.schema
    .createTable('recipe_inputs')
    .addColumn('recipe_id', 'uuid', (c) => c.notNull().references('recipes.id').onDelete('cascade'))
    .addColumn('item_id', 'uuid', (c) => c.notNull().references('items.id').onDelete('cascade'))
    .addColumn('quantity', 'numeric(20, 4)', (c) => c.notNull())
    .addPrimaryKeyConstraint('recipe_inputs_pkey', ['recipe_id', 'item_id'])
    .addCheckConstraint('recipe_inputs_quantity_positive', sql`quantity > 0`)
    .execute();

  // --- Companies -----------------------------------------------------------

  await db.schema
    .createTable('companies')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('owner_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('restrict'))
    .addColumn('industry', sql`industry`, (c) => c.notNull())
    .addColumn('headquarters_parcel_id', 'uuid', (c) =>
      c.references('land_parcels.id').onDelete('set null'),
    )
    .addColumn('cash', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('reputation', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('description', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // A company treasury can never go negative, same rule as a player balance.
    .addCheckConstraint('companies_cash_non_negative', sql`cash >= 0`)
    .execute();

  await sql`create unique index companies_name_key on companies (lower(name))`.execute(db);
  await db.schema.createIndex('companies_owner_idx').on('companies').column('owner_id').execute();

  // --- Inventory -----------------------------------------------------------

  await db.schema
    .createTable('inventory')
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('item_id', 'uuid', (c) => c.notNull().references('items.id').onDelete('restrict'))
    .addColumn('quantity', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('inventory_pkey', ['company_id', 'item_id'])
    // The database-level guarantee against item duplication (spec 52).
    .addCheckConstraint('inventory_quantity_non_negative', sql`quantity >= 0`)
    .execute();

  // --- Production ----------------------------------------------------------

  await db.schema
    .createTable('production_orders')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('recipe_id', 'uuid', (c) =>
      c.notNull().references('recipes.id').onDelete('restrict'),
    )
    .addColumn('batches', 'integer', (c) => c.notNull())
    .addColumn('status', sql`production_status`, (c) => c.notNull().defaultTo('running'))
    .addColumn('labour_cost', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completes_at', 'timestamptz', (c) => c.notNull())
    .addColumn('collected_at', 'timestamptz')
    .addCheckConstraint('production_orders_batches_positive', sql`batches > 0`)
    .execute();

  await sql`
    create index production_orders_pending_idx
      on production_orders (completes_at)
      where status = 'running'
  `.execute(db);

  // --- Employment ----------------------------------------------------------

  await db.schema
    .createTable('job_listings')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('salary', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('positions', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('filled', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('open', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('job_listings_salary_positive', sql`salary > 0`)
    .addCheckConstraint('job_listings_positions_positive', sql`positions > 0`)
    .addCheckConstraint('job_listings_filled_within_positions', sql`filled between 0 and positions`)
    .execute();

  await db.schema
    .createTable('employments')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('listing_id', 'uuid', (c) => c.references('job_listings.id').onDelete('set null'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('salary', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('status', sql`employment_status`, (c) => c.notNull().defaultTo('active'))
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('ended_at', 'timestamptz')
    .execute();

  // A player holds at most one job at a time (spec 8).
  await sql`
    create unique index employments_one_active_job
      on employments (user_id)
      where status = 'active'
  `.execute(db);
  await db.schema
    .createIndex('employments_company_idx')
    .on('employments')
    .column('company_id')
    .execute();

  // --- Marketplace ---------------------------------------------------------

  await db.schema
    .createTable('market_orders')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('item_id', 'uuid', (c) => c.notNull().references('items.id').onDelete('restrict'))
    .addColumn('side', sql`order_side`, (c) => c.notNull())
    .addColumn('quantity', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('remaining', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('status', sql`order_status`, (c) => c.notNull().defaultTo('open'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('closed_at', 'timestamptz')
    .addCheckConstraint('market_orders_quantity_positive', sql`quantity > 0`)
    .addCheckConstraint('market_orders_price_positive', sql`price > 0`)
    .addCheckConstraint('market_orders_remaining_in_range', sql`remaining between 0 and quantity`)
    .execute();

  // The order book: open orders for an item, best price first.
  await sql`
    create index market_orders_book_idx
      on market_orders (item_id, side, price, created_at)
      where status = 'open'
  `.execute(db);
  await db.schema
    .createIndex('market_orders_company_idx')
    .on('market_orders')
    .column('company_id')
    .execute();

  await db.schema
    .createTable('market_trades')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('item_id', 'uuid', (c) => c.notNull().references('items.id').onDelete('restrict'))
    .addColumn('buy_order_id', 'uuid', (c) =>
      c.notNull().references('market_orders.id').onDelete('restrict'),
    )
    .addColumn('sell_order_id', 'uuid', (c) =>
      c.notNull().references('market_orders.id').onDelete('restrict'),
    )
    .addColumn('buyer_company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('restrict'),
    )
    .addColumn('seller_company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('restrict'),
    )
    .addColumn('quantity', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('market_trades_quantity_positive', sql`quantity > 0`)
    .execute();

  await sql`create index market_trades_item_created_idx on market_trades (item_id, created_at desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'market_trades',
    'market_orders',
    'employments',
    'job_listings',
    'production_orders',
    'inventory',
    'companies',
    'recipe_inputs',
    'recipes',
    'items',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }

  for (const type of [
    'employment_status',
    'production_status',
    'order_status',
    'order_side',
    'item_kind',
    'industry',
  ]) {
    await db.schema.dropType(type).ifExists().execute();
  }
}
