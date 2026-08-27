import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@wf/shared';
import { sql } from 'kysely';
import { requireAuth, requireWorldAccess } from '../auth/guards.js';
import {
  buyBond,
  fundBank,
  getCapTable,
  goPublic,
  issueBond,
  listBanks,
  listBonds,
  listLoans,
  listPublicCompanies,
  openBank,
  placeShareOrder,
  redeemBond,
  repayLoan,
  takeLoan,
} from '../finance/service.js';
import { requireCompanyOwner } from '../companies/service.js';

const uuid = z.string().uuid();
const amount = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Enter an amount like 1500.00');
const rate = z.string().regex(/^0(\.\d{1,6})?$|^1(\.0{1,6})?$/, 'Enter a rate between 0 and 1');

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'Please correct the highlighted fields',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function idParam(request: { params: unknown }, key: string): string {
  const value = (request.params as Record<string, string>)[key];
  if (!value || !uuid.safeParse(value).success) throw new ValidationError(`Invalid ${key}`);
  return value;
}

/** Banking, equity and bonds (spec 21, 23, 24). */
export async function financeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireWorldAccess);

  // --- prices ---
  app.get('/prices/:itemId', async (request) => {
    const itemId = idParam(request, 'itemId');
    return app.db
      .selectFrom('price_history')
      .select(['price', 'supply', 'demand', 'volume', 'recorded_at'])
      .where('item_id', '=', itemId)
      .orderBy('recorded_at', 'desc')
      .limit(100)
      .execute();
  });

  // --- banking ---
  app.get('/banks', async () => listBanks(app.db));

  app.post('/companies/:companyId/bank', async (request, reply) => {
    const body = parse(
      z.object({ name: z.string().min(2).max(60), depositRate: rate, loanRate: rate }),
      request.body,
    );
    const bank = await openBank(app.db, request.user!.id, idParam(request, 'companyId'), body);
    reply.code(201);
    return bank;
  });

  app.post('/banks/:bankId/fund', async (request, reply) => {
    const body = parse(z.object({ amount }), request.body);
    await fundBank(app.db, request.user!.id, idParam(request, 'bankId'), body.amount);
    reply.code(204);
    return null;
  });

  app.post('/banks/:bankId/loans', async (request, reply) => {
    const body = parse(z.object({ companyId: uuid, amount }), request.body);
    const loan = await takeLoan(
      app.db,
      request.user!.id,
      idParam(request, 'bankId'),
      body.companyId,
      body.amount,
    );
    request.log.info({ loanId: loan.id, amount: body.amount }, 'Loan issued');
    reply.code(201);
    return loan;
  });

  app.post('/loans/:loanId/repay', async (request) => {
    const body = parse(z.object({ amount }), request.body);
    return repayLoan(app.db, request.user!.id, idParam(request, 'loanId'), body.amount);
  });

  app.get('/companies/:companyId/loans', async (request) => {
    const companyId = idParam(request, 'companyId');
    await requireCompanyOwner(app.db, request.user!.id, companyId);
    return listLoans(app.db, companyId);
  });

  // --- equity ---
  app.get('/stocks', async () => listPublicCompanies(app.db));

  app.get('/stocks/:companyId', async (request) => {
    const companyId = idParam(request, 'companyId');
    const [capTable, trades, book] = await Promise.all([
      getCapTable(app.db, companyId),
      app.db
        .selectFrom('share_trades')
        .select(['id', 'shares', 'price', 'created_at'])
        .where('company_id', '=', companyId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute(),
      app.db
        .selectFrom('share_orders')
        .select(['id', 'side', 'shares', 'remaining', 'price'])
        .where('company_id', '=', companyId)
        .where('status', '=', 'open')
        .execute(),
    ]);

    return {
      capTable,
      trades,
      bids: book.filter((o) => o.side === 'buy').sort((a, b) => Number(b.price) - Number(a.price)),
      asks: book.filter((o) => o.side === 'sell').sort((a, b) => Number(a.price) - Number(b.price)),
    };
  });

  app.post('/companies/:companyId/list', async (request, reply) => {
    const body = parse(
      z.object({ shares: z.number().int().min(1).max(1_000_000_000), openingPrice: amount }),
      request.body,
    );
    const result = await goPublic(
      app.db,
      request.user!.id,
      idParam(request, 'companyId'),
      body.shares,
      body.openingPrice,
    );
    reply.code(201);
    return result;
  });

  app.post(
    '/stocks/:companyId/orders',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parse(
        z.object({
          side: z.enum(['buy', 'sell']),
          shares: z.number().int().min(1).max(1_000_000_000),
          price: amount,
        }),
        request.body,
      );
      const result = await placeShareOrder(app.db, request.user!.id, {
        companyId: idParam(request, 'companyId'),
        side: body.side,
        shares: body.shares,
        price: body.price,
      });
      reply.code(201);
      return result;
    },
  );

  app.get('/portfolio', async (request) => {
    return app.db
      .selectFrom('shareholdings')
      .innerJoin('companies', 'companies.id', 'shareholdings.company_id')
      .select([
        'shareholdings.shares',
        'companies.id as company_id',
        'companies.name',
        'companies.share_price',
        'companies.shares_outstanding',
      ])
      .where('shareholdings.holder_user_id', '=', request.user!.id)
      .where(sql<boolean>`shareholdings.shares > 0`)
      .execute();
  });

  // --- bonds ---
  app.get('/bonds', async (request) => listBonds(app.db, request.user!.id));

  app.post('/companies/:companyId/bonds', async (request, reply) => {
    const body = parse(
      z.object({ faceValue: amount, couponRate: rate, days: z.number().int().min(1).max(3650) }),
      request.body,
    );
    const bond = await issueBond(app.db, request.user!.id, idParam(request, 'companyId'), body);
    reply.code(201);
    return bond;
  });

  app.post('/bonds/:bondId/buy', async (request, reply) => {
    await buyBond(app.db, request.user!.id, idParam(request, 'bondId'));
    reply.code(204);
    return null;
  });

  app.post('/bonds/:bondId/redeem', async (request) =>
    redeemBond(app.db, request.user!.id, idParam(request, 'bondId')),
  );
}
