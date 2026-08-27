import { sql } from 'kysely';
import {
  type BoundingBox,
  ConflictError,
  ForbiddenError,
  type LandZoning,
  NotFoundError,
  ValidationError,
} from '@wf/shared';
import type { Db } from '@wf/db';

export interface ParcelFeature {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: {
    id: string;
    ownerId: string | null;
    ownerName: string | null;
    zoning: LandZoning;
    areaSqm: string;
    marketValue: string;
    forSale: boolean;
    salePrice: string | null;
    hasPower: boolean;
    hasWater: boolean;
    hasInternet: boolean;
    hasRoad: boolean;
    cityName: string | null;
  };
}

export interface ParcelCollection {
  type: 'FeatureCollection';
  features: ParcelFeature[];
  /** True when results were capped, so the client can ask the user to zoom in. */
  truncated: boolean;
}

/** Largest viewport we will serve parcels for, in square degrees. */
const MAX_VIEWPORT_AREA = 4;
const MAX_FEATURES = 500;

export function assertViewport(bbox: BoundingBox): void {
  const { west, south, east, north } = bbox;

  if (
    ![west, south, east, north].every(Number.isFinite) ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180
  ) {
    throw new ValidationError('Viewport is outside valid coordinate bounds');
  }
  if (south >= north || west >= east) {
    throw new ValidationError('Viewport bounds are inverted');
  }
  // Refusing an oversized viewport is what stops a client from asking for every
  // parcel on Earth in one request.
  if ((east - west) * (north - south) > MAX_VIEWPORT_AREA) {
    throw new ValidationError('Viewport is too large — zoom in to load parcels');
  }
}

/**
 * Parcels intersecting a viewport, as GeoJSON.
 *
 * `&&` uses the GiST index on boundary; ST_Intersects then filters exactly.
 */
export async function listParcelsInViewport(db: Db, bbox: BoundingBox): Promise<ParcelCollection> {
  assertViewport(bbox);

  const envelope = sql`ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)`;

  const rows = await db
    .selectFrom('land_parcels')
    .leftJoin('users', 'users.id', 'land_parcels.owner_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .select([
      'land_parcels.id',
      'land_parcels.owner_id',
      'land_parcels.zoning',
      'land_parcels.area_sqm',
      'land_parcels.market_value',
      'land_parcels.for_sale',
      'land_parcels.sale_price',
      'land_parcels.has_power',
      'land_parcels.has_water',
      'land_parcels.has_internet',
      'land_parcels.has_road',
      'users.username as owner_name',
      'cities.name as city_name',
    ])
    .select(sql<string>`ST_AsGeoJSON(land_parcels.boundary)`.as('geometry'))
    .where(sql<boolean>`land_parcels.boundary && ${envelope}`)
    .where(sql<boolean>`ST_Intersects(land_parcels.boundary, ${envelope})`)
    .limit(MAX_FEATURES + 1)
    .execute();

  const truncated = rows.length > MAX_FEATURES;
  const visible = truncated ? rows.slice(0, MAX_FEATURES) : rows;

  return {
    type: 'FeatureCollection',
    truncated,
    features: visible.map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: JSON.parse(row.geometry),
      properties: {
        id: row.id,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        zoning: row.zoning,
        areaSqm: row.area_sqm,
        marketValue: row.market_value,
        forSale: row.for_sale,
        salePrice: row.sale_price,
        hasPower: row.has_power,
        hasWater: row.has_water,
        hasInternet: row.has_internet,
        hasRoad: row.has_road,
        cityName: row.city_name,
      },
    })),
  };
}

