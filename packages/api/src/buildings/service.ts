import { sql } from 'kysely';
import {
  type BuildingStatus,
  type BuildingType,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type UnitUse,
  ValidationError,
} from '@wf/shared';
import type { Db } from '@wf/db';
import { BuildingPlanError, planBuilding } from '@wf/engine';

/**
 * Construction and the unit market (spec 14-16).
 *
 * Every money movement is a single conditional UPDATE inside a transaction —
 * never read-then-write — and all arithmetic stays in PostgreSQL `numeric`.
 */

export interface BuildingSummary {
  id: string;
  parcelId: string;
  ownerId: string;
  ownerName: string | null;
  name: string;
  type: BuildingType;
  status: BuildingStatus;
  floors: number;
  footprintSqm: string;
  constructionCost: string;
  completesAt: string;
  cityName: string | null;
  unitCount: number;
  unitsForSale: number;
}

export interface UnitSummary {
  id: string;
  buildingId: string;
  label: string;
  level: number;
  areaSqm: string;
  use: UnitUse;
  ownerId: string | null;
  ownerName: string | null;
  marketValue: string;
  forSale: boolean;
  salePrice: string | null;
}

export interface BuildingDetail extends BuildingSummary {
  floorPlan: Array<{
    level: number;
    floorAreaSqm: string;
    use: UnitUse;
    units: UnitSummary[];
  }>;
}

export interface QuoteResult {
  constructionCost: string;
  buildMinutes: number;
  floors: number;
  unitCount: number;
  grossFloorAreaSqm: number;
  netFloorAreaSqm: number;
}

/** Land rate is not stored per parcel, so it is recovered from its valuation. */
function impliedLandRate(marketValue: string, areaSqm: string): number {
  const area = Number(areaSqm);
  if (!(area > 0)) return 1;
  // The seeder's rates land roughly in 0.4-1.6 per m²; clamping keeps a freak
  // parcel from producing an absurd construction quote.
  return Math.min(2, Math.max(0.3, Number(marketValue) / area));
}

async function loadParcelForBuild(db: Db, parcelId: string, userId: string) {
  const parcel = await db
    .selectFrom('land_parcels')
    .leftJoin('buildings', 'buildings.parcel_id', 'land_parcels.id')
    .select([
      'land_parcels.id',
      'land_parcels.owner_id',
      'land_parcels.area_sqm',
      'land_parcels.market_value',
      'land_parcels.zoning',
      'buildings.id as building_id',
    ])
    .where('land_parcels.id', '=', parcelId)
    .executeTakeFirst();

  if (!parcel) throw new NotFoundError('Parcel not found');
  if (parcel.owner_id !== userId) {
    throw new ForbiddenError('You can only build on land you own');
  }
  if (parcel.building_id) {
    throw new ConflictError('This parcel already has a building on it');
  }
  return parcel;
}

/** Prices a proposed building without committing to it. */
export async function quoteBuilding(
  db: Db,
  userId: string,
  parcelId: string,
  input: { footprintSqm: number; floors: number; type: BuildingType },
): Promise<QuoteResult> {
  const parcel = await loadParcelForBuild(db, parcelId, userId);

  try {
    const plan = planBuilding({
      parcelAreaSqm: Number(parcel.area_sqm),
      footprintSqm: input.footprintSqm,
      floors: input.floors,
      type: input.type,
      landRatePerSqm: impliedLandRate(parcel.market_value, parcel.area_sqm),
    });

    return {
      constructionCost: plan.constructionCost.toFixed(4),
      buildMinutes: plan.buildMinutes,
      floors: plan.floors.length,
      unitCount: plan.unitCount,
      grossFloorAreaSqm: plan.grossFloorAreaSqm,
      netFloorAreaSqm: plan.netFloorAreaSqm,
    };
  } catch (error) {
    if (error instanceof BuildingPlanError) throw new ValidationError(error.message);
    throw error;
  }
}

export interface StartBuildResult {
  buildingId: string;
  constructionCost: string;
  completesAt: string;
  unitCount: number;
  balance: string;
}

/**
 * Breaks ground: charges the owner and writes the building, its floors and
 * every unit in one transaction.
 *
 * The units exist from day one but the building is `under_construction` until
 * the tick completes it, and unfinished units cannot be sold.
 */
