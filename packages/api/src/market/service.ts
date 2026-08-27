import { sql, type Transaction } from 'kysely';
import { ConflictError, NotFoundError, type OrderSide, ValidationError } from '@wf/shared';
import type { Database, Db } from '@wf/db';
import { matchOrder, maxBuyCost, type BookOrder } from '@wf/engine';
import { requireCompanyOwner } from '../companies/service.js';

type Trx = Transaction<Database>;

export interface PlaceOrderInput {
  companyId: string;
  itemId: string;
  side: OrderSide;
  quantity: string;
  price: string;
}

export interface PlaceOrderResult {
  orderId: string;
  status: 'open' | 'filled';
  filledQuantity: string;
  remainingQuantity: string;
  totalValue: string;
  trades: Array<{ quantity: string; price: string }>;
}

async function adjustInventory(
  trx: Trx,
  companyId: string,
  itemId: string,
  delta: string,
): Promise<void> {
  await trx
    .insertInto('inventory')
    .values({ company_id: companyId, item_id: itemId, quantity: sql`${delta}::numeric` })
    .onConflict((oc) =>
      oc.columns(['company_id', 'item_id']).doUpdateSet({
        quantity: sql`inventory.quantity + ${delta}::numeric`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

/**
 * Removes stock, failing if the company does not hold enough.
 *
 * Written as a conditional UPDATE so the check and the decrement are one
 * statement — the same pattern used for cash, and the reason item duplication
 * is not possible under concurrency.
 */
async function takeInventory(
  trx: Trx,
  companyId: string,
  itemId: string,
  quantity: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('inventory')
    .set({ quantity: sql`quantity - ${quantity}::numeric`, updated_at: sql`now()` })
    .where('company_id', '=', companyId)
    .where('item_id', '=', itemId)
    .where(sql<boolean>`quantity >= ${quantity}::numeric`)
    .executeTakeFirst();

  return result.numUpdatedRows === 1n;
}

async function takeCash(trx: Trx, companyId: string, amount: string): Promise<boolean> {
  if (Number(amount) === 0) return true;
  const result = await trx
    .updateTable('companies')
    .set({ cash: sql`cash - ${amount}::numeric`, updated_at: sql`now()` })
    .where('id', '=', companyId)
    .where(sql<boolean>`cash >= ${amount}::numeric`)
    .executeTakeFirst();

  return result.numUpdatedRows === 1n;
}

async function giveCash(trx: Trx, companyId: string, amount: string): Promise<void> {
  if (Number(amount) === 0) return;
  await trx
    .updateTable('companies')
    .set({ cash: sql`cash + ${amount}::numeric`, updated_at: sql`now()` })
    .where('id', '=', companyId)
    .execute();
}

/**
 * Places an order and settles whatever it crosses, atomically.
 *
 * The whole operation runs in one transaction with the item's open orders
 * locked, so two orders hitting the same book cannot both consume the same
 * resting liquidity. Matching policy itself lives in @wf/engine and is pure.
 */
export async function placeOrder(
  db: Db,
  userId: string,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  if (!(Number(input.quantity) > 0)) {
    throw new ValidationError('Quantity must be greater than zero');
  }
  if (!(Number(input.price) > 0)) {
    throw new ValidationError('Price must be greater than zero');
  }

  await requireCompanyOwner(db, userId, input.companyId);

  const item = await db
    .selectFrom('items')
    .select(['id'])
    .where('id', '=', input.itemId)
    .executeTakeFirst();
  if (!item) throw new NotFoundError('Item not found');

  return db.transaction().execute(async (trx) => {
    // Lock the resting book for this item so concurrent orders serialise.
    const restingRows = await trx
      .selectFrom('market_orders')
      .select(['id', 'company_id', 'price', 'remaining', 'created_at'])
      .where('item_id', '=', input.itemId)
      .where('side', '=', input.side === 'buy' ? 'sell' : 'buy')
      .where('status', '=', 'open')
      .forUpdate()
      .execute();

    const book: BookOrder[] = restingRows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      price: String(row.price),
      remaining: String(row.remaining),
      // Selected as a Date at runtime; the column type does not narrow.
      createdAt: (row.created_at as unknown as Date).getTime(),
    }));

    const match = matchOrder(
      {
        side: input.side,
        price: input.price,
        quantity: input.quantity,
        companyId: input.companyId,
      },
      book,
    );

    // Reserve up front: a seller must hold the goods, a buyer the worst-case
    // cash (fills at the resting price, the remainder at their own limit).
    if (input.side === 'sell') {
      if (!(await takeInventory(trx, input.companyId, input.itemId, input.quantity))) {
        throw new ConflictError('Not enough stock to sell');
      }
    } else {
      const restCost = maxBuyCost(match.remainingQuantity, input.price);
      const needed = String(Number(match.totalValue) + Number(restCost));
      if (!(await takeCash(trx, input.companyId, needed))) {
        throw new ConflictError('Not enough company cash for this order');
      }
    }

    const order = await trx
      .insertInto('market_orders')
      .values({
        company_id: input.companyId,
        item_id: input.itemId,
        side: input.side,
        quantity: input.quantity,
        remaining: match.remainingQuantity,
        price: input.price,
        status: Number(match.remainingQuantity) === 0 ? 'filled' : 'open',
        closed_at: Number(match.remainingQuantity) === 0 ? new Date() : null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    for (const fill of match.fills) {
      const buyOrderId = input.side === 'buy' ? order.id : fill.orderId;
      const sellOrderId = input.side === 'buy' ? fill.orderId : order.id;
      const buyerCompanyId = input.side === 'buy' ? input.companyId : fill.companyId;
      const sellerCompanyId = input.side === 'buy' ? fill.companyId : input.companyId;

      await trx
        .updateTable('market_orders')
        .set({
          remaining: sql`remaining - ${fill.quantity}::numeric`,
          status: sql`case when remaining - ${fill.quantity}::numeric <= 0 then 'filled'::order_status else status end`,
          closed_at: sql`case when remaining - ${fill.quantity}::numeric <= 0 then now() else closed_at end`,
        })
        .where('id', '=', fill.orderId)
        .execute();

      // Goods to the buyer, cash to the seller. The counterparty's side was
      // already escrowed when their resting order was placed.
      await adjustInventory(trx, buyerCompanyId, input.itemId, fill.quantity);
      await giveCash(trx, sellerCompanyId, fill.value);

      await trx
        .insertInto('market_trades')
        .values({
          item_id: input.itemId,
          buy_order_id: buyOrderId,
          sell_order_id: sellOrderId,
          buyer_company_id: buyerCompanyId,
          seller_company_id: sellerCompanyId,
          quantity: fill.quantity,
          price: fill.price,
        })
        .execute();
    }

    // A buyer who crossed below their limit gets the difference back.
    if (input.side === 'buy' && match.fills.length > 0) {
      const reservedForFills = maxBuyCost(match.filledQuantity, input.price);
      const refund = Number(reservedForFills) - Number(match.totalValue);
      if (refund > 0) {
        await giveCash(trx, input.companyId, refund.toFixed(4));
      }
    }

    return {
      orderId: order.id,
      status: Number(match.remainingQuantity) === 0 ? 'filled' : 'open',
      filledQuantity: match.filledQuantity,
      remainingQuantity: match.remainingQuantity,
      totalValue: match.totalValue,
      trades: match.fills.map((f) => ({ quantity: f.quantity, price: f.price })),
    };
  });
}

/** Cancels an open order and returns whatever was still escrowed. */
export async function cancelOrder(db: Db, userId: string, orderId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const order = await trx
      .selectFrom('market_orders')
      .selectAll()
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();

    if (!order) throw new NotFoundError('Order not found');
    if (order.status !== 'open') {
      throw new ConflictError('Order is no longer open');
    }

    const company = await trx
      .selectFrom('companies')
      .select(['owner_id'])
      .where('id', '=', order.company_id)
      .executeTakeFirstOrThrow();
    if (company.owner_id !== userId) {
      throw new ConflictError('You do not own this order');
    }

    const remaining = String(order.remaining);
    if (order.side === 'sell') {
      await adjustInventory(trx, order.company_id, order.item_id, remaining);
    } else {
      await giveCash(trx, order.company_id, maxBuyCost(remaining, String(order.price)));
    }

    await trx
      .updateTable('market_orders')
      .set({ status: 'cancelled', closed_at: new Date() })
      .where('id', '=', orderId)
      .execute();
  });
}

export async function getOrderBook(db: Db, itemId: string) {
  const rows = await db
    .selectFrom('market_orders')
    .select(['id', 'side', 'price', 'remaining', 'created_at'])
    .where('item_id', '=', itemId)
    .where('status', '=', 'open')
    .orderBy('price', 'asc')
    .execute();

  return {
    bids: rows.filter((r) => r.side === 'buy').sort((a, b) => Number(b.price) - Number(a.price)),
    asks: rows.filter((r) => r.side === 'sell').sort((a, b) => Number(a.price) - Number(b.price)),
  };
}

export async function listItems(db: Db) {
  return db.selectFrom('items').selectAll().orderBy('tier', 'asc').orderBy('name', 'asc').execute();
}

export async function recentTrades(db: Db, itemId: string, limit = 50) {
  return db
    .selectFrom('market_trades')
    .select(['id', 'quantity', 'price', 'created_at'])
    .where('item_id', '=', itemId)
    .orderBy('created_at', 'desc')
    .limit(Math.min(limit, 200))
    .execute();
}

export async function listCompanyOrders(db: Db, companyId: string) {
  return db
    .selectFrom('market_orders')
    .innerJoin('items', 'items.id', 'market_orders.item_id')
    .select([
      'market_orders.id',
      'market_orders.side',
      'market_orders.quantity',
      'market_orders.remaining',
      'market_orders.price',
      'market_orders.status',
      'market_orders.created_at',
      'items.name as item_name',
      'items.slug as item_slug',
    ])
    .where('market_orders.company_id', '=', companyId)
    .orderBy('market_orders.created_at', 'desc')
    .limit(100)
    .execute();
}
