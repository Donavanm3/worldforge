import { sql } from 'kysely';
import type { Db } from '@wf/db';
import { DEED_REVENUE_SHARE, appraiseBuilding, footTraffic, unitRevenue } from '@wf/engine';

/**
 * Rent and trade: what buildings actually earn (spec 17).
 *
 * A unit pays its owner every tick. The deed holder takes a cut of every unit
 * in the building, including ones they do not own — that split is what makes a
 * building worth buying whole rather than room by room.
 */

/**
 * Recomputes foot traffic and per-unit revenue for every complete building.
 *
 * Run separately from paying out, because it depends on geometry that only
 * changes when something is built, not every tick.
 */
export async function refreshBuildingEconomics(db: Db): Promise<number> {
  const buildings = await sql<{
    id: string;
    frontage_m: string;
    population: string | null;
    distance_km: string | null;
  }>`
    select
      buildings.id,
      -- Perimeter is a fair stand-in for frontage: a block bounded by streets
      -- fronts them on every side, and we have no per-edge road data.
      ST_Perimeter(land_parcels.boundary::geography) as frontage_m,
      cities.population,
      case
        when cities.center is null then null
        else ST_Distance(land_parcels.centroid::geography, cities.center::geography) / 1000
      end as distance_km
    from buildings
    join land_parcels on land_parcels.id = buildings.parcel_id
    left join cities on cities.id = land_parcels.city_id
    where buildings.status = 'complete'
  `.execute(db);

  let updated = 0;

  for (const building of buildings.rows) {
    const traffic = footTraffic({
      streetFrontageM: Number(building.frontage_m),
      cityPopulation: Number(building.population ?? 5_000),
      distanceToCentreKm: Number(building.distance_km ?? 40),
    });

    const units = await db
      .selectFrom('building_units')
      .select(['id', 'area_sqm', 'use', 'market_value'])
      .where('building_id', '=', building.id)
      .execute();

    const revenues: number[] = [];
    for (const unit of units) {
      const revenue = unitRevenue({
        areaSqm: Number(unit.area_sqm),
        use: unit.use,
        footTraffic: traffic,
      });
      revenues.push(revenue);

      await db
        .updateTable('building_units')
        .set({ revenue_per_tick: sql`${revenue}::numeric` })
        .where('id', '=', unit.id)
        .execute();
    }

    const appraisal = appraiseBuilding({
      unitValues: units.map((unit) => Number(unit.market_value)),
      unitRevenues: revenues,
    });

    await db
      .updateTable('buildings')
      .set({
        foot_traffic: sql`${traffic}::numeric`,
        appraised_value: sql`${appraisal}::numeric`,
        updated_at: sql`now()`,
      })
      .where('id', '=', building.id)
      .execute();

    updated += 1;
  }

  return updated;
}

export interface RevenueResult {
  unitsPaid: number;
  totalPaid: string;
}

/**
 * Pays out one tick of building income.
 *
 * Done as two set-based statements rather than a loop: at scale this touches
 * every unit in the world, and a per-unit round trip would not survive it.
 * NPC landlords are excluded from payouts — they have no profile to credit,
 * and paying an imaginary account would leak money into nothing.
 */
export async function runRevenueTick(db: Db): Promise<RevenueResult> {
  const share = DEED_REVENUE_SHARE;

  // The occupier keeps what the deed holder does not take.
  const occupiers = await sql<{ paid: string; units: string }>`
    with earnings as (
      select
        u.owner_id,
        sum(u.revenue_per_tick) * ${1 - share} as amount,
        count(*) as units
      from building_units u
      join buildings b on b.id = u.building_id
      where b.status = 'complete'
        and u.owner_id is not null
        and u.revenue_per_tick > 0
        -- Rooms an NPC landlord still holds pay nobody. Their owner is the
        -- system account, and crediting it would mint money into a fiction.
        -- A player who bought a room inside an NPC building is still paid.
        and not (b.npc_owner_name is not null and u.owner_id = b.owner_id)
      group by u.owner_id
    ),
    paid as (
      update profiles
      set balance = profiles.balance + earnings.amount
      from earnings
      where profiles.user_id = earnings.owner_id
      returning earnings.amount, earnings.units
    )
    select coalesce(sum(amount), 0)::text as paid, coalesce(sum(units), 0)::text as units
    from paid
  `.execute(db);

  // The deed holder's cut, from every unit in every building they hold.
  const landlords = await sql<{ paid: string }>`
    with cuts as (
      select
        b.owner_id,
        sum(u.revenue_per_tick) * ${share} as amount
      from building_units u
      join buildings b on b.id = u.building_id
      where b.status = 'complete'
        and b.npc_owner_name is null
        and u.revenue_per_tick > 0
      group by b.owner_id
    ),
    paid as (
      update profiles
      set balance = profiles.balance + cuts.amount
      from cuts
      where profiles.user_id = cuts.owner_id
      returning cuts.amount
    )
    select coalesce(sum(amount), 0)::text as paid from paid
  `.execute(db);

  await sql`
    update building_units
    set total_earned = total_earned + revenue_per_tick
    where revenue_per_tick > 0
      and building_id in (select id from buildings where status = 'complete')
  `.execute(db);

  const total = Number(occupiers.rows[0]?.paid ?? 0) + Number(landlords.rows[0]?.paid ?? 0);

  return {
    unitsPaid: Number(occupiers.rows[0]?.units ?? 0),
    totalPaid: total.toFixed(4),
  };
}
