import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUILDING_TYPES, ValidationError, isValidAmount } from '@wf/shared';
import { requireAuth, requireWorldAccess } from '../auth/guards.js';
import {
  buyDeed,
  buyUnit,
  getBuilding,
  listBuildingsWithUnitsForSale,
  listDeed,
  listDeedsForSale,
  listMyBuildings,
  listMyUnits,
  listUnit,
  quoteBuilding,
  startConstruction,
  unlistDeed,
  unlistUnit,
} from '../buildings/service.js';

const uuidSchema = z.string().uuid();

const planSchema = z.object({
  footprintSqm: z.number().positive().max(200_000),
  floors: z.number().int().min(1).max(120),
  type: z.enum(BUILDING_TYPES as [string, ...string[]]),
});

const buildSchema = planSchema.extend({ name: z.string().min(2).max(80) });
const listingSchema = z.object({ price: z.string() });

function idOf(request: { params: unknown }, key: string): string {
  const params = request.params as Record<string, string>;
  const value = params[key];
  if (!value || !uuidSchema.safeParse(value).success) {
    throw new ValidationError(`Invalid ${key}`);
  }
  return value;
}

export async function buildingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireWorldAccess);

  /** POST /api/land/parcels/:parcelId/quote — price a building before committing. */
  app.post('/land/parcels/:parcelId/quote', async (request) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('A quote needs a footprint, a floor count and a building type');
    }
    return quoteBuilding(app.db, request.user!.id, idOf(request, 'parcelId'), parsed.data as never);
  });

  /** POST /api/land/parcels/:parcelId/build — break ground (spec 14). */
  app.post('/land/parcels/:parcelId/build', async (request, reply) => {
    const parsed = buildSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        'Construction needs a name, a footprint, a floor count and a building type',
      );
    }
    const result = await startConstruction(
      app.db,
      request.user!.id,
      idOf(request, 'parcelId'),
      parsed.data as never,
    );
    return reply.code(201).send(result);
  });

  app.get('/buildings/mine', async (request) => listMyBuildings(app.db, request.user!.id));

  /** Buildings with units on the open market. */
  app.get('/buildings/market', async () => listBuildingsWithUnitsForSale(app.db));

  /** Deeds on the market — whole buildings, NPC landlords included. */
  app.get('/buildings/deeds', async () => listDeedsForSale(app.db));

  app.post('/buildings/:buildingId/list', async (request, reply) => {
    const parsed = listingSchema.safeParse(request.body);
    if (!parsed.success || !isValidAmount(parsed.data.price, 'WFD')) {
      throw new ValidationError('A listing needs a valid price');
    }
    await listDeed(app.db, request.user!.id, idOf(request, 'buildingId'), parsed.data.price);
    return reply.code(204).send();
  });

  app.delete('/buildings/:buildingId/list', async (request, reply) => {
    await unlistDeed(app.db, request.user!.id, idOf(request, 'buildingId'));
    return reply.code(204).send();
  });

  app.post('/buildings/:buildingId/buy', async (request) =>
    buyDeed(app.db, request.user!.id, idOf(request, 'buildingId')),
  );

  app.get('/buildings/:buildingId', async (request) =>
    getBuilding(app.db, idOf(request, 'buildingId')),
  );

  app.get('/units/mine', async (request) => listMyUnits(app.db, request.user!.id));

  app.post('/units/:unitId/list', async (request, reply) => {
    const parsed = listingSchema.safeParse(request.body);
    if (!parsed.success || !isValidAmount(parsed.data.price, 'WFD')) {
      throw new ValidationError('A listing needs a valid price');
    }
    await listUnit(app.db, request.user!.id, idOf(request, 'unitId'), parsed.data.price);
    return reply.code(204).send();
  });

  app.delete('/units/:unitId/list', async (request, reply) => {
    await unlistUnit(app.db, request.user!.id, idOf(request, 'unitId'));
    return reply.code(204).send();
  });

  app.post('/units/:unitId/buy', async (request) =>
    buyUnit(app.db, request.user!.id, idOf(request, 'unitId')),
  );
}
