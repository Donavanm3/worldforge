import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { seedWorld } from '@wf/worker';
import { buildServer } from '../server.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

describe.runIf(shouldRun)('land (integration)', () => {
  let app: FastifyInstance;
  let db: Db;

  let buyerToken = '';
  let buyerId = '';
  let rivalToken = '';
  let rivalId = '';

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      REDIS_URL: redisUrl!,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
      LOG_LEVEL: 'error',
    });

    db = createDb({ connectionString: databaseUrl! });
    const { error } = await migrateToLatest(db);
    if (error) throw error;

    app = await buildServer({ config, db, paymentProvider: null });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    // Rate limits are keyed by IP and every injected request shares one;
    // clearing the store stops earlier tests exhausting the register bucket.
    await app.redis.flushdb();
    await sql`truncate table payment_events, admin_actions, notifications, transactions, payments, sessions, land_parcels, cities, regions, countries, profiles, users restart identity cascade`.execute(
      db,
    );

    // A small deterministic world keeps the suite fast.
    await seedWorld(db, { parcelsPerCity: 9, seed: 42, forSaleRatio: 1 });

    const register = async (username: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `${username}@worldforge.test`,
          username,
          password: 'a-sufficiently-long-password',
        },
      });
      if (response.statusCode !== 201) {
        // Surface the server's actual reply; otherwise a failed registration
        // shows up as "cannot read properties of undefined".
        throw new Error(`register ${username} failed: ${response.statusCode} ${response.body}`);
      }
      const body = response.json();
      // Land requires world access; grant it directly rather than paying.
      await db
        .updateTable('users')
        .set({ beta_access: true, access_source: 'admin' })
        .where('id', '=', body.user.id)
        .execute();
      return body;
    };

    const buyer = await register('buyer');
    buyerToken = buyer.accessToken;
    buyerId = buyer.user.id;

    const rival = await register('rival');
    rivalToken = rival.accessToken;
    rivalId = rival.user.id;
  }, 60_000);

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function anyParcelForSale() {
    return db
      .selectFrom('land_parcels')
      .selectAll()
      .where('for_sale', '=', true)
      .orderBy('sale_price', 'asc')
      .executeTakeFirstOrThrow();
  }

  async function balanceOf(userId: string): Promise<string> {
    const row = await db
      .selectFrom('profiles')
      .select(['balance'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return String(row.balance);
  }

  it('seeds a starter world with valued parcels', async () => {
    const parcels = await db.selectFrom('land_parcels').selectAll().execute();
    expect(parcels).toHaveLength(90); // 5 countries x 2 cities x 9 parcels

    for (const parcel of parcels) {
      expect(Number(parcel.area_sqm)).toBeGreaterThan(0);
      expect(Number(parcel.market_value)).toBeGreaterThan(0);
    }
  });

  it('refuses to seed a world twice', async () => {
    await expect(seedWorld(db, { parcelsPerCity: 1 })).rejects.toThrow(/already contains/i);
  });

  it('requires world access to view land', async () => {
    const noAccess = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'freeloader@worldforge.test',
        username: 'freeloader',
        password: 'a-sufficiently-long-password',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/land/market',
      headers: auth(noAccess.json().accessToken),
    });
    // 402: authenticated, but has not bought beta access.
    expect(response.statusCode).toBe(402);
  });

  it('returns parcels in a viewport as GeoJSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/land/parcels?west=-13&south=44.5&east=-11&north=46.5',
      headers: auth(buyerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.type).toBe('FeatureCollection');
    expect(body.features.length).toBeGreaterThan(0);
    expect(body.features[0].geometry.type).toBe('Polygon');
    expect(body.features[0].properties.ownerId).toBeNull();
  });

  it('returns nothing for an empty ocean viewport', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/land/parcels?west=-170&south=-80&east=-169&north=-79',
      headers: auth(buyerToken),
    });
    expect(response.json().features).toHaveLength(0);
  });

  it('rejects an oversized viewport', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/land/parcels?west=-180&south=-90&east=180&north=90',
      headers: auth(buyerToken),
    });
    expect(response.statusCode).toBe(400);
  });

  it('buys a parcel, moving money exactly', async () => {
    const parcel = await anyParcelForSale();
    const before = await balanceOf(buyerId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.pricePaid).toBe(String(parcel.sale_price));

    const after = await balanceOf(buyerId);
    expect(Number(before) - Number(after)).toBeCloseTo(Number(parcel.sale_price), 4);

    const owned = await db
      .selectFrom('land_parcels')
      .selectAll()
      .where('id', '=', parcel.id)
      .executeTakeFirstOrThrow();
    expect(owned.owner_id).toBe(buyerId);
    expect(owned.for_sale).toBe(false);
    expect(owned.sale_price).toBeNull();
  });

  it('writes a ledger entry for every purchase', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    const ledger = await db
      .selectFrom('transactions')
      .selectAll()
      .where('reason', '=', 'land_purchase')
      .execute();

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.sender_user_id).toBe(buyerId);
    expect(String(ledger[0]!.amount)).toBe(String(parcel.sale_price));
  });

  it('refuses a purchase the player cannot afford', async () => {
    const parcel = await anyParcelForSale();
    await db
      .updateTable('land_parcels')
      .set({ sale_price: '999999.0000' })
      .where('id', '=', parcel.id)
      .execute();

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    expect(response.statusCode).toBe(409);
    expect(await balanceOf(buyerId)).toBe('10000.0000');

    const unchanged = await db
      .selectFrom('land_parcels')
      .select(['owner_id'])
      .where('id', '=', parcel.id)
      .executeTakeFirstOrThrow();
    expect(unchanged.owner_id).toBeNull();
  });

  it('sells only once when two players buy simultaneously', async () => {
    const parcel = await anyParcelForSale();

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/land/parcels/${parcel.id}/buy`,
        headers: auth(buyerToken),
      }),
      app.inject({
        method: 'POST',
        url: `/api/land/parcels/${parcel.id}/buy`,
        headers: auth(rivalToken),
      }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    // Exactly one winner; the loser gets a conflict, never a second sale.
    expect(codes).toStrictEqual([200, 409]);

    const ledger = await db
      .selectFrom('transactions')
      .selectAll()
      .where('reason', '=', 'land_purchase')
      .execute();
    expect(ledger).toHaveLength(1);

    const owner = await db
      .selectFrom('land_parcels')
      .select(['owner_id'])
      .where('id', '=', parcel.id)
      .executeTakeFirstOrThrow();
    expect([buyerId, rivalId]).toContain(owner.owner_id);
  });

  it('pays the seller when buying from another player', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(buyerToken),
      payload: { price: '250.0000' },
    });

    const sellerBefore = await balanceOf(buyerId);
    const rivalBefore = await balanceOf(rivalId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(rivalToken),
    });
    expect(response.statusCode).toBe(200);

    // Money is conserved: exactly 250 moves from rival to the seller.
    expect(Number(await balanceOf(buyerId)) - Number(sellerBefore)).toBeCloseTo(250, 4);
    expect(Number(rivalBefore) - Number(await balanceOf(rivalId))).toBeCloseTo(250, 4);
  });

  it('refuses to buy a parcel that is not listed', async () => {
    const parcel = await anyParcelForSale();
    await db
      .updateTable('land_parcels')
      .set({ for_sale: false, sale_price: null })
      .where('id', '=', parcel.id)
      .execute();

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to buy a parcel you already own', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(buyerToken),
      payload: { price: '100.0000' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to list or rezone land you do not own', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    const listing = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(rivalToken),
      payload: { price: '1.0000' },
    });
    expect(listing.statusCode).toBe(403);

    const zoning = await app.inject({
      method: 'PATCH',
      url: `/api/land/parcels/${parcel.id}/zoning`,
      headers: auth(rivalToken),
      payload: { zoning: 'commercial' },
    });
    expect(zoning.statusCode).toBe(403);
  });

  it('lists, unlists, and rezones owned land', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(buyerToken),
      payload: { price: '500.0000' },
    });
    let row = await db
      .selectFrom('land_parcels')
      .selectAll()
      .where('id', '=', parcel.id)
      .executeTakeFirstOrThrow();
    expect(row.for_sale).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(buyerToken),
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/land/parcels/${parcel.id}/zoning`,
      headers: auth(buyerToken),
      payload: { zoning: 'commercial' },
    });

    row = await db
      .selectFrom('land_parcels')
      .selectAll()
      .where('id', '=', parcel.id)
      .executeTakeFirstOrThrow();
    expect(row.for_sale).toBe(false);
    expect(row.sale_price).toBeNull();
    expect(row.zoning).toBe('commercial');
  });

  it('rejects an invalid listing price', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/list`,
      headers: auth(buyerToken),
      payload: { price: '-100' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lists owned parcels', async () => {
    const parcel = await anyParcelForSale();
    await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcel.id}/buy`,
      headers: auth(buyerToken),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/land/mine',
      headers: auth(buyerToken),
    });
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0].id).toBe(parcel.id);
  });
});