export async function getParcel(db: Db, parcelId: string) {
  const parcel = await db
    .selectFrom('land_parcels')
    .leftJoin('users', 'users.id', 'land_parcels.owner_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .selectAll('land_parcels')
    .select(['users.username as owner_name', 'cities.name as city_name'])
    .select(sql<string>`ST_AsGeoJSON(land_parcels.boundary)`.as('geometry'))
    .select(sql<string>`ST_AsGeoJSON(land_parcels.centroid)`.as('centroid_geometry'))
    .where('land_parcels.id', '=', parcelId)
    .executeTakeFirst();

  if (!parcel) {
    throw new NotFoundError('Parcel not found');
  }
  return parcel;
}

export async function listOwnedParcels(db: Db, userId: string) {
  return db
    .selectFrom('land_parcels')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .select([
      'land_parcels.id',
      'land_parcels.zoning',
      'land_parcels.area_sqm',
      'land_parcels.market_value',
      'land_parcels.for_sale',
      'land_parcels.sale_price',
      'cities.name as city_name',
    ])
    .select(sql<string>`ST_AsGeoJSON(land_parcels.centroid)`.as('centroid'))
    .where('land_parcels.owner_id', '=', userId)
    .orderBy('land_parcels.market_value', 'desc')
    .execute();
}

export interface PurchaseResult {
  parcelId: string;
  pricePaid: string;
  newBalance: string;
  sellerId: string | null;
}

/**
 * Buys a parcel, moving money and ownership atomically.
 *
 * The safety properties that matter:
 *  - the parcel row is locked FOR UPDATE, so two buyers cannot both win;
 *  - the debit is a single conditional UPDATE (`balance >= price`), so the
 *    check and the deduction cannot be separated by a concurrent spend;
 *  - the seller is credited and a ledger row written in the same transaction.
 *
 * All arithmetic happens in PostgreSQL `numeric`, never in JavaScript floats.
 */
export async function buyParcel(
  db: Db,
  buyerId: string,
  parcelId: string,
): Promise<PurchaseResult> {
  return db.transaction().execute(async (trx) => {
    const parcel = await trx
      .selectFrom('land_parcels')
      .select(['id', 'owner_id', 'for_sale', 'sale_price'])
      .where('id', '=', parcelId)
      .forUpdate()
      .executeTakeFirst();

    if (!parcel) {
      throw new NotFoundError('Parcel not found');
    }
    if (!parcel.for_sale || parcel.sale_price === null) {
      throw new ConflictError('This parcel is not for sale');
    }
    if (parcel.owner_id === buyerId) {
      throw new ConflictError('You already own this parcel');
    }

    const price = parcel.sale_price;

    // Conditional debit: affects zero rows when funds are insufficient, which
    // is both the balance check and the deduction in one atomic statement.
    const debit = await trx
      .updateTable('profiles')
      .set({ balance: sql`balance - ${price}::numeric` })
      .where('user_id', '=', buyerId)
      .where(sql<boolean>`balance >= ${price}::numeric`)
      .executeTakeFirst();

    if (debit.numUpdatedRows !== 1n) {
      throw new ConflictError('Insufficient funds for this purchase');
    }

    if (parcel.owner_id) {
      await trx
        .updateTable('profiles')
        .set({ balance: sql`balance + ${price}::numeric` })
        .where('user_id', '=', parcel.owner_id)
        .execute();
    }

    await trx
      .updateTable('land_parcels')
      .set({
        owner_id: buyerId,
        for_sale: false,
        sale_price: null,
        updated_at: sql`now()`,
      })
      .where('id', '=', parcelId)
      .execute();

    await trx
      .insertInto('transactions')
      .values({
        sender_user_id: buyerId,
        receiver_user_id: parcel.owner_id,
        amount: price,
        reason: 'land_purchase',
        metadata: JSON.stringify({ parcelId }),
      })
      .execute();

    if (parcel.owner_id) {
      await trx
        .insertInto('notifications')
        .values({
          user_id: parcel.owner_id,
          kind: 'land_sold',
          title: 'Your land sold',
          body: `A parcel you owned sold for ${price}.`,
        })
        .execute();
    }

    const updated = await trx
      .selectFrom('profiles')
      .select(['balance'])
      .where('user_id', '=', buyerId)
      .executeTakeFirstOrThrow();

    return {
      parcelId,
      pricePaid: price,
      // Already a string at runtime (the NUMERIC parser in @wf/db guarantees
      // it); String() only satisfies the column's declared type.
      newBalance: String(updated.balance),
      sellerId: parcel.owner_id,
    };
  });
}

async function requireOwnership(db: Db, userId: string, parcelId: string) {
  const parcel = await db
    .selectFrom('land_parcels')
    .select(['id', 'owner_id'])
    .where('id', '=', parcelId)
    .executeTakeFirst();

  if (!parcel) {
    throw new NotFoundError('Parcel not found');
  }
  if (parcel.owner_id !== userId) {
    throw new ForbiddenError('You do not own this parcel');
  }
  return parcel;
}

export async function listParcelForSale(
  db: Db,
  userId: string,
  parcelId: string,
  price: string,
): Promise<void> {
  await requireOwnership(db, userId, parcelId);

  await db
    .updateTable('land_parcels')
    .set({ for_sale: true, sale_price: price, updated_at: sql`now()` })
    .where('id', '=', parcelId)
    .execute();
}

export async function unlistParcel(db: Db, userId: string, parcelId: string): Promise<void> {
  await requireOwnership(db, userId, parcelId);

  await db
    .updateTable('land_parcels')
    .set({ for_sale: false, sale_price: null, updated_at: sql`now()` })
    .where('id', '=', parcelId)
    .execute();
}

export async function setParcelZoning(
  db: Db,
  userId: string,
  parcelId: string,
  zoning: LandZoning,
): Promise<void> {
  await requireOwnership(db, userId, parcelId);

  await db
    .updateTable('land_parcels')
    .set({ zoning, updated_at: sql`now()` })
    .where('id', '=', parcelId)
    .execute();
}

/** Parcels currently on the market, cheapest first. */
export async function listMarket(db: Db, limit = 50) {
  return db
    .selectFrom('land_parcels')
    .leftJoin('users', 'users.id', 'land_parcels.owner_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .select([
      'land_parcels.id',
      'land_parcels.zoning',
      'land_parcels.area_sqm',
      'land_parcels.market_value',
      'land_parcels.sale_price',
      'users.username as owner_name',
      'cities.name as city_name',
    ])
    .select(sql<string>`ST_AsGeoJSON(land_parcels.centroid)`.as('centroid'))
    .where('land_parcels.for_sale', '=', true)
    .orderBy('land_parcels.sale_price', 'asc')
    .limit(Math.min(limit, 200))
    .execute();
}
