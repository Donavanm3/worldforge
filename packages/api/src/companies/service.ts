import { sql } from 'kysely';
import {
  ConflictError,
  ForbiddenError,
  type Industry,
  NotFoundError,
  ValidationError,
} from '@wf/shared';
import type { Company, Db } from '@wf/db';

/** Cost to incorporate, paid from the founder's personal balance. */
export const INCORPORATION_FEE = '500.0000';

export interface CreateCompanyInput {
  name: string;
  industry: Industry;
  description?: string | undefined;
  /** Optional starting capital moved from the founder into the treasury. */
  initialCapital?: string | undefined;
}

/**
 * Founds a company.
 *
 * The incorporation fee and any starting capital leave the founder's balance in
 * the same transaction that creates the company, so a failure cannot leave
 * money deducted with no company to show for it.
 */
export async function createCompany(
  db: Db,
  ownerId: string,
  input: CreateCompanyInput,
): Promise<Company> {
  const capital = input.initialCapital ?? '0';
  if (Number(capital) < 0) {
    throw new ValidationError('Starting capital cannot be negative');
  }

  const existing = await db
    .selectFrom('companies')
    .select('id')
    .where(sql<boolean>`lower(name) = lower(${input.name})`)
    .executeTakeFirst();
  if (existing) {
    throw new ConflictError('A company with that name already exists');
  }

  return db.transaction().execute(async (trx) => {
    // Single conditional debit: the balance check and the deduction cannot be
    // separated by a concurrent spend.
    const total = sql<string>`${INCORPORATION_FEE}::numeric + ${capital}::numeric`;
    const debit = await trx
      .updateTable('profiles')
      .set({ balance: sql`balance - (${INCORPORATION_FEE}::numeric + ${capital}::numeric)` })
      .where('user_id', '=', ownerId)
      .where(sql<boolean>`balance >= ${INCORPORATION_FEE}::numeric + ${capital}::numeric`)
      .executeTakeFirst();

    if (debit.numUpdatedRows !== 1n) {
      throw new ConflictError(
        `Insufficient funds — incorporation costs ${INCORPORATION_FEE} plus any starting capital`,
      );
    }

    const company = await trx
      .insertInto('companies')
      .values({
        name: input.name,
        owner_id: ownerId,
        industry: input.industry,
        description: input.description ?? null,
        cash: sql`${capital}::numeric`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('transactions')
      .values({
        sender_user_id: ownerId,
        receiver_user_id: null,
        amount: total,
        reason: 'company_incorporation',
        metadata: JSON.stringify({ companyId: company.id, capital }),
      })
      .execute();

    return company;
  });
}

export async function getCompany(db: Db, companyId: string) {
  const company = await db
    .selectFrom('companies')
    .innerJoin('users', 'users.id', 'companies.owner_id')
    .selectAll('companies')
    .select('users.username as owner_name')
    .where('companies.id', '=', companyId)
    .executeTakeFirst();

  if (!company) throw new NotFoundError('Company not found');
  return company;
}

/** Throws unless the user owns the company. Returns it so callers can reuse it. */
export async function requireCompanyOwner(
  db: Db,
  userId: string,
  companyId: string,
): Promise<Company> {
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('id', '=', companyId)
    .executeTakeFirst();

  if (!company) throw new NotFoundError('Company not found');
  if (company.owner_id !== userId) {
    throw new ForbiddenError('You do not own this company');
  }
  return company;
}

export async function listOwnedCompanies(db: Db, userId: string) {
  return db
    .selectFrom('companies')
    .selectAll()
    .where('owner_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
}

export async function listCompanies(db: Db, limit = 50) {
  return db
    .selectFrom('companies')
    .innerJoin('users', 'users.id', 'companies.owner_id')
    .select([
      'companies.id',
      'companies.name',
      'companies.industry',
      'companies.reputation',
      'companies.created_at',
      'users.username as owner_name',
    ])
    .orderBy('companies.created_at', 'desc')
    .limit(Math.min(limit, 200))
    .execute();
}

export async function getInventory(db: Db, companyId: string) {
  return db
    .selectFrom('inventory')
    .innerJoin('items', 'items.id', 'inventory.item_id')
    .select([
      'inventory.item_id',
      'inventory.quantity',
      'items.slug',
      'items.name',
      'items.kind',
      'items.unit',
      'items.base_price',
    ])
    .where('inventory.company_id', '=', companyId)
    .where(sql<boolean>`inventory.quantity > 0`)
    .orderBy('items.name', 'asc')
    .execute();
}

export type Treasury = 'deposit' | 'withdraw';

/**
 * Moves money between a player's balance and their company's treasury.
 *
 * Both legs are conditional updates inside one transaction, so neither side can
 * go negative and money can never be created by a concurrent transfer.
 */
export async function moveTreasury(
  db: Db,
  userId: string,
  companyId: string,
  direction: Treasury,
  amount: string,
): Promise<{ balance: string; cash: string }> {
  if (!(Number(amount) > 0)) {
    throw new ValidationError('Amount must be greater than zero');
  }
  await requireCompanyOwner(db, userId, companyId);

  return db.transaction().execute(async (trx) => {
    if (direction === 'deposit') {
      const debit = await trx
        .updateTable('profiles')
        .set({ balance: sql`balance - ${amount}::numeric` })
        .where('user_id', '=', userId)
        .where(sql<boolean>`balance >= ${amount}::numeric`)
        .executeTakeFirst();
      if (debit.numUpdatedRows !== 1n) {
        throw new ConflictError('Insufficient personal funds');
      }
      await trx
        .updateTable('companies')
        .set({ cash: sql`cash + ${amount}::numeric`, updated_at: sql`now()` })
        .where('id', '=', companyId)
        .execute();
    } else {
      const debit = await trx
        .updateTable('companies')
        .set({ cash: sql`cash - ${amount}::numeric`, updated_at: sql`now()` })
        .where('id', '=', companyId)
        .where(sql<boolean>`cash >= ${amount}::numeric`)
        .executeTakeFirst();
      if (debit.numUpdatedRows !== 1n) {
        throw new ConflictError('Insufficient company funds');
      }
      await trx
        .updateTable('profiles')
        .set({ balance: sql`balance + ${amount}::numeric` })
        .where('user_id', '=', userId)
        .execute();
    }

    await trx
      .insertInto('transactions')
      .values({
        sender_user_id: direction === 'deposit' ? userId : null,
        receiver_user_id: direction === 'deposit' ? null : userId,
        amount,
        reason: direction === 'deposit' ? 'treasury_deposit' : 'treasury_withdrawal',
        metadata: JSON.stringify({ companyId }),
      })
      .execute();

    const [profile, company] = await Promise.all([
      trx
        .selectFrom('profiles')
        .select('balance')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom('companies')
        .select('cash')
        .where('id', '=', companyId)
        .executeTakeFirstOrThrow(),
    ]);

    return { balance: String(profile.balance), cash: String(company.cash) };
  });
}
