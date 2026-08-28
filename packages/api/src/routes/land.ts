import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LAND_ZONINGS, ValidationError, isValidAmount } from '@wf/shared';
import { requireAuth, requireWorldAccess } from '../auth/guards.js';
import {
  buyParcel,
  getParcel,
  listCities,
  listMarket,
  listOwnedParcels,
  listParcelForSale,
  listParcelsInViewport,
  setParcelZoning,
  unlistParcel,
} from '../land/service.js';

const viewportSchema = z.object({
  west: z.coerce.number(),
  south: z.coerce.number(),
  east: z.coerce.number(),
  north: z.coerce.number(),
});

const uuidSchema = z.string().uuid();
const listingSchema = z.object({ price: z.string() });
const zoningSchema = z.object({ zoning: z.enum(LAND_ZONINGS as [string, ...string[]]) });

function parcelIdOf(request: { params: unknown }): string {
  const { parcelId } = request.params as { parcelId: string };
  if (!uuidSchema.safeParse(parcelId).success) {
    throw new ValidationError('Invalid parcel id');
  }
  return parcelId;
}

export async function landRoutes(app: FastifyInstance): Promise<void> {
  // Everything about land requires an account that may enter the world.
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireWorldAccess);

  /** GET /api/land/parcels?west=&south=&east=&north= — map viewport (spec 48). */
  app.get('/land/parcels', async (request) => {
    const parsed = viewportSchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError('Viewport requires west, south, east and north');
    }
    return listParcelsInViewport(app.db, parsed.data);
  });

  /** GET /api/land/cities — where the parcels are, for the map's jump control. */
  app.get('/land/cities', async () => listCities(app.db));

  app.get('/land/market', async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = limit ? Number(limit) : 50;
    return listMarket(app.db, Number.isFinite(parsed) ? parsed : 50);
  });

  app.get('/land/mine', async (request) => listOwnedParcels(app.db, request.user!.id));

  app.get('/land/parcels/:parcelId', async (request) => getParcel(app.db, parcelIdOf(request)));

  app.post(
    '/land/parcels/:parcelId/buy',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const result = await buyParcel(app.db, request.user!.id, parcelIdOf(request));
      request.log.info(
        { userId: request.user!.id, parcelId: result.parcelId, price: result.pricePaid },
        'Land purchased',
      );
      return result;
    },
  );

  app.post('/land/parcels/:parcelId/list', async (request, reply) => {
    const parsed = listingSchema.safeParse(request.body);
    if (!parsed.success || !isValidAmount(parsed.data.price, 'WFD')) {
      throw new ValidationError('Price must be a non-negative amount like "2500.00"');
    }

    await listParcelForSale(app.db, request.user!.id, parcelIdOf(request), parsed.data.price);
    reply.code(204);
    return null;
  });

  app.delete('/land/parcels/:parcelId/list', async (request, reply) => {
    await unlistParcel(app.db, request.user!.id, parcelIdOf(request));
    reply.code(204);
    return null;
  });

  app.patch('/land/parcels/:parcelId/zoning', async (request, reply) => {
    const parsed = zoningSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Unknown zoning value');
    }

    await setParcelZoning(
      app.db,
      request.user!.id,
      parcelIdOf(request),
      parsed.data.zoning as (typeof LAND_ZONINGS)[number],
    );
    reply.code(204);
    return null;
  });
}
