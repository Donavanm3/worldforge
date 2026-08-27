import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client.js';
import { migrateDown, migrateToLatest } from '../migrator.js';

const connectionString = process.env['DATABASE_URL'];

/**
 * Exercises the schema against a real PostGIS database. Skipped when
 * DATABASE_URL is absent so the unit suite still runs without Docker; CI always
 * provides one, so the migration is genuinely executed there.
 */
describe.runIf(connectionString)('001-initial-schema (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb({ connectionString: connectionString! });
    const { error } = await migrateToLatest(db);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await migrateDown(db);
      await db.destroy();
    }
  }, 60_000);

  it('creates every Phase 1 table', async () => {
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db);
    const names = rows.rows.map((r) => r.table_name);

    for (const table of [
      'users',
      'profiles',
      'sessions',
      'countries',
      'regions',
      'cities',
      'land_parcels',
      'transactions',
      'payments',
      'notifications',
      'game_settings',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('enables PostGIS', async () => {
    const result = await sql<{ postgis_version: string }>`select postgis_version()`.execute(db);
    expect(result.rows[0]?.postgis_version).toBeTruthy();
  });

  it('seeds the tunable game settings', async () => {
    const settings = await db.selectFrom('game_settings').select(['key', 'value']).execute();
    const asMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));

    expect(asMap['GAME_STATUS']).toBe('BETA');
    expect(asMap['BETA_PRICE']).toBe('3.00');
    expect(asMap['REGISTRATION_ENABLED']).toBe('true');
  });

  it('treats usernames and emails case-insensitively', async () => {
    await db
      .insertInto('users')
      .values({ email: 'Ada@example.com', username: 'Ada', password_hash: 'x' })
      .execute();

    await expect(
      db
        .insertInto('users')
        .values({ email: 'ada@EXAMPLE.com', username: 'unique-name', password_hash: 'x' })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db
        .insertInto('users')
        .values({ email: 'other@example.com', username: 'ADA', password_hash: 'x' })
        .execute(),
    ).rejects.toThrow();

    await db.deleteFrom('users').where('username', '=', 'Ada').execute();
  });

  it('starts players at 10000 and forbids a negative balance', async () => {
    const user = await db
      .insertInto('users')
      .values({ email: 'grace@example.com', username: 'grace', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const profile = await db
      .insertInto('profiles')
      .values({ user_id: user.id, display_name: 'Grace' })
      .returning('balance')
      .executeTakeFirstOrThrow();

    // Read back as an exact string, never a float.
    expect(profile.balance).toBe('10000.0000');

    await expect(
      db.updateTable('profiles').set({ balance: '-1' }).where('user_id', '=', user.id).execute(),
    ).rejects.toThrow();

    await db.deleteFrom('users').where('id', '=', user.id).execute();
  });

  it('rejects a duplicate transaction idempotency key', async () => {
    const user = await db
      .insertInto('users')
      .values({ email: 'linus@example.com', username: 'linus', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const entry = {
      receiver_user_id: user.id,
      amount: '250.0000',
      reason: 'test-credit',
      idempotency_key: 'dup-key-1',
    };

    await db.insertInto('transactions').values(entry).execute();
    await expect(db.insertInto('transactions').values(entry).execute()).rejects.toThrow();

    // Null keys stay exempt from the partial unique index.
    await db
      .insertInto('transactions')
      .values({ receiver_user_id: user.id, amount: '1', reason: 'no-key' })
      .execute();
    await db
      .insertInto('transactions')
      .values({ receiver_user_id: user.id, amount: '1', reason: 'no-key' })
      .execute();

    // The ledger pins the account: deleting a user with history must fail.
    await expect(db.deleteFrom('users').where('id', '=', user.id).execute()).rejects.toThrow();

    await db.deleteFrom('transactions').where('receiver_user_id', '=', user.id).execute();
    await db.deleteFrom('users').where('id', '=', user.id).execute();
  });

  it('rejects a non-positive transaction amount', async () => {
    await expect(
      db.insertInto('transactions').values({ amount: '0', reason: 'zero' }).execute(),
    ).rejects.toThrow();
  });
});
