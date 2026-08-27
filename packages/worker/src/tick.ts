import { sql } from 'kysely';
import type { Db } from '@wf/db';
import { DEFAULT_PRICING, accrueInterest, nextPrice, priceIndex } from '@wf/engine';

export interface TickResult {
  itemsRepriced: number;
  runsCompleted: number;
  loansAccrued: number;
  priceIndex: number;
}

/**
 * Reads the current book for every item: units offered, units bid for, and
 * units actually traded since the last tick.
 */
async function readSignals(db: Db) {
  const book = await sql<{
    item_id: string;
    supply: string;
    demand: string;
  }>`
    select
      item_id,
      coalesce(sum(remaining) filter (where side = 'sell'), 0) as supply,
      coalesce(sum(remaining) filter (where side = 'buy'), 0) as demand
    from market_orders
    where status = 'open'
    group by item_id
  `.execute(db);

  const traded = await sql<{ item_id: string; volume: string }>`
    select item_id, coalesce(sum(quantity), 0) as volume
    from market_trades
    where created_at > now() - interval '1 hour'
    group by item_id
  `.execute(db);

  const volumes = new Map(traded.rows.map((r) => [r.item_id, Number(r.volume)]));
  return { book: book.rows, volumes };
}

/**
 * Reprices every item from supply and demand, records the point in the price
 * history, and returns the resulting index (spec 11, 42).
 */
export async function runPriceTick(db: Db): Promise<{ repriced: number; index: number }> {
  const items = await db.selectFrom('items').select(['id', 'base_price', 'market_price']).execute();
  const { book, volumes } = await readSignals(db);
  const signals = new Map(book.map((r) => [r.item_id, r]));

  const priced: Array<{ price: string; basePrice: string }> = [];

  for (const item of items) {
    const signal = signals.get(item.id);
    const next = nextPrice(
      String(item.market_price),
      String(item.base_price),
      {
        supply: Number(signal?.supply ?? 0),
        demand: Number(signal?.demand ?? 0),
        volume: volumes.get(item.id) ?? 0,
      },
      DEFAULT_PRICING,
    );

    await db
      .updateTable('items')
      .set({ market_price: sql`${next}::numeric` })
      .where('id', '=', item.id)
      .execute();

    await db
      .insertInto('price_history')
      .values({
        item_id: item.id,
        price: next,
        supply: sql`${signal?.supply ?? '0'}::numeric`,
        demand: sql`${signal?.demand ?? '0'}::numeric`,
        volume: sql`${volumes.get(item.id) ?? 0}::numeric`,
      })
      .execute();

    priced.push({ price: next, basePrice: String(item.base_price) });
  }

  return { repriced: items.length, index: priceIndex(priced) };
}

/** Delivers output for every production run that has finished, for all companies. */
export async function runProductionTick(db: Db): Promise<number> {
  const due = await db
    .selectFrom('production_orders')
    .innerJoin('recipes', 'recipes.id', 'production_orders.recipe_id')
    .select([
      'production_orders.id',
      'production_orders.company_id',
      'production_orders.batches',
      'recipes.output_item_id',
      'recipes.output_quantity',
    ])
    .where('production_orders.status', '=', 'running')
    .where(sql<boolean>`production_orders.completes_at <= now()`)
    .limit(500)
    .execute();

  for (const run of due) {
    const produced = (Number(run.output_quantity) * run.batches).toFixed(4);

    await db.transaction().execute(async (trx) => {
      // Claim the run first: if another tick already took it, do nothing, so
      // output cannot be delivered twice.
      const claimed = await trx
        .updateTable('production_orders')
        .set({ status: 'completed', collected_at: new Date() })
        .where('id', '=', run.id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (claimed.numUpdatedRows !== 1n) return;

      await trx
        .insertInto('inventory')
        .values({
          company_id: run.company_id,
          item_id: run.output_item_id,
          quantity: sql`${produced}::numeric`,
        })
        .onConflict((oc) =>
          oc.columns(['company_id', 'item_id']).doUpdateSet({
            quantity: sql`inventory.quantity + ${produced}::numeric`,
            updated_at: sql`now()`,
          }),
        )
        .execute();
    });
  }

  return due.length;
}

/** Adds a day of interest to every active loan. */
export async function runInterestTick(db: Db, days = 1): Promise<number> {
  const loans = await db
    .selectFrom('loans')
    .select(['id', 'outstanding', 'rate'])
    .where('status', '=', 'active')
    .execute();

  for (const loan of loans) {
    const interest = accrueInterest(String(loan.outstanding), String(loan.rate), days);
    if (Number(interest) <= 0) continue;

    await db
      .updateTable('loans')
      .set({ outstanding: sql`outstanding + ${interest}::numeric` })
      .where('id', '=', loan.id)
      .execute();
  }

  return loans.length;
}

/**
 * One full economy tick.
 *
 * Recorded in `tick_runs` so a stalled or failing scheduler is visible rather
 * than silently leaving the world frozen.
 */
export async function runEconomyTick(db: Db): Promise<TickResult> {
  const run = await db
    .insertInto('tick_runs')
    .values({ kind: 'economy' })
    .returning('id')
    .executeTakeFirstOrThrow();

  try {
    const runsCompleted = await runProductionTick(db);
    const { repriced, index } = await runPriceTick(db);
    const loansAccrued = await runInterestTick(db);

    const result: TickResult = {
      itemsRepriced: repriced,
      runsCompleted,
      loansAccrued,
      priceIndex: index,
    };

    await db
      .updateTable('tick_runs')
      .set({ finished_at: new Date(), details: JSON.stringify(result) })
      .where('id', '=', run.id)
      .execute();

    return result;
  } catch (error) {
    await db
      .updateTable('tick_runs')
      .set({
        finished_at: new Date(),
        error: error instanceof Error ? error.message : String(error),
      })
      .where('id', '=', run.id)
      .execute();
    throw error;
  }
}
