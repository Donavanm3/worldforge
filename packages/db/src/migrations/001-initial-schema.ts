import { type Kysely, sql } from 'kysely';

/**
 * Phase 1 foundation schema: identity, beta access, payments, the geographic
 * hierarchy, land parcels, and the financial ledger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists postgis`.execute(db);
  await sql`create extension if not exists pgcrypto`.execute(db);

  await db.schema.createType('user_role').asEnum(['player', 'moderator', 'admin']).execute();
  await db.schema
    .createType('user_status')
    .asEnum(['active', 'suspended', 'banned', 'deleted'])
    .execute();
  await db.schema.createType('access_source').asEnum(['payment', 'admin']).execute();
  await db.schema
    .createType('payment_status')
    .asEnum(['pending', 'completed', 'failed', 'refunded'])
    .execute();
  await db.schema
    .createType('land_zoning')
    .asEnum([
      'unzoned',
      'residential',
      'commercial',
      'industrial',
      'agricultural',
      'infrastructure',
    ])
    .execute();

  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('username', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('role', sql`user_role`, (c) => c.notNull().defaultTo('player'))
    .addColumn('status', sql`user_status`, (c) => c.notNull().defaultTo('active'))
    .addColumn('beta_access', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('beta_access_granted_at', 'timestamptz')
    .addColumn('beta_access_payment_id', 'uuid')
    .addColumn('access_source', sql`access_source`)
    .addColumn('last_login_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Case-insensitive uniqueness: "Alice" and "alice" must not both exist.
  await sql`create unique index users_email_key on users (lower(email))`.execute(db);
  await sql`create unique index users_username_key on users (lower(username))`.execute(db);

  await db.schema
    .createTable('countries')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('code', 'text', (c) => c.notNull().unique())
    .addColumn('boundary', sql`geometry(MultiPolygon, 4326)`)
    .addColumn('population', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('regions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('country_id', 'uuid', (c) =>
      c.notNull().references('countries.id').onDelete('cascade'),
    )
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('code', 'text')
    .addColumn('boundary', sql`geometry(MultiPolygon, 4326)`)
    .addColumn('population', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('cities')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('region_id', 'uuid', (c) => c.notNull().references('regions.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('center', sql`geometry(Point, 4326)`, (c) => c.notNull())
    .addColumn('population', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('profiles')
    .addColumn('user_id', 'uuid', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('avatar_url', 'text')
    .addColumn('bio', 'text')
    .addColumn('reputation', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('net_worth', 'numeric(20, 4)', (c) => c.notNull().defaultTo('0'))
    // Every new player starts with $10,000 (spec 5).
    .addColumn('balance', 'numeric(20, 4)', (c) => c.notNull().defaultTo('10000'))
    .addColumn('home_city_id', 'uuid', (c) => c.references('cities.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // A balance can never go negative through any code path.
    .addCheckConstraint('profiles_balance_non_negative', sql`balance >= 0`)
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('user_agent', 'text')
    .addColumn('ip_address', sql`inet`)
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('land_parcels')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('city_id', 'uuid', (c) => c.references('cities.id').onDelete('set null'))
    .addColumn('region_id', 'uuid', (c) => c.notNull().references('regions.id').onDelete('cascade'))
    .addColumn('owner_id', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('boundary', sql`geometry(Polygon, 4326)`, (c) => c.notNull())
    .addColumn('centroid', sql`geometry(Point, 4326)`, (c) => c.notNull())
    .addColumn('area_sqm', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('base_value', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('market_value', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('zoning', sql`land_zoning`, (c) => c.notNull().defaultTo('unzoned'))
    .addColumn('has_power', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('has_water', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('has_internet', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('has_road', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('for_sale', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('sale_price', 'numeric(20, 4)')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'land_parcels_sale_price_present_when_for_sale',
      sql`not for_sale or sale_price is not null`,
    )
    .execute();

  await db.schema
    .createTable('transactions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // RESTRICT, not SET NULL: the ledger is permanent, and nulling both parties
    // would violate transactions_has_party. Users are soft-deleted via status.
    .addColumn('sender_user_id', 'uuid', (c) => c.references('users.id').onDelete('restrict'))
    .addColumn('receiver_user_id', 'uuid', (c) => c.references('users.id').onDelete('restrict'))
    .addColumn('amount', 'numeric(20, 4)', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull().defaultTo('WFD'))
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('idempotency_key', 'text')
    .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // Value must move: a transfer with no sender and no receiver is meaningless.
    .addCheckConstraint('transactions_amount_positive', sql`amount > 0`)
    .addCheckConstraint(
      'transactions_has_party',
      sql`sender_user_id is not null or receiver_user_id is not null`,
    )
    .execute();

  // Makes a retried transfer a no-op rather than a duplicate credit (spec 52).
  await sql`
    create unique index transactions_idempotency_key_uq
      on transactions (idempotency_key)
      where idempotency_key is not null
  `.execute(db);

  await db.schema
    .createTable('payments')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Payment records outlive accounts for the same reason the ledger does.
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('restrict'))
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('provider_payment_id', 'text')
    .addColumn('amount', 'numeric(12, 2)', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull().defaultTo('USD'))
    .addColumn('status', sql`payment_status`, (c) => c.notNull().defaultTo('pending'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .execute();

  // A provider payment id must never be credited twice.
  await sql`
    create unique index payments_provider_payment_uq
      on payments (provider, provider_payment_id)
      where provider_payment_id is not null
  `.execute(db);

  await db.schema
    .alterTable('users')
    .addForeignKeyConstraint(
      'users_beta_access_payment_id_fkey',
      ['beta_access_payment_id'],
      'payments',
      ['id'],
    )
    .onDelete('set null')
    .execute();

  await db.schema
    .createTable('notifications')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text')
    .addColumn('read_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('game_settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('regions_country_id_idx')
    .on('regions')
    .column('country_id')
    .execute();
  await db.schema.createIndex('cities_region_id_idx').on('cities').column('region_id').execute();
  await db.schema
    .createIndex('land_parcels_owner_id_idx')
    .on('land_parcels')
    .column('owner_id')
    .execute();
  await db.schema
    .createIndex('land_parcels_city_id_idx')
    .on('land_parcels')
    .column('city_id')
    .execute();
  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute();
  await db.schema.createIndex('payments_user_id_idx').on('payments').column('user_id').execute();

  await sql`create index transactions_sender_created_idx on transactions (sender_user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index transactions_receiver_created_idx on transactions (receiver_user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index notifications_user_unread_idx on notifications (user_id, created_at desc) where read_at is null`.execute(
    db,
  );

  // Spatial indexes — every map viewport query depends on these.
  await sql`create index countries_boundary_gix on countries using gist (boundary)`.execute(db);
  await sql`create index regions_boundary_gix on regions using gist (boundary)`.execute(db);
  await sql`create index cities_center_gix on cities using gist (center)`.execute(db);
  await sql`create index land_parcels_boundary_gix on land_parcels using gist (boundary)`.execute(
    db,
  );
  await sql`create index land_parcels_centroid_gix on land_parcels using gist (centroid)`.execute(
    db,
  );

  // Defaults for the runtime-tunable settings (spec 70). The admin panel edits
  // these; nothing downstream may hard-code the beta price or game status.
  await sql`
    insert into game_settings (key, value, description) values
      ('GAME_STATUS', 'BETA', 'BETA | RELEASED | MAINTENANCE | REGISTRATION_CLOSED'),
      ('BETA_PRICE', '3.00', 'Beta access price in USD'),
      ('BETA_PAYMENT_REQUIRED', 'true', 'Whether payment is required for access'),
      ('REGISTRATION_ENABLED', 'true', 'Whether new registrations are accepted'),
      ('STARTING_BALANCE', '10000', 'Starting player balance in game currency')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('game_settings').ifExists().execute();
  await db.schema.dropTable('notifications').ifExists().execute();
  await db.schema
    .alterTable('users')
    .dropConstraint('users_beta_access_payment_id_fkey')
    .ifExists()
    .execute();
  await db.schema.dropTable('payments').ifExists().execute();
  await db.schema.dropTable('transactions').ifExists().execute();
  await db.schema.dropTable('land_parcels').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('profiles').ifExists().execute();
  await db.schema.dropTable('cities').ifExists().execute();
  await db.schema.dropTable('regions').ifExists().execute();
  await db.schema.dropTable('countries').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();

  await db.schema.dropType('land_zoning').ifExists().execute();
  await db.schema.dropType('payment_status').ifExists().execute();
  await db.schema.dropType('access_source').ifExists().execute();
  await db.schema.dropType('user_status').ifExists().execute();
  await db.schema.dropType('user_role').ifExists().execute();
}
