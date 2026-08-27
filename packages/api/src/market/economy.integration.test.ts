import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { seedCatalog } from '@wf/worker';
import { buildServer } from '../server.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

describe.runIf(shouldRun)('economy (integration)', () => {
  let app: FastifyInstance;
  let db: Db;

  let aliceToken = '';
  let bobToken = '';
  let aliceCo = '';
  let bobCo = '';
  let itemIds: Record<string, string> = {};
  let recipeBySlug: Record<string, string> = {};

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

  async function found(token: string, name: string, capital = '5000.00') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      headers: auth(token),
      payload: { name, industry: 'manufacturing', initialCapital: capital },
    });
    if (response.statusCode !== 201) {
      throw new Error(`found ${name}: ${response.statusCode} ${response.body}`);
    }
    return response.json().id as string;
  }

  /** Puts stock straight into inventory, bypassing production. */
  async function grantStock(companyId: string, slug: string, quantity: string) {
    await db
      .insertInto('inventory')
      .values({
        company_id: companyId,
        item_id: itemIds[slug]!,
        quantity: sql`${quantity}::numeric`,
      })
      .onConflict((oc) =>
        oc
          .columns(['company_id', 'item_id'])
          .doUpdateSet({ quantity: sql`inventory.quantity + ${quantity}::numeric` }),
      )
      .execute();
  }

  async function cashOf(companyId: string): Promise<number> {
    const row = await db
      .selectFrom('companies')
      .select('cash')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    return Number(row.cash);
  }

  async function stockOf(companyId: string, slug: string): Promise<number> {
    const row = await db
      .selectFrom('inventory')
      .select('quantity')
      .where('company_id', '=', companyId)
      .where('item_id', '=', itemIds[slug]!)
      .executeTakeFirst();
    return Number(row?.quantity ?? 0);
  }

  beforeEach(async () => {
    await app.redis.flushdb();
    await sql`truncate table market_trades, market_orders, employments, job_listings, production_orders, inventory, companies, transactions, notifications, sessions, profiles, users restart identity cascade`.execute(
      db,
    );
    await seedCatalog(db);

    const items = await db.selectFrom('items').select(['id', 'slug']).execute();
    itemIds = Object.fromEntries(items.map((i) => [i.slug, i.id]));

    const recipes = await db
      .selectFrom('recipes')
      .innerJoin('items', 'items.id', 'recipes.output_item_id')
      .select(['recipes.id', 'items.slug'])
      .execute();
    recipeBySlug = Object.fromEntries(recipes.map((r) => [r.slug, r.id]));

    const alice = await register('alice');
    const bob = await register('bob');
    aliceToken = alice.accessToken;
    bobToken = bob.accessToken;
    aliceCo = await found(aliceToken, 'Astoria Steel');
    bobCo = await found(bobToken, 'Verdant Foundry');
  }, 60_000);

  // --- catalogue ---

  it('seeds a catalogue where every recipe input exists', async () => {
    const orphans = await sql<{ count: string }>`
      select count(*) as count from recipe_inputs ri
      left join items i on i.id = ri.item_id
      where i.id is null
    `.execute(db);
    expect(Number(orphans.rows[0]!.count)).toBe(0);

    const items = await app.inject({ method: 'GET', url: '/api/items', headers: auth(aliceToken) });
    expect(items.json().length).toBeGreaterThan(10);
  });

  it('is safe to re-seed the catalogue', async () => {
    const before = await db.selectFrom('items').selectAll().execute();
    await seedCatalog(db);
    const after = await db.selectFrom('items').selectAll().execute();
    expect(after).toHaveLength(before.length);
  });

  // --- companies ---

  it('charges incorporation and capital to the founder', async () => {
    const profile = await db
      .selectFrom('profiles')
      .innerJoin('users', 'users.id', 'profiles.user_id')
      .select('profiles.balance')
      .where('users.username', '=', 'alice')
      .executeTakeFirstOrThrow();

    // 10,000 start - 500 fee - 5,000 capital
    expect(Number(profile.balance)).toBeCloseTo(4500, 4);
    expect(await cashOf(aliceCo)).toBeCloseTo(5000, 4);
  });

  it('refuses a duplicate company name regardless of case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      headers: auth(bobToken),
      payload: { name: 'ASTORIA STEEL', industry: 'retail' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to incorporate without the fee', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      headers: auth(aliceToken),
      payload: { name: 'Overreach Ltd', industry: 'finance', initialCapital: '999999.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('moves money between player and treasury without creating any', async () => {
    const before = await cashOf(aliceCo);
    await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/treasury`,
      headers: auth(aliceToken),
      payload: { direction: 'withdraw', amount: '1000.00' },
    });
    expect(await cashOf(aliceCo)).toBeCloseTo(before - 1000, 4);

    const overdraw = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/treasury`,
      headers: auth(aliceToken),
      payload: { direction: 'withdraw', amount: '999999.00' },
    });
    expect(overdraw.statusCode).toBe(409);
  });

  it('refuses treasury access to a non-owner', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/treasury`,
      headers: auth(bobToken),
      payload: { direction: 'withdraw', amount: '1.00' },
    });
    expect(response.statusCode).toBe(403);
  });

  // --- production ---

  it('runs extraction, which needs no inputs', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
      payload: { recipeId: recipeBySlug['iron-ore'], batches: 2 },
    });
    expect(start.statusCode).toBe(201);

    // Finish it immediately rather than waiting out the timer.
    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);

    const list = await app.inject({
      method: 'GET',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
    });
    expect(list.statusCode).toBe(200);
    // Recipe yields 10 per batch.
    expect(await stockOf(aliceCo, 'iron-ore')).toBeCloseTo(20, 4);
  });

  it('consumes inputs up front and refuses runs without stock', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
      payload: { recipeId: recipeBySlug['steel'], batches: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/not enough/i);
  });

  it('turns ore and coal into steel', async () => {
    await grantStock(aliceCo, 'iron-ore', '40');
    await grantStock(aliceCo, 'coal', '20');

    const start = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
      payload: { recipeId: recipeBySlug['steel'], batches: 2 },
    });
    expect(start.statusCode).toBe(201);

    // 2 batches consume 40 ore and 16 coal immediately.
    expect(await stockOf(aliceCo, 'iron-ore')).toBeCloseTo(0, 4);
    expect(await stockOf(aliceCo, 'coal')).toBeCloseTo(4, 4);
    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(0, 4);

    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);
    await app.inject({
      method: 'GET',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
    });

    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(20, 4);
  });

  it('does not deliver output twice when collected repeatedly', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
      payload: { recipeId: recipeBySlug['coal'], batches: 1 },
    });
    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);

    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'GET',
        url: `/api/companies/${aliceCo}/production`,
        headers: auth(aliceToken),
      });
    }
    expect(await stockOf(aliceCo, 'coal')).toBeCloseTo(12, 4);
  });

  // --- marketplace ---

  async function placeOrder(
    token: string,
    companyId: string,
    slug: string,
    side: 'buy' | 'sell',
    quantity: string,
    price: string,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/market/orders',
      headers: auth(token),
      payload: { companyId, itemId: itemIds[slug], side, quantity, price },
    });
  }

  it('rests an order when nothing crosses', async () => {
    await grantStock(aliceCo, 'steel', '100');
    const response = await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '50');

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('open');
    expect(response.json().filledQuantity).toBe('0.0000');
    // Stock is escrowed the moment the order rests.
    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(90, 4);
  });

  it('settles a crossing trade, moving goods and cash exactly', async () => {
    await grantStock(aliceCo, 'steel', '100');
    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '50');

    const sellerBefore = await cashOf(aliceCo);
    const buyerBefore = await cashOf(bobCo);

    const buy = await placeOrder(bobToken, bobCo, 'steel', 'buy', '10', '60');
    expect(buy.statusCode).toBe(201);
    expect(buy.json().filledQuantity).toBe('10.0000');
    // Executes at the resting price of 50, not the buyer's limit of 60.
    expect(buy.json().totalValue).toBe('500.0000');

    expect(await stockOf(bobCo, 'steel')).toBeCloseTo(10, 4);
    expect(await cashOf(aliceCo)).toBeCloseTo(sellerBefore + 500, 4);
    // The buyer is charged 500, not 600 — the surplus is refunded.
    expect(await cashOf(bobCo)).toBeCloseTo(buyerBefore - 500, 4);
  });

  it('conserves value across a trade', async () => {
    await grantStock(aliceCo, 'steel', '50');
    const totalBefore = (await cashOf(aliceCo)) + (await cashOf(bobCo));

    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '20', '40');
    await placeOrder(bobToken, bobCo, 'steel', 'buy', '20', '40');

    // Money only moves between the two treasuries; none is created or lost.
    expect((await cashOf(aliceCo)) + (await cashOf(bobCo))).toBeCloseTo(totalBefore, 4);
    expect((await stockOf(aliceCo, 'steel')) + (await stockOf(bobCo, 'steel'))).toBeCloseTo(50, 4);
  });

  it('fills partially and leaves the remainder resting', async () => {
    await grantStock(aliceCo, 'steel', '5');
    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '5', '40');

    const buy = await placeOrder(bobToken, bobCo, 'steel', 'buy', '12', '40');
    expect(buy.json().filledQuantity).toBe('5.0000');
    expect(buy.json().remainingQuantity).toBe('7.0000');
    expect(buy.json().status).toBe('open');
  });

  it('refuses to sell stock the company does not hold', async () => {
    const response = await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '50');
    expect(response.statusCode).toBe(409);
  });

  it('refuses a buy the company cannot fund', async () => {
    const response = await placeOrder(bobToken, bobCo, 'steel', 'buy', '1000', '9999');
    expect(response.statusCode).toBe(409);
  });

  it('will not let a company trade with itself', async () => {
    await grantStock(aliceCo, 'steel', '50');
    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '40');

    const buy = await placeOrder(aliceToken, aliceCo, 'steel', 'buy', '10', '99');
    // Wash trade: the order rests instead of matching its own sell.
    expect(buy.json().filledQuantity).toBe('0.0000');
    expect(await db.selectFrom('market_trades').selectAll().execute()).toHaveLength(0);
  });

  it('returns escrowed goods and cash when an order is cancelled', async () => {
    await grantStock(aliceCo, 'steel', '30');
    const sell = await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '30', '40');
    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(0, 4);

    await app.inject({
      method: 'DELETE',
      url: `/api/market/orders/${sell.json().orderId}`,
      headers: auth(aliceToken),
    });
    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(30, 4);

    const cashBefore = await cashOf(bobCo);
    const buy = await placeOrder(bobToken, bobCo, 'steel', 'buy', '10', '20');
    expect(await cashOf(bobCo)).toBeCloseTo(cashBefore - 200, 4);

    await app.inject({
      method: 'DELETE',
      url: `/api/market/orders/${buy.json().orderId}`,
      headers: auth(bobToken),
    });
    expect(await cashOf(bobCo)).toBeCloseTo(cashBefore, 4);
  });

  it('refuses to cancel someone else order', async () => {
    await grantStock(aliceCo, 'steel', '10');
    const sell = await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '40');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/market/orders/${sell.json().orderId}`,
      headers: auth(bobToken),
    });
    expect(response.statusCode).toBe(409);
  });

  it('publishes an order book and trade history', async () => {
    await grantStock(aliceCo, 'steel', '30');
    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '10', '55');
    await placeOrder(bobToken, bobCo, 'steel', 'buy', '5', '45');

    const book = await app.inject({
      method: 'GET',
      url: `/api/market/items/${itemIds['steel']}/book`,
      headers: auth(aliceToken),
    });
    expect(book.json().asks).toHaveLength(1);
    expect(book.json().bids).toHaveLength(1);

    await placeOrder(bobToken, bobCo, 'steel', 'buy', '10', '55');
    const trades = await app.inject({
      method: 'GET',
      url: `/api/market/items/${itemIds['steel']}/trades`,
      headers: auth(aliceToken),
    });
    expect(trades.json()).toHaveLength(1);
  });

  // --- employment ---

  it('hires, pays and terminates an employee', async () => {
    const listing = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Foundry Operator', salary: '250.00', positions: 1 },
    });
    expect(listing.statusCode).toBe(201);
    const listingId = listing.json().id;

    const applied = await app.inject({
      method: 'POST',
      url: `/api/jobs/${listingId}/apply`,
      headers: auth(bobToken),
    });
    expect(applied.statusCode).toBe(201);

    const companyBefore = await cashOf(aliceCo);
    const payroll = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/payroll`,
      headers: auth(aliceToken),
    });
    expect(payroll.json()).toMatchObject({ paid: 1, unpaid: 0 });
    expect(await cashOf(aliceCo)).toBeCloseTo(companyBefore - 250, 4);

    const employees = await app.inject({
      method: 'GET',
      url: `/api/companies/${aliceCo}/employees`,
      headers: auth(aliceToken),
    });
    expect(employees.json()).toHaveLength(1);

    await app.inject({
      method: 'DELETE',
      url: `/api/companies/${aliceCo}/employees/${applied.json().id}`,
      headers: auth(aliceToken),
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/companies/${aliceCo}/employees`,
      headers: auth(aliceToken),
    });
    expect(after.json()).toHaveLength(0);
  });

  it('allows only one active job per player', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Operator', salary: '100.00', positions: 5 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${first.json().id}/apply`,
      headers: auth(bobToken),
    });

    const again = await app.inject({
      method: 'POST',
      url: `/api/jobs/${first.json().id}/apply`,
      headers: auth(bobToken),
    });
    expect(again.statusCode).toBe(409);
  });

  it('will not hire more people than there are positions', async () => {
    const listing = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Sole Operator', salary: '100.00', positions: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(bobToken),
    });

    const carol = await register('carol');
    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(carol.accessToken),
    });
    expect(response.statusCode).toBe(409);
  });

  it('frees the seat when an employee resigns', async () => {
    const listing = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Operator', salary: '100.00', positions: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(bobToken),
    });
    await app.inject({ method: 'POST', url: '/api/jobs/resign', headers: auth(bobToken) });

    const row = await db
      .selectFrom('job_listings')
      .select('filled')
      .where('id', '=', listing.json().id)
      .executeTakeFirstOrThrow();
    expect(row.filled).toBe(0);
  });

  it('refuses to employ the owner at their own company', async () => {
    const listing = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Operator', salary: '100.00', positions: 1 },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(aliceToken),
    });
    expect(response.statusCode).toBe(409);
  });

  it('pays who it can when payroll exceeds the treasury', async () => {
    await db.updateTable('companies').set({ cash: '300' }).where('id', '=', aliceCo).execute();

    const listing = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/jobs`,
      headers: auth(aliceToken),
      payload: { title: 'Operator', salary: '250.00', positions: 5 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(bobToken),
    });
    const carol = await register('carol');
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${listing.json().id}/apply`,
      headers: auth(carol.accessToken),
    });

    const payroll = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/payroll`,
      headers: auth(aliceToken),
    });

    // One salary fits in 300, the second does not; the treasury never goes
    // negative and the shortfall is reported rather than swallowed.
    expect(payroll.json()).toMatchObject({ paid: 1, unpaid: 1 });
    expect(await cashOf(aliceCo)).toBeCloseTo(50, 4);
  });

  // --- end to end ---

  it('supports the full chain: mine, refine, list, sell, get paid', async () => {
    await grantStock(aliceCo, 'iron-ore', '40');
    await grantStock(aliceCo, 'coal', '16');

    await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
      payload: { recipeId: recipeBySlug['steel'], batches: 2 },
    });
    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);
    await app.inject({
      method: 'GET',
      url: `/api/companies/${aliceCo}/production`,
      headers: auth(aliceToken),
    });
    expect(await stockOf(aliceCo, 'steel')).toBeCloseTo(20, 4);

    await placeOrder(aliceToken, aliceCo, 'steel', 'sell', '20', '60');
    const sellerBefore = await cashOf(aliceCo);

    const buy = await placeOrder(bobToken, bobCo, 'steel', 'buy', '20', '60');
    expect(buy.json().filledQuantity).toBe('20.0000');

    expect(await cashOf(aliceCo)).toBeCloseTo(sellerBefore + 1200, 4);
    expect(await stockOf(bobCo, 'steel')).toBeCloseTo(20, 4);
  });
});
