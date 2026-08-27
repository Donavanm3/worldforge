import { type Kysely, sql } from 'kysely';

/**
 * Webhook idempotency and the admin audit trail.
 *
 * Payment providers retry webhooks and may deliver the same event more than
 * once; `payment_events` gives each delivery a unique key so beta access is
 * granted exactly once (spec 52, 67).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('payment_events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('provider_event_id', 'text', (c) => c.notNull())
    .addColumn('event_type', 'text', (c) => c.notNull())
    .addColumn('payment_id', 'uuid', (c) => c.references('payments.id').onDelete('set null'))
    .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('received_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('processed_at', 'timestamptz')
    .addColumn('error', 'text')
    .execute();

  // The idempotency guarantee: a replayed delivery cannot insert twice.
  await db.schema
    .createIndex('payment_events_provider_event_uq')
    .on('payment_events')
    .columns(['provider', 'provider_event_id'])
    .unique()
    .execute();

  await db.schema
    .createTable('admin_actions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // RESTRICT: an audit trail that can be erased by deleting the actor is not
    // an audit trail.
    .addColumn('admin_user_id', 'uuid', (c) =>
      c.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'text')
    .addColumn('details', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`create index admin_actions_admin_created_idx on admin_actions (admin_user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index admin_actions_target_idx on admin_actions (target_type, target_id)`.execute(
    db,
  );
  await sql`create index payments_status_created_idx on payments (status, created_at desc)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('admin_actions').ifExists().execute();
  await db.schema.dropTable('payment_events').ifExists().execute();
  await sql`drop index if exists payments_status_created_idx`.execute(db);
}