export async function startConstruction(
  db: Db,
  userId: string,
  parcelId: string,
  input: { name: string; footprintSqm: number; floors: number; type: BuildingType },
): Promise<StartBuildResult> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new ValidationError('A building name must be between 2 and 80 characters.');
  }

  return db.transaction().execute(async (trx) => {
    // Re-read inside the transaction and lock: two requests could otherwise
    // both pass the "no building yet" check and race to build on one parcel.
    const parcel = await trx
      .selectFrom('land_parcels')
      .select(['id', 'owner_id', 'area_sqm', 'market_value'])
      .where('id', '=', parcelId)
      .forUpdate()
      .executeTakeFirst();

    if (!parcel) throw new NotFoundError('Parcel not found');
    if (parcel.owner_id !== userId) {
      throw new ForbiddenError('You can only build on land you own');
    }

    const existing = await trx
      .selectFrom('buildings')
      .select('id')
      .where('parcel_id', '=', parcelId)
      .executeTakeFirst();
    if (existing) throw new ConflictError('This parcel already has a building on it');

    let plan;
    try {
      plan = planBuilding({
        parcelAreaSqm: Number(parcel.area_sqm),
        footprintSqm: input.footprintSqm,
        floors: input.floors,
        type: input.type,
        landRatePerSqm: impliedLandRate(parcel.market_value, parcel.area_sqm),
      });
    } catch (error) {
      if (error instanceof BuildingPlanError) throw new ValidationError(error.message);
      throw error;
    }

    const cost = plan.constructionCost.toFixed(4);

    const debit = await trx
      .updateTable('profiles')
      .set({ balance: sql`balance - ${cost}::numeric` })
      .where('user_id', '=', userId)
      .where(sql<boolean>`balance >= ${cost}::numeric`)
      .executeTakeFirst();

    if (debit.numUpdatedRows !== 1n) {
      throw new ConflictError('Insufficient funds to start construction');
    }

    const building = await trx
      .insertInto('buildings')
      .values({
        parcel_id: parcelId,
        owner_id: userId,
        name,
        type: input.type,
        status: 'under_construction',
        floors: plan.floors.length,
        footprint_sqm: sql`${input.footprintSqm}::numeric`,
        construction_cost: sql`${cost}::numeric`,
        completes_at: sql`now() + ${`${plan.buildMinutes} minutes`}::interval` as never,
      })
      .returning(['id', 'completes_at'])
      .executeTakeFirstOrThrow();

    for (const floor of plan.floors) {
      const floorRow = await trx
        .insertInto('building_floors')
        .values({
          building_id: building.id,
          level: floor.level,
          floor_area_sqm: sql`${floor.floorAreaSqm}::numeric`,
          use: floor.use,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('building_units')
        .values(
          floor.units.map((unit) => ({
            building_id: building.id,
            floor_id: floorRow.id,
            label: unit.label,
            area_sqm: sql`${unit.areaSqm}::numeric` as never,
            use: unit.use,
            // The developer owns every unit until someone buys one.
            owner_id: userId,
            market_value: sql`${unit.marketValue}::numeric` as never,
            for_sale: false,
          })),
        )
        .execute();
    }

    await trx
      .insertInto('transactions')
      .values({
        sender_user_id: userId,
        receiver_user_id: null,
        amount: sql`${cost}::numeric` as never,
        reason: 'construction',
        metadata: JSON.stringify({ parcelId, buildingId: building.id }),
      })
      .execute();

    const profile = await trx
      .selectFrom('profiles')
      .select('balance')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    return {
      buildingId: building.id,
      constructionCost: cost,
      completesAt: String(building.completes_at),
      unitCount: plan.unitCount,
      balance: String(profile.balance),
    };
  });
}

const summarySelect = [
  'buildings.id',
  'buildings.parcel_id',
  'buildings.owner_id',
  'buildings.name',
  'buildings.type',
  'buildings.status',
  'buildings.floors',
  'buildings.footprint_sqm',
  'buildings.construction_cost',
  'buildings.completes_at',
] as const;

function toSummary(row: Record<string, unknown>): BuildingSummary {
  return {
    id: row['id'] as string,
    parcelId: row['parcel_id'] as string,
    ownerId: row['owner_id'] as string,
    ownerName: (row['owner_name'] as string | null) ?? null,
    name: row['name'] as string,
    type: row['type'] as BuildingType,
    status: row['status'] as BuildingStatus,
    floors: Number(row['floors']),
    footprintSqm: String(row['footprint_sqm']),
    constructionCost: String(row['construction_cost']),
    completesAt: String(row['completes_at']),
    cityName: (row['city_name'] as string | null) ?? null,
    unitCount: Number(row['unit_count'] ?? 0),
    unitsForSale: Number(row['units_for_sale'] ?? 0),
  };
}

/** Buildings the player owns. */
export async function listMyBuildings(db: Db, userId: string): Promise<BuildingSummary[]> {
  const rows = await db
    .selectFrom('buildings')
    .innerJoin('land_parcels', 'land_parcels.id', 'buildings.parcel_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .leftJoin('users', 'users.id', 'buildings.owner_id')
    .leftJoin('building_units', 'building_units.building_id', 'buildings.id')
    .select([...summarySelect])
    .select(['cities.name as city_name', 'users.username as owner_name'])
    .select(sql<string>`count(building_units.id)`.as('unit_count'))
    .select(
      sql<string>`count(building_units.id) filter (where building_units.for_sale)`.as(
        'units_for_sale',
      ),
    )
    .where('buildings.owner_id', '=', userId)
    .groupBy(['buildings.id', 'cities.name', 'users.username'])
    .orderBy('buildings.created_at', 'desc')
    .execute();

  return rows.map((row) => toSummary(row as never));
}

/** Every building with units on the open market. */
export async function listBuildingsWithUnitsForSale(db: Db): Promise<BuildingSummary[]> {
  const rows = await db
    .selectFrom('buildings')
    .innerJoin('land_parcels', 'land_parcels.id', 'buildings.parcel_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .leftJoin('users', 'users.id', 'buildings.owner_id')
    .innerJoin('building_units', 'building_units.building_id', 'buildings.id')
    .select([...summarySelect])
    .select(['cities.name as city_name', 'users.username as owner_name'])
    .select(sql<string>`count(building_units.id)`.as('unit_count'))
    .select(
      sql<string>`count(building_units.id) filter (where building_units.for_sale)`.as(
        'units_for_sale',
      ),
    )
    .where('buildings.status', '=', 'complete')
    .where('building_units.for_sale', '=', true)
    .groupBy(['buildings.id', 'cities.name', 'users.username'])
    .orderBy('buildings.name')
    .limit(100)
    .execute();

  return rows.map((row) => toSummary(row as never));
}

/** A building with its full floor plan and every unit. */
export async function getBuilding(db: Db, buildingId: string): Promise<BuildingDetail> {
  const row = await db
    .selectFrom('buildings')
    .innerJoin('land_parcels', 'land_parcels.id', 'buildings.parcel_id')
    .leftJoin('cities', 'cities.id', 'land_parcels.city_id')
    .leftJoin('users', 'users.id', 'buildings.owner_id')
    .select([...summarySelect])
    .select(['cities.name as city_name', 'users.username as owner_name'])
    .where('buildings.id', '=', buildingId)
    .executeTakeFirst();

  if (!row) throw new NotFoundError('Building not found');

  const floors = await db
    .selectFrom('building_floors')
    .select(['id', 'level', 'floor_area_sqm', 'use'])
    .where('building_id', '=', buildingId)
    .orderBy('level')
    .execute();

  const units = await db
    .selectFrom('building_units')
    .innerJoin('building_floors', 'building_floors.id', 'building_units.floor_id')
    .leftJoin('users', 'users.id', 'building_units.owner_id')
    .select([
      'building_units.id',
      'building_units.building_id',
      'building_units.floor_id',
      'building_units.label',
      'building_units.area_sqm',
      'building_units.use',
      'building_units.owner_id',
      'building_units.market_value',
      'building_units.for_sale',
      'building_units.sale_price',
      'building_floors.level',
      'users.username as owner_name',
    ])
    .where('building_units.building_id', '=', buildingId)
    .orderBy('building_floors.level')
    .orderBy('building_units.label')
    .execute();

  const summary = toSummary({
    ...row,
    unit_count: units.length,
    units_for_sale: units.filter((unit) => unit.for_sale).length,
  } as never);

  return {
    ...summary,
    floorPlan: floors.map((floor) => ({
      level: floor.level,
      floorAreaSqm: String(floor.floor_area_sqm),
      use: floor.use,
      units: units
        .filter((unit) => unit.floor_id === floor.id)
        .map((unit) => ({
          id: unit.id,
          buildingId: unit.building_id,
          label: unit.label,
          level: unit.level,
          areaSqm: String(unit.area_sqm),
          use: unit.use,
          ownerId: unit.owner_id,
          ownerName: unit.owner_name,
          marketValue: String(unit.market_value),
          forSale: unit.for_sale,
          salePrice: unit.sale_price === null ? null : String(unit.sale_price),
        })),
    })),
  };
}

/** Units the player owns, across every building. */
export async function listMyUnits(db: Db, userId: string): Promise<UnitSummary[]> {
  const rows = await db
    .selectFrom('building_units')
    .innerJoin('building_floors', 'building_floors.id', 'building_units.floor_id')
    .leftJoin('users', 'users.id', 'building_units.owner_id')
    .select([
      'building_units.id',
      'building_units.building_id',
      'building_units.label',
      'building_units.area_sqm',
      'building_units.use',
      'building_units.owner_id',
      'building_units.market_value',
      'building_units.for_sale',
      'building_units.sale_price',
      'building_floors.level',
      'users.username as owner_name',
    ])
    .where('building_units.owner_id', '=', userId)
    .orderBy('building_units.label')
    .execute();

  return rows.map((unit) => ({
    id: unit.id,
    buildingId: unit.building_id,
    label: unit.label,
    level: unit.level,
    areaSqm: String(unit.area_sqm),
    use: unit.use,
    ownerId: unit.owner_id,
    ownerName: unit.owner_name,
    marketValue: String(unit.market_value),
    forSale: unit.for_sale,
    salePrice: unit.sale_price === null ? null : String(unit.sale_price),
  }));
}

/** Offers a unit for sale. */
export async function listUnit(
  db: Db,
  userId: string,
  unitId: string,
  price: string,
): Promise<void> {
  const unit = await db
    .selectFrom('building_units')
    .innerJoin('buildings', 'buildings.id', 'building_units.building_id')
    .select(['building_units.id', 'building_units.owner_id', 'buildings.status'])
    .where('building_units.id', '=', unitId)
    .executeTakeFirst();

  if (!unit) throw new NotFoundError('Unit not found');
  if (unit.owner_id !== userId) throw new ForbiddenError('You do not own this unit');
  if (unit.status !== 'complete') {
    throw new ConflictError('This building is still under construction');
  }

  await db
    .updateTable('building_units')
    .set({ for_sale: true, sale_price: sql`${price}::numeric`, updated_at: sql`now()` })
    .where('id', '=', unitId)
    .execute();
}

export async function unlistUnit(db: Db, userId: string, unitId: string): Promise<void> {
  const result = await db
    .updateTable('building_units')
    .set({ for_sale: false, sale_price: null, updated_at: sql`now()` })
    .where('id', '=', unitId)
    .where('owner_id', '=', userId)
    .executeTakeFirst();

  if (result.numUpdatedRows !== 1n) {
    throw new NotFoundError('Unit not found, or you do not own it');
  }
}

export interface UnitPurchaseResult {
  unitId: string;
  pricePaid: string;
  balance: string;
}

/** Buys a listed unit, moving money and title in one transaction. */
export async function buyUnit(
  db: Db,
  buyerId: string,
  unitId: string,
): Promise<UnitPurchaseResult> {
  return db.transaction().execute(async (trx) => {
    const unit = await trx
      .selectFrom('building_units')
      .innerJoin('buildings', 'buildings.id', 'building_units.building_id')
      .select([
        'building_units.id',
        'building_units.owner_id',
        'building_units.for_sale',
        'building_units.sale_price',
        'building_units.label',
        'buildings.status',
      ])
      .where('building_units.id', '=', unitId)
      .forUpdate()
      .executeTakeFirst();

    if (!unit) throw new NotFoundError('Unit not found');
    if (!unit.for_sale || unit.sale_price === null) {
      throw new ConflictError('This unit is not for sale');
    }
    if (unit.owner_id === buyerId) throw new ConflictError('You already own this unit');
    if (unit.status !== 'complete') {
      throw new ConflictError('This building is still under construction');
    }

    const price = unit.sale_price;

    const debit = await trx
      .updateTable('profiles')
      .set({ balance: sql`balance - ${price}::numeric` })
      .where('user_id', '=', buyerId)
      .where(sql<boolean>`balance >= ${price}::numeric`)
      .executeTakeFirst();

    if (debit.numUpdatedRows !== 1n) {
      throw new ConflictError('Insufficient funds for this purchase');
    }

    if (unit.owner_id) {
      await trx
        .updateTable('profiles')
        .set({ balance: sql`balance + ${price}::numeric` })
        .where('user_id', '=', unit.owner_id)
        .execute();
    }

    await trx
      .updateTable('building_units')
      .set({ owner_id: buyerId, for_sale: false, sale_price: null, updated_at: sql`now()` })
      .where('id', '=', unitId)
      .execute();

    await trx
      .insertInto('transactions')
      .values({
        sender_user_id: buyerId,
        receiver_user_id: unit.owner_id,
        amount: price,
        reason: 'unit_purchase',
        metadata: JSON.stringify({ unitId }),
      })
      .execute();

    if (unit.owner_id) {
      await trx
        .insertInto('notifications')
        .values({
          user_id: unit.owner_id,
          kind: 'unit_sold',
          title: 'Your unit sold',
          body: `Unit ${unit.label} sold for ${price}.`,
        })
        .execute();
    }

    const profile = await trx
      .selectFrom('profiles')
      .select('balance')
      .where('user_id', '=', buyerId)
      .executeTakeFirstOrThrow();

    return { unitId, pricePaid: String(price), balance: String(profile.balance) };
  });
}
