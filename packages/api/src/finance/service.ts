import { sql, type Transaction } from 'kysely';
import { ConflictError, NotFoundError, ValidationError } from '@wf/shared';
import type { Database, Db } from '@wf/db';
import { requireCompanyOwner } from '../companies/service.js';

type Trx = Transaction<Database>;

// --- Banking ---------------------------------------------------------------

/** A bank must hold real reserves; it cannot lend money it does not have. */
export async function openBank(
  db: Db,
  userId: string,
  companyId: string,
  input: { name: string; depositRate: string; loanRate: string },
) {
  await requireCompanyOwner(db, userId, companyId);

  if (Number(input.loanRate) < Number(input.depositRate)) {
    throw new ValidationError('Loan rate must be at least the deposit rate');
  }

  const existing = await db
    .selectFrom('banks')
    .select('id')
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (existing) throw new ConflictError('This company already operates a bank');

  return db
    .insertInto('banks')
    .values({
      company_id: companyId,
      name: input.name,
      deposit_rate: sql`${input.depositRate}::numeric`,
      loan_rate: sql`${input.loanRate}::numeric`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listBanks(db: Db) {
  return db
    .selectFrom('banks')
    .innerJoin('companies', 'companies.id', 'banks.company_id')
    .select([
      'banks.id',
      'banks.name',
      'banks.deposit_rate',
      'banks.loan_rate',
      'banks.reserves',
      'companies.id as company_id',
      'companies.name as company_name',
    ])
    .orderBy('banks.loan_rate', 'asc')
    .execute();
}

/** Moves capital from the bank's own company treasury into its reserves. */
export async function fundBank(
  db: Db,
  userId: string,
  bankId: string,
  amount: string,
): Promise<void> {
  if (!(Number(amount) > 0)) throw new ValidationError('Amount must be greater than zero');

  const bank = await db
    .selectFrom('banks')
    .select(['id', 'company_id'])
    .where('id', '=', bankId)
    .executeTakeFirst();
  if (!bank) throw new NotFoundError('Bank not found');
  await requireCompanyOwner(db, userId, bank.company_id);

  await db.transaction().execute(async (trx) => {
    const debit = await trx
      .updateTable('companies')
      .set({ cash: sql`cash - ${amount}::numeric`, updated_at: sql`now()` })
      .where('id', '=', bank.company_id)
      .where(sql<boolean>`cash >= ${amount}::numeric`)
      .executeTakeFirst();
    if (debit.numUpdatedRows !== 1n) throw new ConflictError('Insufficient company cash');

    await trx
      .updateTable('banks')
      .set({ reserves: sql`reserves + ${amount}::numeric` })
      .where('id', '=', bankId)
      .execute();
  });
}

/**
 * Issues a loan.
 *
 * Reserves are debited and the borrower credited in one transaction, so the
 * money that appears in the borrower's treasury always came out of a real
 * balance somewhere — lending never creates currency.
 */
export async function takeLoan(
  db: Db,
  userId: string,
  bankId: string,
  borrowerCompanyId: string,
  amount: string,
) {
  if (!(Number(amount) > 0)) throw new ValidationError('Amount must be greater than zero');
  await requireCompanyOwner(db, userId, borrowerCompanyId);

  const bank = await db.selectFrom('banks').selectAll().where('id', '=', bankId).executeTakeFirst();
  if (!bank) throw new NotFoundError('Bank not found');
  if (bank.company_id === borrowerCompanyId) {
    throw new ConflictError('A bank cannot lend to itself');
  }

  return db.transaction().execute(async (trx) => {
    const drawn = await trx
      .updateTable('banks')
      .set({ reserves: sql`reserves - ${amount}::numeric` })
      .where('id', '=', bankId)
      .where(sql<boolean>`reserves >= ${amount}::numeric`)
      .executeTakeFirst();
    if (drawn.numUpdatedRows !== 1n) {
      throw new ConflictError('The bank does not have enough reserves to lend that');
    }

    await trx
      .updateTable('companies')
      .set({ cash: sql`cash + ${amount}::numeric`, updated_at: sql`now()` })
      .where('id', '=', borrowerCompanyId)
      .execute();

    const loan = await trx
      .insertInto('loans')
      .values({
        bank_id: bankId,
        borrower_company_id: borrowerCompanyId,
        principal: amount,
        outstanding: amount,
        rate: String(bank.loan_rate),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return loan;
  });
}

/** Repays part or all of a loan, returning the money to the bank's reserves. */
export async function repayLoan(
  db: Db,
  userId: string,
  loanId: string,
  amount: string,
): Promise<{ outstanding: string }> {
  if (!(Number(amount) > 0)) throw new ValidationError('Amount must be greater than zero');

  const loan = await db.selectFrom('loans').selectAll().where('id', '=', loanId).executeTakeFirst();
  if (!loan) throw new NotFoundError('Loan not found');
  if (loan.status !== 'active') throw new ConflictError('That loan is already closed');
  await requireCompanyOwner(db, userId, loan.borrower_company_id);

  // Never take more than is owed.
  const payment = Math.min(Number(amount), Number(loan.outstanding)).toFixed(4);

  return db.transaction().execute(async (trx) => {
    const debit = await trx
      .updateTable('companies')
      .set({ cash: sql`cash - ${payment}::numeric`, updated_at: sql`now()` })
      .where('id', '=', loan.borrower_company_id)
      .where(sql<boolean>`cash >= ${payment}::numeric`)
      .executeTakeFirst();
    if (debit.numUpdatedRows !== 1n) throw new ConflictError('Insufficient company cash');

    await trx
      .updateTable('banks')
      .set({ reserves: sql`reserves + ${payment}::numeric` })
      .where('id', '=', loan.bank_id)
      .execute();

    const updated = await trx
      .updateTable('loans')
      .set({
        outstanding: sql`outstanding - ${payment}::numeric`,
        status: sql`case when outstanding - ${payment}::numeric <= 0 then 'repaid'::loan_status else status end`,
        closed_at: sql`case when outstanding - ${payment}::numeric <= 0 then now() else closed_at end`,
      })
      .where('id', '=', loanId)
      .returning(['outstanding'])
      .executeTakeFirstOrThrow();

    return { outstanding: String(updated.outstanding) };
  });
}

export async function listLoans(db: Db, companyId: string) {
  return db
    .selectFrom('loans')
    .innerJoin('banks', 'banks.id', 'loans.bank_id')
    .select([
      'loans.id',
      'loans.principal',
      'loans.outstanding',
      'loans.rate',
      'loans.status',
      'loans.opened_at',
      'banks.name as bank_name',
    ])
    .where('loans.borrower_company_id', '=', companyId)
    .orderBy('loans.opened_at', 'desc')
    .execute();
}

// --- Equity ----------------------------------------------------------------

async function adjustShares(
  trx: Trx,
  companyId: string,
  userId: string,
  delta: number,
): Promise<void> {
  await trx
    .insertInto('shareholdings')
    .values({ company_id: companyId, holder_user_id: userId, shares: delta })
    .onConflict((oc) =>
      oc.columns(['company_id', 'holder_user_id']).doUpdateSet({
        shares: sql`shareholdings.shares + ${delta}`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

/**
 * Takes a company public, allocating all shares to the founder.
 *
 * Ownership only ever moves between holders after this, so the sum of
 * shareholdings always equals shares_outstanding.
 */
export async function goPublic(
  db: Db,
  userId: string,
  companyId: string,
  shares: number,
  openingPrice: string,
) {
  if (!Number.isInteger(shares) || shares < 1) {
    throw new ValidationError('Share count must be a positive whole number');
  }
  if (!(Number(openingPrice) > 0)) {
    throw new ValidationError('Opening price must be greater than zero');
  }

  const company = await requireCompanyOwner(db, userId, companyId);
  if (company.listing_status === 'listed') {
    throw new ConflictError('This company is already listed');
  }

  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable('companies')
      .set({
        listing_status: 'listed',
        shares_outstanding: shares,
        share_price: openingPrice,
        updated_at: sql`now()`,
      })
      .where('id', '=', companyId)
      .execute();

    await adjustShares(trx, companyId, userId, shares);

    return { companyId, shares, openingPrice };
  });
}

export interface ShareTradeResult {
  orderId: string;
  filledShares: number;
  remainingShares: number;
  totalValue: string;
}

/**
 * Places a share order and settles what it crosses.
 *
 * Same escrow discipline as the commodity market: a seller's shares and a
 * buyer's cash are both taken up front, so an order can never settle against
 * assets that are no longer there.
 */
export async function placeShareOrder(
  db: Db,
  userId: string,
  input: { companyId: string; side: 'buy' | 'sell'; shares: number; price: string },
): Promise<ShareTradeResult> {
  if (!Number.isInteger(input.shares) || input.shares < 1) {
    throw new ValidationError('Share count must be a positive whole number');
  }
  if (!(Number(input.price) > 0)) {
    throw new ValidationError('Price must be greater than zero');
  }

  const company = await db
    .selectFrom('companies')
    .select(['id', 'listing_status'])
    .where('id', '=', input.companyId)
    .executeTakeFirst();
  if (!company) throw new NotFoundError('Company not found');
  if (company.listing_status !== 'listed') {
    throw new ConflictError('That company is not publicly traded');
  }

  return db.transaction().execute(async (trx) => {
    const resting = await trx
      .selectFrom('share_orders')
      .selectAll()
      .where('company_id', '=', input.companyId)
      .where('side', '=', input.side === 'buy' ? 'sell' : 'buy')
      .where('status', '=', 'open')
      .forUpdate()
      .execute();

    // Best counterparty first: cheapest asks, highest bids, oldest breaking ties.
    const book = resting
      .filter((order) => order.user_id !== userId)
      .filter((order) =>
        input.side === 'buy'
          ? Number(order.price) <= Number(input.price)
          : Number(order.price) >= Number(input.price),
      )
      .sort((a, b) => {
        const diff =
          input.side === 'buy'
            ? Number(a.price) - Number(b.price)
            : Number(b.price) - Number(a.price);
        if (diff !== 0) return diff;
        return (
          new Date(a.created_at as unknown as Date).getTime() -
          new Date(b.created_at as unknown as Date).getTime()
        );
      });

    let unfilled = input.shares;
    let totalValue = 0;
    const fills: Array<{ order: (typeof resting)[number]; shares: number; value: number }> = [];

    for (const order of book) {
      if (unfilled <= 0) break;
      const available = Number(order.remaining);
      if (available <= 0) continue;
      const shares = Math.min(available, unfilled);
      // Execution at the resting price, as on the commodity market.
      const value = shares * Number(order.price);
      fills.push({ order, shares, value });
      unfilled -= shares;
      totalValue += value;
    }

    if (input.side === 'sell') {
      const sold = await trx
        .updateTable('shareholdings')
        .set({ shares: sql`shares - ${input.shares}`, updated_at: sql`now()` })
        .where('company_id', '=', input.companyId)
        .where('holder_user_id', '=', userId)
        .where(sql<boolean>`shares >= ${input.shares}`)
        .executeTakeFirst();
      if (sold.numUpdatedRows !== 1n) throw new ConflictError('You do not hold that many shares');
    } else {
      // Exact reservation: fills at their real value, remainder at the limit.
      const needed = (totalValue + unfilled * Number(input.price)).toFixed(4);
      const debit = await trx
        .updateTable('profiles')
        .set({ balance: sql`balance - ${needed}::numeric` })
        .where('user_id', '=', userId)
        .where(sql<boolean>`balance >= ${needed}::numeric`)
        .executeTakeFirst();
      if (debit.numUpdatedRows !== 1n) throw new ConflictError('Insufficient personal funds');
    }

    const order = await trx
      .insertInto('share_orders')
      .values({
        company_id: input.companyId,
        user_id: userId,
        side: input.side,
        shares: input.shares,
        remaining: unfilled,
        price: input.price,
        status: unfilled === 0 ? 'filled' : 'open',
        closed_at: unfilled === 0 ? new Date() : null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    for (const fill of fills) {
      const buyerId = input.side === 'buy' ? userId : fill.order.user_id;
      const sellerId = input.side === 'buy' ? fill.order.user_id : userId;

      await trx
        .updateTable('share_orders')
        .set({
          remaining: sql`remaining - ${fill.shares}`,
          status: sql`case when remaining - ${fill.shares} <= 0 then 'filled'::order_status else status end`,
          closed_at: sql`case when remaining - ${fill.shares} <= 0 then now() else closed_at end`,
        })
        .where('id', '=', fill.order.id)
        .execute();

      await adjustShares(trx, input.companyId, buyerId, fill.shares);

      await trx
        .updateTable('profiles')
        .set({ balance: sql`balance + ${fill.value.toFixed(4)}::numeric` })
        .where('user_id', '=', sellerId)
        .execute();

      await trx
        .insertInto('share_trades')
        .values({
          company_id: input.companyId,
          buyer_user_id: buyerId,
          seller_user_id: sellerId,
          shares: fill.shares,
          price: String(fill.order.price),
        })
        .execute();

      await trx
        .updateTable('companies')
        .set({ share_price: String(fill.order.price), updated_at: sql`now()` })
        .where('id', '=', input.companyId)
        .execute();
    }

    return {
      orderId: order.id,
      filledShares: input.shares - unfilled,
      remainingShares: unfilled,
      totalValue: totalValue.toFixed(4),
    };
  });
}

export async function getCapTable(db: Db, companyId: string) {
  return db
    .selectFrom('shareholdings')
    .innerJoin('users', 'users.id', 'shareholdings.holder_user_id')
    .select(['shareholdings.shares', 'users.username', 'users.id as user_id'])
    .where('shareholdings.company_id', '=', companyId)
    .where(sql<boolean>`shareholdings.shares > 0`)
    .orderBy('shareholdings.shares', 'desc')
    .execute();
}

export async function listPublicCompanies(db: Db) {
  return db
    .selectFrom('companies')
    .select([
      'id',
      'name',
      'industry',
      'share_price',
      'shares_outstanding',
      sql<string>`coalesce(share_price, 0) * shares_outstanding`.as('market_cap'),
    ])
    .where('listing_status', '=', 'listed')
    .orderBy('market_cap', 'desc')
    .execute();
}

// --- Bonds -----------------------------------------------------------------

/** Issues a bond for sale. Nothing moves until an investor buys it. */
export async function issueBond(
  db: Db,
  userId: string,
  companyId: string,
  input: { faceValue: string; couponRate: string; days: number },
) {
  await requireCompanyOwner(db, userId, companyId);
  if (!(Number(input.faceValue) > 0)) {
    throw new ValidationError('Face value must be greater than zero');
  }
  if (!(input.days > 0)) throw new ValidationError('Maturity must be in the future');

  return db
    .insertInto('bonds')
    .values({
      issuer_company_id: companyId,
      face_value: input.faceValue,
      coupon_rate: input.couponRate,
      matures_at: new Date(Date.now() + input.days * 86_400_000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** An investor buys a bond: cash to the issuer, the claim to the holder. */
export async function buyBond(db: Db, userId: string, bondId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const bond = await trx
      .selectFrom('bonds')
      .selectAll()
      .where('id', '=', bondId)
      .forUpdate()
      .executeTakeFirst();

    if (!bond) throw new NotFoundError('Bond not found');
    if (bond.status !== 'open') throw new ConflictError('That bond is no longer available');

    const price = String(bond.face_value);
    const debit = await trx
      .updateTable('profiles')
      .set({ balance: sql`balance - ${price}::numeric` })
      .where('user_id', '=', userId)
      .where(sql<boolean>`balance >= ${price}::numeric`)
      .executeTakeFirst();
    if (debit.numUpdatedRows !== 1n) throw new ConflictError('Insufficient personal funds');

    await trx
      .updateTable('companies')
      .set({ cash: sql`cash + ${price}::numeric`, updated_at: sql`now()` })
      .where('id', '=', bond.issuer_company_id)
      .execute();

    await trx
      .updateTable('bonds')
      .set({ status: 'active', holder_user_id: userId, purchased_at: new Date() })
      .where('id', '=', bondId)
      .execute();
  });
}

/**
 * Redeems a matured bond: face value plus coupon, paid by the issuer.
 *
 * An issuer that cannot pay is marked defaulted rather than being allowed to
 * push its treasury negative.
 */
export async function redeemBond(
  db: Db,
  userId: string,
  bondId: string,
): Promise<{ status: 'repaid' | 'defaulted'; amount: string }> {
  return db.transaction().execute(async (trx) => {
    const bond = await trx
      .selectFrom('bonds')
      .selectAll()
      .where('id', '=', bondId)
      .forUpdate()
      .executeTakeFirst();

    if (!bond) throw new NotFoundError('Bond not found');
    if (bond.holder_user_id !== userId) throw new ConflictError('You do not hold this bond');
    if (bond.status !== 'active') throw new ConflictError('That bond is not redeemable');
    if (new Date(bond.matures_at as unknown as Date).getTime() > Date.now()) {
      throw new ConflictError('That bond has not matured yet');
    }

    const payout = (Number(bond.face_value) * (1 + Number(bond.coupon_rate))).toFixed(4);

    const paid = await trx
      .updateTable('companies')
      .set({ cash: sql`cash - ${payout}::numeric`, updated_at: sql`now()` })
      .where('id', '=', bond.issuer_company_id)
      .where(sql<boolean>`cash >= ${payout}::numeric`)
      .executeTakeFirst();

    if (paid.numUpdatedRows !== 1n) {
      await trx
        .updateTable('bonds')
        .set({ status: 'defaulted' })
        .where('id', '=', bondId)
        .execute();
      return { status: 'defaulted' as const, amount: '0.0000' };
    }

    await trx
      .updateTable('profiles')
      .set({ balance: sql`balance + ${payout}::numeric` })
      .where('user_id', '=', userId)
      .execute();

    await trx.updateTable('bonds').set({ status: 'matured' }).where('id', '=', bondId).execute();
    return { status: 'repaid' as const, amount: payout };
  });
}

export async function listBonds(db: Db, userId?: string) {
  let query = db
    .selectFrom('bonds')
    .innerJoin('companies', 'companies.id', 'bonds.issuer_company_id')
    .select([
      'bonds.id',
      'bonds.face_value',
      'bonds.coupon_rate',
      'bonds.matures_at',
      'bonds.status',
      'bonds.holder_user_id',
      'companies.name as issuer_name',
    ])
    .orderBy('bonds.created_at', 'desc')
    .limit(100);

  if (userId) {
    query = query.where((eb) =>
      eb.or([eb('bonds.status', '=', 'open'), eb('bonds.holder_user_id', '=', userId)]),
    );
  }
  return query.execute();
}
