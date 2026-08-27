import { sql } from 'kysely';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@wf/shared';
import type { Db } from '@wf/db';
import { requireCompanyOwner } from '../companies/service.js';

export async function createListing(
  db: Db,
  userId: string,
  companyId: string,
  input: { title: string; salary: string; positions: number },
) {
  if (!(Number(input.salary) > 0)) {
    throw new ValidationError('Salary must be greater than zero');
  }
  if (!Number.isInteger(input.positions) || input.positions < 1) {
    throw new ValidationError('Positions must be a positive whole number');
  }
  await requireCompanyOwner(db, userId, companyId);

  return db
    .insertInto('job_listings')
    .values({
      company_id: companyId,
      title: input.title,
      salary: input.salary,
      positions: input.positions,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listOpenJobs(db: Db, limit = 50) {
  return db
    .selectFrom('job_listings')
    .innerJoin('companies', 'companies.id', 'job_listings.company_id')
    .select([
      'job_listings.id',
      'job_listings.title',
      'job_listings.salary',
      'job_listings.positions',
      'job_listings.filled',
      'job_listings.created_at',
      'companies.id as company_id',
      'companies.name as company_name',
      'companies.industry',
    ])
    .where('job_listings.open', '=', true)
    .where(sql<boolean>`job_listings.filled < job_listings.positions`)
    .orderBy('job_listings.salary', 'desc')
    .limit(Math.min(limit, 200))
    .execute();
}

/**
 * Accepts a job.
 *
 * The seat count is claimed with a conditional UPDATE, so two players applying
 * for the last position cannot both be hired. A partial unique index enforces
 * one active job per player (spec 8).
 */
export async function applyForJob(db: Db, userId: string, listingId: string) {
  return db.transaction().execute(async (trx) => {
    const listing = await trx
      .selectFrom('job_listings')
      .selectAll()
      .where('id', '=', listingId)
      .executeTakeFirst();
    if (!listing) throw new NotFoundError('Job listing not found');

    const company = await trx
      .selectFrom('companies')
      .select(['owner_id'])
      .where('id', '=', listing.company_id)
      .executeTakeFirstOrThrow();
    if (company.owner_id === userId) {
      throw new ConflictError('You cannot employ yourself at your own company');
    }

    const existing = await trx
      .selectFrom('employments')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (existing) {
      throw new ConflictError('You already have a job — resign before taking another');
    }

    const claimed = await trx
      .updateTable('job_listings')
      .set({ filled: sql`filled + 1` })
      .where('id', '=', listingId)
      .where('open', '=', true)
      .where(sql<boolean>`filled < positions`)
      .executeTakeFirst();

    if (claimed.numUpdatedRows !== 1n) {
      throw new ConflictError('That position has already been filled');
    }

    const employment = await trx
      .insertInto('employments')
      .values({
        user_id: userId,
        company_id: listing.company_id,
        listing_id: listing.id,
        title: listing.title,
        salary: listing.salary,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return employment;
  });
}

async function endEmployment(
  db: Db,
  employmentId: string,
  status: 'resigned' | 'terminated',
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const employment = await trx
      .updateTable('employments')
      .set({ status, ended_at: new Date() })
      .where('id', '=', employmentId)
      .where('status', '=', 'active')
      .returning(['listing_id'])
      .executeTakeFirst();

    if (!employment) throw new ConflictError('That employment is not active');

    if (employment.listing_id) {
      // Free the seat so the company can hire a replacement.
      await trx
        .updateTable('job_listings')
        .set({ filled: sql`greatest(filled - 1, 0)` })
        .where('id', '=', employment.listing_id)
        .execute();
    }
  });
}

export async function resign(db: Db, userId: string): Promise<void> {
  const employment = await db
    .selectFrom('employments')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (!employment) throw new ConflictError('You do not currently have a job');
  await endEmployment(db, employment.id, 'resigned');
}

export async function terminate(
  db: Db,
  userId: string,
  companyId: string,
  employmentId: string,
): Promise<void> {
  await requireCompanyOwner(db, userId, companyId);

  const employment = await db
    .selectFrom('employments')
    .select(['id', 'company_id'])
    .where('id', '=', employmentId)
    .executeTakeFirst();

  if (!employment) throw new NotFoundError('Employment not found');
  if (employment.company_id !== companyId) {
    throw new ForbiddenError('That employee does not work for this company');
  }

  await endEmployment(db, employmentId, 'terminated');
}

export async function getMyEmployment(db: Db, userId: string) {
  return db
    .selectFrom('employments')
    .innerJoin('companies', 'companies.id', 'employments.company_id')
    .select([
      'employments.id',
      'employments.title',
      'employments.salary',
      'employments.started_at',
      'companies.id as company_id',
      'companies.name as company_name',
      'companies.industry',
    ])
    .where('employments.user_id', '=', userId)
    .where('employments.status', '=', 'active')
    .executeTakeFirst();
}

export async function listEmployees(db: Db, userId: string, companyId: string) {
  await requireCompanyOwner(db, userId, companyId);

  return db
    .selectFrom('employments')
    .innerJoin('users', 'users.id', 'employments.user_id')
    .select([
      'employments.id',
      'employments.title',
      'employments.salary',
      'employments.started_at',
      'users.username',
    ])
    .where('employments.company_id', '=', companyId)
    .where('employments.status', '=', 'active')
    .orderBy('employments.started_at', 'asc')
    .execute();
}

/**
 * Pays one salary cycle for every active employee.
 *
 * Each payment is its own conditional debit, so a company that runs out of cash
 * mid-payroll pays who it can and the rest are reported unpaid rather than the
 * treasury going negative or the whole run rolling back.
 */
export async function runPayroll(
  db: Db,
  companyId: string,
): Promise<{ paid: number; unpaid: number; total: string }> {
  const employees = await db
    .selectFrom('employments')
    .select(['id', 'user_id', 'salary'])
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .execute();

  let paid = 0;
  let unpaid = 0;
  let total = 0;

  for (const employee of employees) {
    const salary = String(employee.salary);
    const settled = await db.transaction().execute(async (trx) => {
      const debit = await trx
        .updateTable('companies')
        .set({ cash: sql`cash - ${salary}::numeric`, updated_at: sql`now()` })
        .where('id', '=', companyId)
        .where(sql<boolean>`cash >= ${salary}::numeric`)
        .executeTakeFirst();

      if (debit.numUpdatedRows !== 1n) return false;

      await trx
        .updateTable('profiles')
        .set({ balance: sql`balance + ${salary}::numeric` })
        .where('user_id', '=', employee.user_id)
        .execute();

      await trx
        .insertInto('transactions')
        .values({
          sender_user_id: null,
          receiver_user_id: employee.user_id,
          amount: salary,
          reason: 'salary',
          metadata: JSON.stringify({ companyId, employmentId: employee.id }),
        })
        .execute();

      return true;
    });

    if (settled) {
      paid += 1;
      total += Number(salary);
    } else {
      unpaid += 1;
    }
  }

  return { paid, unpaid, total: total.toFixed(4) };
}
