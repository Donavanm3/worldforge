import { sql } from 'kysely';
import type { Db } from '@wf/db';
import type { BuildingType } from '@wf/shared';
import { appraiseBuilding, planBuilding } from '@wf/engine';

/**
 * NPC landlords: buildings that already exist when a player arrives (spec 17).
 *
 * A world where every building must first be built by a player is an empty
 * world on day one — there is nothing to buy, nothing to rent, and no reason to
 * open the map twice. These landlords give a new player somewhere to put their
 * first pound, and a deed to work towards.
 *
 * They are not accounts. `npc_owner_name` marks the building; the owner column
 * points at a real system user so the foreign key stays honest, and NPC sales
 * take money out of circulation rather than crediting a fiction.
 */

const LANDLORD_NAMES = [
  'Sven Delacroix',
  'Marta Oyelaran',
  'Idris Vance',
  'Yuki Tanaka-Bell',
  'Rosa Ferreira',
  'Alistair Quinn',
  'Nadia Haddad',
  'Tomas Nowak',
  'Grace Okonkwo',
  'Henrik Solberg',
];

/** What NPCs build, and what such a block tends to be called. */
const ARCHETYPES: Array<{ type: BuildingType; names: string[]; floors: [number, number] }> = [
  { type: 'retail', names: ['Shops', 'The Parade', 'Market Row'], floors: [2, 5] },
  { type: 'mixed_use', names: ['Corner Block', 'The Exchange', 'Old Works'], floors: [3, 7] },
  { type: 'residential', names: ['Terrace', 'The Mansions', 'Court'], floors: [2, 6] },
  { type: 'office', names: ['Chambers', 'House', 'The Registry'], floors: [3, 9] },
];

const SYSTEM_USERNAME = 'worldforge';

export interface NpcSeedSummary {
  buildings: number;
  units: number;
  skipped: number;
}

/** Deterministic, so re-running the seeder does not reshuffle the world. */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The account that holds every NPC building.
 *
 * Created suspended and with an unusable password hash: it exists to satisfy
 * the foreign key on buildings.owner_id, and nobody must ever be able to log
 * into it. Players never see this name — `npc_owner_name` is what is shown.
 */
async function ensureSystemUser(db: Db): Promise<{ id: string }> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', SYSTEM_USERNAME)
    .executeTakeFirst();

  if (existing) return existing;

  const created = await db
    .insertInto('users')
    .values({
      email: 'npc@worldforge.invalid',
      username: SYSTEM_USERNAME,
      // Not a hash of anything. Argon2 verification cannot succeed against it.
      password_hash: 'locked',
      status: 'suspended',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('profiles')
    .values({ user_id: created.id, display_name: 'NPC landlords' })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();

  return created;
}

export interface NpcSeedOptions {
  /** Share of unowned parcels in each city that get a building. */
  density?: number;
  perCity?: number;
  seed?: number;
  onProgress?: (message: string) => void;
}

/**
 * Puts NPC-owned buildings on a share of the unowned parcels in each city.
 *
 * Skips parcels a player owns and parcels that already have a building, so it
 * is safe to run again on a live world to fill in newly surveyed areas.
 */
export async function seedNpcLandlords(
  db: Db,
  options: NpcSeedOptions = {},
): Promise<NpcSeedSummary> {
  const perCity = options.perCity ?? 12;
  const random = createRandom(options.seed ?? 20260829);
  const progress = options.onProgress ?? (() => {});

  // The buildings need an owner_id, and the schema requires a real user. One
  // system account holds every NPC building; npc_owner_name is what players see.
  const system = await ensureSystemUser(db);

  const cities = await db.selectFrom('cities').select(['id', 'name']).execute();

  let buildingCount = 0;
  let unitCount = 0;
  let skipped = 0;

  for (const city of cities) {
    const parcels = await db
      .selectFrom('land_parcels')
      .leftJoin('buildings', 'buildings.parcel_id', 'land_parcels.id')
      .select(['land_parcels.id', 'land_parcels.area_sqm', 'land_parcels.market_value'])
      .where('land_parcels.city_id', '=', city.id)
      .where('land_parcels.owner_id', 'is', null)
      .where('buildings.id', 'is', null)
      .orderBy('land_parcels.market_value', 'desc')
      .limit(perCity)
      .execute();

    for (const parcel of parcels) {
      const area = Number(parcel.area_sqm);
      const landRate = Math.min(2, Math.max(0.3, Number(parcel.market_value) / Math.max(1, area)));

      const archetype = ARCHETYPES[Math.floor(random() * ARCHETYPES.length)]!;
      const [minFloors, maxFloors] = archetype.floors;
      const floors = minFloors + Math.floor(random() * (maxFloors - minFloors + 1));
      // NPCs build modestly: half the plot, never the maximum allowed.
      const footprint = Math.max(30, Math.floor(area * 0.45));

      let plan;
      try {
        plan = planBuilding({
          parcelAreaSqm: area,
          footprintSqm: footprint,
          floors,
          type: archetype.type,
          landRatePerSqm: landRate,
        });
      } catch {
        // A parcel too small or oddly shaped to build on. Not an error.
        skipped += 1;
        continue;
      }

      const landlord = LANDLORD_NAMES[Math.floor(random() * LANDLORD_NAMES.length)]!;
      const name = archetype.names[Math.floor(random() * archetype.names.length)]!;
      const appraisal = appraiseBuilding({
        unitValues: plan.floors.flatMap((floor) => floor.units.map((unit) => unit.marketValue)),
        unitRevenues: [],
      });

      const building = await db
        .insertInto('buildings')
        .values({
          parcel_id: parcel.id,
          owner_id: system.id,
          npc_owner_name: landlord,
          name,
          type: archetype.type,
          // Already standing: a player should not wait out an NPC's build.
          status: 'complete',
          floors: plan.floors.length,
          footprint_sqm: sql`${footprint}::numeric` as never,
          construction_cost: sql`${plan.constructionCost}::numeric` as never,
          completes_at: sql`now()` as never,
          appraised_value: sql`${appraisal}::numeric` as never,
          // The deed is on the market from the start; that is the point.
          for_sale: true,
          sale_price: sql`${appraisal}::numeric` as never,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const floor of plan.floors) {
        const floorRow = await db
          .insertInto('building_floors')
          .values({
            building_id: building.id,
            level: floor.level,
            floor_area_sqm: sql`${floor.floorAreaSqm}::numeric` as never,
            use: floor.use,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await db
          .insertInto('building_units')
          .values(
            floor.units.map((unit) => ({
              building_id: building.id,
              floor_id: floorRow.id,
              label: unit.label,
              area_sqm: sql`${unit.areaSqm}::numeric` as never,
              use: unit.use,
              owner_id: system.id,
              market_value: sql`${unit.marketValue}::numeric` as never,
              // Individual rooms are for sale too, so a player who cannot
              // afford a whole building can still get a foot in the door.
              for_sale: true,
              sale_price: sql`${unit.marketValue}::numeric` as never,
            })),
          )
          .execute();

        unitCount += floor.units.length;
      }

      buildingCount += 1;
    }

    progress(`  ${city.name}: ${parcels.length} NPC buildings`);
  }

  return { buildings: buildingCount, units: unitCount, skipped };
}
