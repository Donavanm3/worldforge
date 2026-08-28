import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { buildServer } from '../server.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

describe.runIf(shouldRun)('buildings (integration)', () => {
  let app: FastifyInstance;
  let db: Db;

  let aliceToken = '';
  let aliceId = '';
  let bobToken = '';
  let bobId = '';
  let parcelId = '';

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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function register(username: string) {
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
      throw new Error(`register ${username}: ${response.statusCode} ${response.body}`);
    }
    const body = response.json();
    await db
      .updateTable('users')
      .set({ beta_access: true, access_source: 'admin' })
      .where('id', '=', body.user.id)
      .execute();
    return body;
  }

  async function setBalance(userId: string, amount: string) {
    await db
      .updateTable('profiles')
      .set({ balance: sql`${amount}::numeric` })
      .where('user_id', '=', userId)
      .execute();
  }

  async function balanceOf(userId: string): Promise<number> {
    const row = await db
      .selectFrom('profiles')
      .select('balance')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.balance);
  }

  /** A parcel owned by Alice, large enough to build something real on. */
  async function giveAliceLand(): Promise<string> {
    const country = await db
      .insertInto('countries')
      .values({
        name: `Buildland ${Date.now()}`,
        code: `B${Date.now() % 100000}`,
        population: 1000,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const region = await db
      .insertInto('regions')
      .values({ country_id: country.id, name: 'Test Region', population: 1000 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const city = await db
      .insertInto('cities')
      .values({
        region_id: region.id,
        name: 'Test City',
        population: 1000,
        center: sql`ST_SetSRID(ST_MakePoint(0, 0), 4326)` as never,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const parcel = await db
      .insertInto('land_parcels')
      .values({
        city_id: city.id,
        region_id: region.id,
        owner_id: aliceId,
        boundary: sql`ST_MakeEnvelope(0, 0, 0.001, 0.001, 4326)` as never,
        centroid: sql`ST_SetSRID(ST_MakePoint(0.0005, 0.0005), 4326)` as never,
        area_sqm: sql`5000::numeric` as never,
        base_value: sql`5000::numeric` as never,
        market_value: sql`5000::numeric` as never,
        zoning: 'commercial',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return parcel.id;
  }

  beforeEach(async () => {
    await sql`truncate table buildings, building_floors, building_units restart identity cascade`.execute(
      db,
    );

    const alice = await register(`alice${Date.now()}`);
    aliceToken = alice.accessToken;
    aliceId = alice.user.id;
    const bob = await register(`bob${Date.now()}`);
    bobToken = bob.accessToken;
    bobId = bob.user.id;

    await setBalance(aliceId, '5000000.00');
    await setBalance(bobId, '5000000.00');
    parcelId = await giveAliceLand();
  });

  const plan = { footprintSqm: 800, floors: 6, type: 'mixed_use' };

  async function build(name = 'Alice Tower') {
    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/build`,
      headers: auth(aliceToken),
      payload: { ...plan, name },
    });
    if (response.statusCode !== 201) {
      throw new Error(`build: ${response.statusCode} ${response.body}`);
    }
    return response.json();
  }

  /** Construction is time-gated; tests jump the clock rather than wait. */
  async function finishConstruction(buildingId: string) {
    await db
      .updateTable('buildings')
      .set({ status: 'complete', completes_at: sql`now() - interval '1 minute'` as never })
      .where('id', '=', buildingId)
      .execute();
  }

  it('quotes a building without charging for it', async () => {
    const before = await balanceOf(aliceId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/quote`,
      headers: auth(aliceToken),
      payload: plan,
    });

    expect(response.statusCode).toBe(200);
    const quote = response.json();
    expect(Number(quote.constructionCost)).toBeGreaterThan(0);
    expect(quote.floors).toBe(6);
    expect(quote.unitCount).toBeGreaterThan(0);
    expect(await balanceOf(aliceId)).toBe(before);
  });

  it('charges the exact quoted cost when construction starts', async () => {
    const quote = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/quote`,
      headers: auth(aliceToken),
      payload: plan,
    });
    const cost = Number(quote.json().constructionCost);

    const before = await balanceOf(aliceId);
    const result = await build();

    expect(Number(result.constructionCost)).toBeCloseTo(cost, 2);
    expect(await balanceOf(aliceId)).toBeCloseTo(before - cost, 2);
  });

  it('creates every floor and unit up front', async () => {
    const { buildingId, unitCount } = await build();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/buildings/${buildingId}`,
      headers: auth(aliceToken),
    });

    const body = detail.json();
    expect(body.floorPlan).toHaveLength(6);
    expect(body.floorPlan.flatMap((f: { units: unknown[] }) => f.units)).toHaveLength(unitCount);
    // Mixed use: shops on the street, homes above.
    expect(body.floorPlan[0].use).toBe('shop');
    expect(body.floorPlan[1].use).toBe('apartment');
  });

  it('refuses to build on land someone else owns', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/build`,
      headers: auth(bobToken),
      payload: { ...plan, name: 'Bob Tower' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows only one building per parcel', async () => {
    await build();
    const second = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/build`,
      headers: auth(aliceToken),
      payload: { ...plan, name: 'Second Tower' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a footprint that overruns the parcel', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/build`,
      headers: auth(aliceToken),
      payload: { ...plan, footprintSqm: 4900, name: 'Overbuild' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses construction the player cannot afford', async () => {
    await setBalance(aliceId, '10.00');
    const response = await app.inject({
      method: 'POST',
      url: `/api/land/parcels/${parcelId}/build`,
      headers: auth(aliceToken),
      payload: { ...plan, name: 'Broke Tower' },
    });
    expect(response.statusCode).toBe(409);
    expect(await balanceOf(aliceId)).toBe(10);
  });

  it('will not sell units in a building that is still going up', async () => {
    const { buildingId } = await build();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/buildings/${buildingId}`,
      headers: auth(aliceToken),
    });
    const unit = detail.json().floorPlan[0].units[0];

    const listed = await app.inject({
      method: 'POST',
      url: `/api/units/${unit.id}/list`,
      headers: auth(aliceToken),
      payload: { price: '1000.00' },
    });
    expect(listed.statusCode).toBe(409);
  });

  it('transfers a unit and conserves money on sale', async () => {
    const { buildingId } = await build();
    await finishConstruction(buildingId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/buildings/${buildingId}`,
      headers: auth(aliceToken),
    });
    const unit = detail.json().floorPlan[0].units[0];

    await app.inject({
      method: 'POST',
      url: `/api/units/${unit.id}/list`,
      headers: auth(aliceToken),
      payload: { price: '2500.00' },
    });

    const aliceBefore = await balanceOf(aliceId);
    const bobBefore = await balanceOf(bobId);

    const bought = await app.inject({
      method: 'POST',
      url: `/api/units/${unit.id}/buy`,
      headers: auth(bobToken),
    });
    expect(bought.statusCode).toBe(200);

    expect(await balanceOf(bobId)).toBeCloseTo(bobBefore - 2500, 2);
    expect(await balanceOf(aliceId)).toBeCloseTo(aliceBefore + 2500, 2);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/units/mine',
      headers: auth(bobToken),
    });
    expect(mine.json().map((u: { id: string }) => u.id)).toContain(unit.id);
  });

  it('refuses to sell a unit twice', async () => {
    const { buildingId } = await build();
    await finishConstruction(buildingId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/buildings/${buildingId}`,
      headers: auth(aliceToken),
    });
    const unit = detail.json().floorPlan[0].units[0];

    await app.inject({
      method: 'POST',
      url: `/api/units/${unit.id}/list`,
      headers: auth(aliceToken),
      payload: { price: '2500.00' },
    });
    await app.inject({ method: 'POST', url: `/api/units/${unit.id}/buy`, headers: auth(bobToken) });

    const second = await app.inject({
      method: 'POST',
      url: `/api/units/${unit.id}/buy`,
      headers: auth(bobToken),
    });
    expect(second.statusCode).toBe(409);
  });

  it('lists a player their own buildings', async () => {
    await build('Alice Plaza');
    const response = await app.inject({
      method: 'GET',
      url: '/api/buildings/mine',
      headers: auth(aliceToken),
    });

    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Alice Plaza');
    expect(body[0].unitCount).toBeGreaterThan(0);
  });
});
