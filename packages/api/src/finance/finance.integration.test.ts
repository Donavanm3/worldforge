import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { runEconomyTick, runPriceTick, seedCatalog } from '@wf/worker';
import { buildServer } from '../server.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

describe.runIf(shouldRun)('finance and the economy tick (integration)', () => {
  let app: FastifyInstance;
  let db: Db;

  let aliceToken = '';
  let bobToken = '';
  let aliceId = '';
  let bobId = '';
  let aliceCo = '';
  let bobCo = '';
  let itemIds: Record<string, string> = {};

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

  async function found(token: string, name: string, capital: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      headers: auth(token),
      payload: { name, industry: 'finance', initialCapital: capital },
    });
    if (response.statusCode !== 201) {
      throw new Error(`found ${name}: ${response.statusCode} ${response.body}`);
    }
    return response.json().id as string;
  }

  const cashOf = async (companyId: string) =>
    Number(
      (
        await db
          .selectFrom('companies')
          .select('cash')
          .where('id', '=', companyId)
          .executeTakeFirstOrThrow()
      ).cash,
    );

  const balanceOf = async (userId: string) =>
    Number(
      (
        await db
          .selectFrom('profiles')
          .select('balance')
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).balance,
    );

  const reservesOf = async (bankId: string) =>
    Number(
      (
        await db
          .selectFrom('banks')
          .select('reserves')
          .where('id', '=', bankId)
          .executeTakeFirstOrThrow()
      ).reserves,
    );

  beforeEach(async () => {
    await app.redis.flushdb();
    await sql`truncate table tick_runs, bonds, share_trades, share_orders, shareholdings, loans, banks, price_history, market_trades, market_orders, employments, job_listings, production_orders, inventory, companies, transactions, notifications, sessions, profiles, users restart identity cascade`.execute(
      db,
    );
    await seedCatalog(db);
    await sql`update items set market_price = base_price`.execute(db);

    const items = await db.selectFrom('items').select(['id', 'slug']).execute();
    itemIds = Object.fromEntries(items.map((i) => [i.slug, i.id]));

    const alice = await register('alice');
    const bob = await register('bob');
    aliceToken = alice.accessToken;
    bobToken = bob.accessToken;
    aliceId = alice.user.id;
    bobId = bob.user.id;
    aliceCo = await found(aliceToken, 'Astoria Bank Holdings', '5000.00');
    bobCo = await found(bobToken, 'Verdant Industries', '4000.00');
  }, 60_000);

  // --- banking ---

  async function openBank(reserves = '3000.00') {
    const bank = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/bank`,
      headers: auth(aliceToken),
      payload: { name: 'First Astorian', depositRate: '0.02', loanRate: '0.09' },
    });
    const bankId = bank.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/fund`,
      headers: auth(aliceToken),
      payload: { amount: reserves },
    });
    return bankId;
  }

  it('opens a bank and funds it from the company treasury', async () => {
    const before = await cashOf(aliceCo);
    const bankId = await openBank('3000.00');

    expect(await reservesOf(bankId)).toBeCloseTo(3000, 4);
    expect(await cashOf(aliceCo)).toBeCloseTo(before - 3000, 4);
  });

  it('refuses a bank whose loan rate undercuts its deposit rate', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/companies/${aliceCo}/bank`,
      headers: auth(aliceToken),
      payload: { name: 'Arbitrage Bank', depositRate: '0.5', loanRate: '0.1' },
    });
    // Paying more than you charge is a money pump.
    expect(response.statusCode).toBe(400);
  });

  it('refuses to fund a bank beyond the treasury', async () => {
    const bankId = await openBank('1000.00');
    const response = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/fund`,
      headers: auth(aliceToken),
      payload: { amount: '999999.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('lends without creating money', async () => {
    const bankId = await openBank('3000.00');
    const reservesBefore = await reservesOf(bankId);
    const borrowerBefore = await cashOf(bobCo);

    const loan = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/loans`,
      headers: auth(bobToken),
      payload: { companyId: bobCo, amount: '2000.00' },
    });
    expect(loan.statusCode).toBe(201);

    // Every unit the borrower gained left the bank's reserves.
    expect(await reservesOf(bankId)).toBeCloseTo(reservesBefore - 2000, 4);
    expect(await cashOf(bobCo)).toBeCloseTo(borrowerBefore + 2000, 4);
  });

  it('refuses to lend more than the bank holds', async () => {
    const bankId = await openBank('500.00');
    const response = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/loans`,
      headers: auth(bobToken),
      payload: { companyId: bobCo, amount: '5000.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('repays a loan and returns the money to reserves', async () => {
    const bankId = await openBank('3000.00');
    const loan = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/loans`,
      headers: auth(bobToken),
      payload: { companyId: bobCo, amount: '2000.00' },
    });
    const loanId = loan.json().id;

    const reservesBefore = await reservesOf(bankId);
    const repay = await app.inject({
      method: 'POST',
      url: `/api/loans/${loanId}/repay`,
      headers: auth(bobToken),
      payload: { amount: '500.00' },
    });

    expect(Number(repay.json().outstanding)).toBeCloseTo(1500, 4);
    expect(await reservesOf(bankId)).toBeCloseTo(reservesBefore + 500, 4);
  });

  it('never takes more than is owed on repayment', async () => {
    const bankId = await openBank('3000.00');
    const loan = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/loans`,
      headers: auth(bobToken),
      payload: { companyId: bobCo, amount: '1000.00' },
    });

    const cashBefore = await cashOf(bobCo);
    const repay = await app.inject({
      method: 'POST',
      url: `/api/loans/${loan.json().id}/repay`,
      headers: auth(bobToken),
      payload: { amount: '999999.00' },
    });

    expect(Number(repay.json().outstanding)).toBeCloseTo(0, 4);
    // Overpaying settles the debt exactly, not the amount offered.
    expect(await cashOf(bobCo)).toBeCloseTo(cashBefore - 1000, 4);
  });

  it('accrues interest on the tick, increasing what is owed', async () => {
    const bankId = await openBank('3000.00');
    const loan = await app.inject({
      method: 'POST',
      url: `/api/banks/${bankId}/loans`,
      headers: auth(bobToken),
      payload: { companyId: bobCo, amount: '1000.00' },
    });

    await runEconomyTick(db);
    const after = await db
      .selectFrom('loans')
      .select('outstanding')
      .where('id', '=', loan.json().id)
      .executeTakeFirstOrThrow();

    expect(Number(after.outstanding)).toBeGreaterThan(1000);
  });

  // --- equity ---

  async function goPublic(shares = 1000, price = '10.00') {
    return app.inject({
      method: 'POST',
      url: `/api/companies/${bobCo}/list`,
      headers: auth(bobToken),
      payload: { shares, openingPrice: price },
    });
  }

  it('lists a company and allocates every share to the founder', async () => {
    const response = await goPublic();
    expect(response.statusCode).toBe(201);

    const holdings = await db
      .selectFrom('shareholdings')
      .selectAll()
      .where('company_id', '=', bobCo)
      .execute();
    expect(holdings).toHaveLength(1);
    expect(Number(holdings[0]!.shares)).toBe(1000);
    expect(holdings[0]!.holder_user_id).toBe(bobId);
  });

  it('refuses to list twice', async () => {
    await goPublic();
    expect((await goPublic()).statusCode).toBe(409);
  });

  it('refuses share orders in a private company', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(aliceToken),
      payload: { side: 'buy', shares: 10, price: '10.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('settles a share trade, conserving both money and shares', async () => {
    await goPublic(1000, '10.00');

    await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(bobToken),
      payload: { side: 'sell', shares: 100, price: '12.00' },
    });

    const moneyBefore = (await balanceOf(aliceId)) + (await balanceOf(bobId));
    const buy = await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(aliceToken),
      payload: { side: 'buy', shares: 100, price: '15.00' },
    });

    expect(buy.json().filledShares).toBe(100);
    // Executes at the resting 12, not the buyer's 15.
    expect(Number(buy.json().totalValue)).toBeCloseTo(1200, 4);
    expect((await balanceOf(aliceId)) + (await balanceOf(bobId))).toBeCloseTo(moneyBefore, 4);

    const holdings = await db
      .selectFrom('shareholdings')
      .select(['holder_user_id', 'shares'])
      .where('company_id', '=', bobCo)
      .execute();
    const total = holdings.reduce((sum, h) => sum + Number(h.shares), 0);
    // Shares only move between holders; none are created.
    expect(total).toBe(1000);
  });

  it('refuses to sell shares the holder does not own', async () => {
    await goPublic(1000, '10.00');
    const response = await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(aliceToken),
      payload: { side: 'sell', shares: 50, price: '10.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses a share purchase the buyer cannot fund', async () => {
    await goPublic(1000, '10.00');
    await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(bobToken),
      payload: { side: 'sell', shares: 1000, price: '9999.00' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(aliceToken),
      payload: { side: 'buy', shares: 1000, price: '9999.00' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('will not let a holder trade shares with themselves', async () => {
    await goPublic(1000, '10.00');
    await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(bobToken),
      payload: { side: 'sell', shares: 100, price: '10.00' },
    });

    const buy = await app.inject({
      method: 'POST',
      url: `/api/stocks/${bobCo}/orders`,
      headers: auth(bobToken),
      payload: { side: 'buy', shares: 100, price: '20.00' },
    });
    expect(buy.json().filledShares).toBe(0);
  });

  it('reports a cap table and portfolio', async () => {
    await goPublic(1000, '10.00');
    const stock = await app.inject({
      method: 'GET',
      url: `/api/stocks/${bobCo}`,
      headers: auth(bobToken),
    });
    expect(stock.json().capTable).toHaveLength(1);

    const portfolio = await app.inject({
      method: 'GET',
      url: '/api/portfolio',
      headers: auth(bobToken),
    });
    expect(portfolio.json()[0].shares).toBe('1000');
  });

  // --- bonds ---

  async function issueBond(days = 1, face = '1000.00', coupon = '0.05') {
    return app.inject({
      method: 'POST',
      url: `/api/companies/${bobCo}/bonds`,
      headers: auth(bobToken),
      payload: { faceValue: face, couponRate: coupon, days },
    });
  }

  it('issues and sells a bond, moving cash to the issuer', async () => {
    const bond = await issueBond();
    expect(bond.statusCode).toBe(201);

    const issuerBefore = await cashOf(bobCo);
    const investorBefore = await balanceOf(aliceId);

    const buy = await app.inject({
      method: 'POST',
      url: `/api/bonds/${bond.json().id}/buy`,
      headers: auth(aliceToken),
    });
    expect(buy.statusCode).toBe(204);

    expect(await cashOf(bobCo)).toBeCloseTo(issuerBefore + 1000, 4);
    expect(await balanceOf(aliceId)).toBeCloseTo(investorBefore - 1000, 4);
  });

  it('refuses to buy the same bond twice', async () => {
    const bond = await issueBond();
    await app.inject({
      method: 'POST',
      url: `/api/bonds/${bond.json().id}/buy`,
      headers: auth(aliceToken),
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/bonds/${bond.json().id}/buy`,
      headers: auth(aliceToken),
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses to redeem before maturity', async () => {
    const bond = await issueBond(30);
    await app.inject({
      method: 'POST',
      url: `/api/bonds/${bond.json().id}/buy`,
      headers: auth(aliceToken),
    });

    const redeem = await app.inject({
      method: 'POST',
      url: `/api/bonds/${bond.json().id}/redeem`,
      headers: auth(aliceToken),
    });
    expect(redeem.statusCode).toBe(409);
  });

  it('pays face value plus coupon at maturity', async () => {
    const bond = await issueBond(1, '1000.00', '0.05');
    const bondId = bond.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/bonds/${bondId}/buy`,
      headers: auth(aliceToken),
    });
    await sql`update bonds set matures_at = now() - interval '1 day'`.execute(db);

    const investorBefore = await balanceOf(aliceId);
    const redeem = await app.inject({
      method: 'POST',
      url: `/api/bonds/${bondId}/redeem`,
      headers: auth(aliceToken),
    });

    expect(redeem.json().status).toBe('repaid');
    expect(await balanceOf(aliceId)).toBeCloseTo(investorBefore + 1050, 4);
  });

  it('marks a bond defaulted rather than pushing the issuer negative', async () => {
    const bond = await issueBond(1, '1000.00', '0.05');
    const bondId = bond.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/bonds/${bondId}/buy`,
      headers: auth(aliceToken),
    });
    await sql`update bonds set matures_at = now() - interval '1 day'`.execute(db);
    // Drain the issuer so it cannot honour the bond.
    await db.updateTable('companies').set({ cash: '10' }).where('id', '=', bobCo).execute();

    const redeem = await app.inject({
      method: 'POST',
      url: `/api/bonds/${bondId}/redeem`,
      headers: auth(aliceToken),
    });

    expect(redeem.json().status).toBe('defaulted');
    expect(await cashOf(bobCo)).toBeCloseTo(10, 4);
  });

  // --- the economy tick ---

  it('records every tick so a stalled scheduler is visible', async () => {
    await runEconomyTick(db);
    const runs = await db.selectFrom('tick_runs').selectAll().execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.finished_at).not.toBeNull();
    expect(runs[0]!.error).toBeNull();
  });

  it('writes a price point for every item', async () => {
    const { repriced } = await runPriceTick(db);
    const points = await db.selectFrom('price_history').selectAll().execute();
    expect(points).toHaveLength(repriced);
    expect(repriced).toBeGreaterThan(10);
  });

  it('raises the price of a good in short supply', async () => {
    // A standing bid with no offers is pure demand.
    await db
      .insertInto('market_orders')
      .values({
        company_id: bobCo,
        item_id: itemIds['steel']!,
        side: 'buy',
        quantity: '500',
        remaining: '500',
        price: '80',
      })
      .execute();

    const before = await db
      .selectFrom('items')
      .select('market_price')
      .where('id', '=', itemIds['steel']!)
      .executeTakeFirstOrThrow();

    await runPriceTick(db);

    const after = await db
      .selectFrom('items')
      .select('market_price')
      .where('id', '=', itemIds['steel']!)
      .executeTakeFirstOrThrow();

    expect(Number(after.market_price)).toBeGreaterThan(Number(before.market_price));
  });

  it('lowers the price of a good in glut', async () => {
    await db
      .insertInto('market_orders')
      .values({
        company_id: bobCo,
        item_id: itemIds['coal']!,
        side: 'sell',
        quantity: '500',
        remaining: '500',
        price: '3',
      })
      .execute();

    const before = Number(
      (
        await db
          .selectFrom('items')
          .select('market_price')
          .where('id', '=', itemIds['coal']!)
          .executeTakeFirstOrThrow()
      ).market_price,
    );

    await runPriceTick(db);

    const after = Number(
      (
        await db
          .selectFrom('items')
          .select('market_price')
          .where('id', '=', itemIds['coal']!)
          .executeTakeFirstOrThrow()
      ).market_price,
    );

    expect(after).toBeLessThan(before);
  });

  it('keeps prices within their floor and ceiling over many ticks', async () => {
    await db
      .insertInto('market_orders')
      .values({
        company_id: bobCo,
        item_id: itemIds['steel']!,
        side: 'buy',
        quantity: '9999',
        remaining: '9999',
        price: '500',
      })
      .execute();

    for (let i = 0; i < 40; i += 1) await runPriceTick(db);

    const item = await db
      .selectFrom('items')
      .select(['market_price', 'base_price'])
      .where('id', '=', itemIds['steel']!)
      .executeTakeFirstOrThrow();

    expect(Number(item.market_price)).toBeGreaterThan(0);
    expect(Number(item.market_price)).toBeLessThanOrEqual(Number(item.base_price) * 6 + 0.01);
  });

  it('delivers finished production through the tick', async () => {
    const recipe = await db
      .selectFrom('recipes')
      .innerJoin('items', 'items.id', 'recipes.output_item_id')
      .select(['recipes.id'])
      .where('items.slug', '=', 'coal')
      .executeTakeFirstOrThrow();

    await app.inject({
      method: 'POST',
      url: `/api/companies/${bobCo}/production`,
      headers: auth(bobToken),
      payload: { recipeId: recipe.id, batches: 1 },
    });
    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);

    const result = await runEconomyTick(db);
    expect(result.runsCompleted).toBe(1);

    const stock = await db
      .selectFrom('inventory')
      .select('quantity')
      .where('company_id', '=', bobCo)
      .where('item_id', '=', itemIds['coal']!)
      .executeTakeFirstOrThrow();
    expect(Number(stock.quantity)).toBeCloseTo(12, 4);
  });

  it('does not deliver the same run twice across ticks', async () => {
    const recipe = await db
      .selectFrom('recipes')
      .innerJoin('items', 'items.id', 'recipes.output_item_id')
      .select(['recipes.id'])
      .where('items.slug', '=', 'coal')
      .executeTakeFirstOrThrow();

    await app.inject({
      method: 'POST',
      url: `/api/companies/${bobCo}/production`,
      headers: auth(bobToken),
      payload: { recipeId: recipe.id, batches: 1 },
    });
    await sql`update production_orders set completes_at = now() - interval '1 minute'`.execute(db);

    await runEconomyTick(db);
    await runEconomyTick(db);
    await runEconomyTick(db);

    const stock = await db
      .selectFrom('inventory')
      .select('quantity')
      .where('company_id', '=', bobCo)
      .where('item_id', '=', itemIds['coal']!)
      .executeTakeFirstOrThrow();
    expect(Number(stock.quantity)).toBeCloseTo(12, 4);
  });
});
