import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INDUSTRIES, ValidationError } from '@wf/shared';
import { requireAuth, requireWorldAccess } from '../auth/guards.js';
import {
  createCompany,
  getCompany,
  getInventory,
  listCompanies,
  listOwnedCompanies,
  moveTreasury,
  requireCompanyOwner,
} from '../companies/service.js';
import {
  cancelOrder,
  getOrderBook,
  listCompanyOrders,
  listItems,
  placeOrder,
  recentTrades,
} from '../market/service.js';
import { listProductionOrders, listRecipes, startProduction } from '../production/service.js';
import {
  applyForJob,
  createListing,
  getMyEmployment,
  listEmployees,
  listOpenJobs,
  resign,
  runPayroll,
  terminate,
} from '../employment/service.js';

const uuid = z.string().uuid();
const amount = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Enter an amount like 1500.00');

const createCompanySchema = z.object({
  name: z.string().min(2).max(60),
  industry: z.enum(INDUSTRIES as [string, ...string[]]),
  description: z.string().max(500).optional(),
  initialCapital: amount.optional(),
});

const orderSchema = z.object({
  companyId: uuid,
  itemId: uuid,
  side: z.enum(['buy', 'sell']),
  quantity: amount,
  price: amount,
});

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
  if (!value || !uuid.safeParse(value).success) {
    throw new ValidationError(`Invalid ${key}`);
  }
  return value;
}

/** Companies, production, employment and the marketplace (spec 6-13). */
export async function economyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireWorldAccess);

  // --- Catalogue ---
  app.get('/items', async () => listItems(app.db));
  app.get('/recipes', async () => listRecipes(app.db));

  // --- Companies ---
  app.get('/companies', async () => listCompanies(app.db));
  app.get('/companies/mine', async (request) => listOwnedCompanies(app.db, request.user!.id));

  app.post(
    '/companies',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parse(createCompanySchema, request.body);
      const company = await createCompany(app.db, request.user!.id, {
        name: input.name,
        industry: input.industry as (typeof INDUSTRIES)[number],
        description: input.description,
        initialCapital: input.initialCapital,
      });

      request.log.info({ userId: request.user!.id, companyId: company.id }, 'Company founded');
      reply.code(201);
      return company;
    },
  );

  app.get('/companies/:companyId', async (request) =>
    getCompany(app.db, idParam(request, 'companyId')),
  );

  app.get('/companies/:companyId/inventory', async (request) => {
    const companyId = idParam(request, 'companyId');
    await requireCompanyOwner(app.db, request.user!.id, companyId);
    return getInventory(app.db, companyId);
  });

  app.post('/companies/:companyId/treasury', async (request) => {
    const body = parse(
      z.object({ direction: z.enum(['deposit', 'withdraw']), amount }),
      request.body,
    );
    return moveTreasury(
      app.db,
      request.user!.id,
      idParam(request, 'companyId'),
      body.direction,
      body.amount,
    );
  });

  // --- Production ---
  app.get('/companies/:companyId/production', async (request) => {
    const companyId = idParam(request, 'companyId');
    await requireCompanyOwner(app.db, request.user!.id, companyId);
    return listProductionOrders(app.db, companyId);
  });

  app.post('/companies/:companyId/production', async (request, reply) => {
    const body = parse(
      z.object({ recipeId: uuid, batches: z.number().int().min(1).max(1000) }),
      request.body,
    );
    const result = await startProduction(
      app.db,
      request.user!.id,
      idParam(request, 'companyId'),
      body.recipeId,
      body.batches,
    );
    reply.code(201);
    return result;
  });

  // --- Marketplace ---
  app.get('/market/items/:itemId/book', async (request) =>
    getOrderBook(app.db, idParam(request, 'itemId')),
  );
  app.get('/market/items/:itemId/trades', async (request) =>
    recentTrades(app.db, idParam(request, 'itemId')),
  );

  app.post(
    '/market/orders',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = parse(orderSchema, request.body);
      const result = await placeOrder(app.db, request.user!.id, {
        companyId: input.companyId,
        itemId: input.itemId,
        side: input.side,
        quantity: input.quantity,
        price: input.price,
      });

      request.log.info(
        { companyId: input.companyId, side: input.side, filled: result.filledQuantity },
        'Market order placed',
      );
      reply.code(201);
      return result;
    },
  );

  app.delete('/market/orders/:orderId', async (request, reply) => {
    await cancelOrder(app.db, request.user!.id, idParam(request, 'orderId'));
    reply.code(204);
    return null;
  });

  app.get('/companies/:companyId/orders', async (request) => {
    const companyId = idParam(request, 'companyId');
    await requireCompanyOwner(app.db, request.user!.id, companyId);
    return listCompanyOrders(app.db, companyId);
  });

  // --- Employment ---
  app.get('/jobs', async () => listOpenJobs(app.db));
  app.get(
    '/jobs/mine',
    async (request) => (await getMyEmployment(app.db, request.user!.id)) ?? null,
  );

  app.post('/jobs/:listingId/apply', async (request, reply) => {
    const employment = await applyForJob(app.db, request.user!.id, idParam(request, 'listingId'));
    reply.code(201);
    return employment;
  });

  app.post('/jobs/resign', async (request, reply) => {
    await resign(app.db, request.user!.id);
    reply.code(204);
    return null;
  });

  app.post('/companies/:companyId/jobs', async (request, reply) => {
    const body = parse(
      z.object({
        title: z.string().min(2).max(60),
        salary: amount,
        positions: z.number().int().min(1).max(500),
      }),
      request.body,
    );
    const listing = await createListing(app.db, request.user!.id, idParam(request, 'companyId'), {
      title: body.title,
      salary: body.salary,
      positions: body.positions,
    });
    reply.code(201);
    return listing;
  });

  app.get('/companies/:companyId/employees', async (request) =>
    listEmployees(app.db, request.user!.id, idParam(request, 'companyId')),
  );

  app.delete('/companies/:companyId/employees/:employmentId', async (request, reply) => {
    await terminate(
      app.db,
      request.user!.id,
      idParam(request, 'companyId'),
      idParam(request, 'employmentId'),
    );
    reply.code(204);
    return null;
  });

  app.post('/companies/:companyId/payroll', async (request) => {
    const companyId = idParam(request, 'companyId');
    await requireCompanyOwner(app.db, request.user!.id, companyId);
    return runPayroll(app.db, companyId);
  });
}
