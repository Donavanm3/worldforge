import { type Kysely, sql } from 'kysely';

/**
 * Phase 3: banking, equity, bonds, and the price history the economy tick
 * writes (spec 11, 21, 23, 24, 42).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createType('loan_status').asEnum(['active', 'repaid', 'defaulted']).execute();
  await db.schema
    .createType('bond_status')
    .asEnum(['open', 'active', 'matured', 'defaulted'])
    .execute();
  await db.schema.createType('listing_status').asEnum(['private', 'listed']).execute();

  // --- Price history -------------------------------------------------------

  /**
   * One row per item per tick. The market price of an item is the most recent
   * row; keeping the series makes charts and inflation measurable rather than
   * requiring a separate aggregation.
   */
  await db.schema
    .createTable('price_history')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('item_id', 'uuid', (c) => c.notNull().references('items.id').onDelete('cascade'))
    .addColumn('price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('supply', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('demand', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('volume', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('recorded_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('price_history_price_positive', sql`price > 0`)
    .execute();

  await sql`create index price_history_item_time_idx on price_history (item_id, recorded_at desc)`.execute(
    db,
  );

  // The live price per item, updated by the tick.
  await db.schema.alterTable('items').addColumn('market_price', 'numeric(20, 4)').execute();
  await sql`update items set market_price = base_price`.execute(db);
  await sql`alter table items alter column market_price set not null`.execute(db);

  // --- Banking -------------------------------------------------------------

  await db.schema
    .createTable('banks')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().unique().references('companies.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (c) => c.notNull())
    /** Annual rate as a fraction, e.g. 0.085 for 8.5%. */
    .addColumn('deposit_rate', 'numeric(10, 6)', (c) => c.notNull().defaultTo('0.02'))
    .addColumn('loan_rate', 'numeric(10, 6)', (c) => c.notNull().defaultTo('0.09'))
    .addColumn('reserves', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('banks_rates_sane', sql`deposit_rate >= 0 and loan_rate >= 0`)
    // A bank that pays more than it charges is an arbitrage money pump.
    .addCheckConstraint('banks_spread_non_negative', sql`loan_rate >= deposit_rate`)
    .addCheckConstraint('banks_reserves_non_negative', sql`reserves >= 0`)
    .execute();

  await db.schema
    .createTable('loans')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('bank_id', 'uuid', (c) => c.notNull().references('banks.id').onDelete('restrict'))
    .addColumn('borrower_company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('restrict'),
    )
    .addColumn('principal', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('outstanding', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('rate', 'numeric(10, 6)', (c) => c.notNull())
    .addColumn('status', sql`loan_status`, (c) => c.notNull().defaultTo('active'))
    .addColumn('opened_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('closed_at', 'timestamptz')
    .addCheckConstraint('loans_principal_positive', sql`principal > 0`)
    .addCheckConstraint('loans_outstanding_in_range', sql`outstanding >= 0`)
    .execute();

  await db.schema
    .createIndex('loans_borrower_idx')
    .on('loans')
    .column('borrower_company_id')
    .execute();
  await db.schema.createIndex('loans_bank_idx').on('loans').column('bank_id').execute();

  // --- Equity --------------------------------------------------------------

  await db.schema
    .alterTable('companies')
    .addColumn('listing_status', sql`listing_status`, (c) => c.notNull().defaultTo('private'))
    .execute();
  await db.schema
    .alterTable('companies')
    .addColumn('shares_outstanding', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('companies').addColumn('share_price', 'numeric(20, 4)').execute();

  await db.schema
    .createTable('shareholdings')
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('holder_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('shares', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shareholdings_pkey', ['company_id', 'holder_user_id'])
    .addCheckConstraint('shareholdings_shares_non_negative', sql`shares >= 0`)
    .execute();

  await db.schema
    .createTable('share_orders')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('side', sql`order_side`, (c) => c.notNull())
    .addColumn('shares', 'bigint', (c) => c.notNull())
    .addColumn('remaining', 'bigint', (c) => c.notNull())
    .addColumn('price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('status', sql`order_status`, (c) => c.notNull().defaultTo('open'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('closed_at', 'timestamptz')
    .addCheckConstraint('share_orders_shares_positive', sql`shares > 0`)
    .addCheckConstraint('share_orders_price_positive', sql`price > 0`)
    .addCheckConstraint('share_orders_remaining_in_range', sql`remaining between 0 and shares`)
    .execute();

  await sql`
    create index share_orders_book_idx
      on share_orders (company_id, side, price, created_at)
      where status = 'open'
  `.execute(db);

  await db.schema
    .createTable('share_trades')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('cascade'),
    )
    .addColumn('buyer_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('seller_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('shares', 'bigint', (c) => c.notNull())
    .addColumn('price', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`create index share_trades_company_time_idx on share_trades (company_id, created_at desc)`.execute(
    db,
  );

  // --- Bonds ---------------------------------------------------------------

  await db.schema
    .createTable('bonds')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('issuer_company_id', 'uuid', (c) =>
      c.notNull().references('companies.id').onDelete('restrict'),
    )
    .addColumn('face_value', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('coupon_rate', 'numeric(10, 6)', (c) => c.notNull())
    .addColumn('matures_at', 'timestamptz', (c) => c.notNull())
    .addColumn('status', sql`bond_status`, (c) => c.notNull().defaultTo('open'))
    .addColumn('holder_user_id', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('purchased_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('bonds_face_value_positive', sql`face_value > 0`)
    .addCheckConstraint('bonds_coupon_non_negative', sql`coupon_rate >= 0`)
    .execute();

  await db.schema.createIndex('bonds_status_idx').on('bonds').column('status').execute();

  // --- Economy tick bookkeeping -------------------------------------------

  await db.schema
    .createTable('tick_runs')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('details', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('error', 'text')
    .execute();

  await sql`create index tick_runs_kind_time_idx on tick_runs (kind, started_at desc)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'tick_runs',
    'bonds',
    'share_trades',
    'share_orders',
    'shareholdings',
    'loans',
    'banks',
    'price_history',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }

  for (const column of ['listing_status', 'shares_outstanding', 'share_price']) {
    await db.schema.alterTable('companies').dropColumn(column).execute();
  }
  await db.schema.alterTable('items').dropColumn('market_price').execute();

  for (const type of ['listing_status', 'bond_status', 'loan_status']) {
    await db.schema.dropType(type).ifExists().execute();
  }
}
