import { sql } from 'kysely';
import type { Db } from '@wf/db';
import type { LandZoning } from '@wf/shared';
import { haversineKm, valueParcel } from '@wf/engine';

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeding must be reproducible: the same seed yields the same world, so a bug
 * report about a parcel can be reproduced locally.
 */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CitySeed {
  name: string;
  lat: number;
  lng: number;
  population: number;
  baseRatePerSqm: number;
}

interface CountrySeed {
  name: string;
  code: string;
  regionName: string;
  regionCode: string;
  cities: CitySeed[];
}

/**
 * Five fictional countries. Deliberately invented rather than real nations, so
 * the game world carries no real-world political claims (spec: original IP).
 */
const WORLD: CountrySeed[] = [
  {
    name: 'Astoria',
    code: 'AST',
    regionName: 'Northern Reach',
    regionCode: 'AST-NR',
    cities: [
      { name: 'Port Aurelia', lat: 45.2, lng: -12.4, population: 1_850_000, baseRatePerSqm: 9.5 },
      { name: 'Kestrel Bay', lat: 46.1, lng: -11.7, population: 620_000, baseRatePerSqm: 6.2 },
    ],
  },
  {
    name: 'Verdant Republic',
    code: 'VRD',
    regionName: 'Green Belt',
    regionCode: 'VRD-GB',
    cities: [
      { name: 'Thornfield', lat: 38.7, lng: 4.3, population: 2_400_000, baseRatePerSqm: 11.0 },
      { name: 'Millbrook', lat: 39.4, lng: 5.1, population: 430_000, baseRatePerSqm: 5.4 },
    ],
  },
  {
    name: 'Solenne',
    code: 'SOL',
    regionName: 'Sunward Coast',
    regionCode: 'SOL-SC',
    cities: [
      { name: 'Calanque', lat: 31.8, lng: 18.9, population: 3_100_000, baseRatePerSqm: 13.5 },
      { name: 'Vireau', lat: 32.5, lng: 19.6, population: 780_000, baseRatePerSqm: 7.1 },
    ],
  },
  {
    name: 'Norhavn',
    code: 'NOR',
    regionName: 'Iron Fjords',
    regionCode: 'NOR-IF',
    cities: [
      { name: 'Steinvik', lat: 59.3, lng: 8.7, population: 940_000, baseRatePerSqm: 7.8 },
      { name: 'Haldsund', lat: 60.1, lng: 9.4, population: 310_000, baseRatePerSqm: 4.6 },
    ],
  },
  {
    name: 'Meridia',
    code: 'MER',
    regionName: 'Central Plateau',
    regionCode: 'MER-CP',
    cities: [
      { name: 'Ashgate', lat: -14.2, lng: 27.5, population: 1_200_000, baseRatePerSqm: 8.3 },
      { name: 'Duneford', lat: -13.5, lng: 28.2, population: 505_000, baseRatePerSqm: 5.9 },
    ],
  },
];

const ZONING_WEIGHTS: ReadonlyArray<readonly [LandZoning, number]> = [
  ['unzoned', 0.3],
  ['residential', 0.25],
  ['commercial', 0.15],
  ['industrial', 0.12],
  ['agricultural', 0.15],
  ['infrastructure', 0.03],
];

function pickZoning(random: () => number): LandZoning {
  let roll = random();
  for (const [zoning, weight] of ZONING_WEIGHTS) {
    if (roll < weight) return zoning;
    roll -= weight;
  }
  return 'unzoned';
}

export interface SeedOptions {
  parcelsPerCity?: number;
  seed?: number;
  /** Fraction of parcels listed for sale by the world at start. */
  forSaleRatio?: number;
}

export interface SeedSummary {
  countries: number;
  regions: number;
  cities: number;
  parcels: number;
}

/**
 * Populates the starter world (spec 80).
 *
 * Idempotent by refusing to run twice: seeding a world that already has land
 * would create overlapping parcels and duplicate cities.
 */
export async function seedWorld(db: Db, options: SeedOptions = {}): Promise<SeedSummary> {
  const parcelsPerCity = options.parcelsPerCity ?? 50;
  const forSaleRatio = options.forSaleRatio ?? 0.6;
  const random = createRandom(options.seed ?? 20260826);

  const existing = await db
    .selectFrom('land_parcels')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  if (Number(existing.count) > 0) {
    throw new Error(
      'World already contains land parcels. Refusing to seed twice — clear the tables first.',
    );
  }

  let parcelCount = 0;
  let cityCount = 0;

  for (const country of WORLD) {
    const countryRow = await db
      .insertInto('countries')
      .values({
        name: country.name,
        code: country.code,
        population: country.cities.reduce((sum, c) => sum + c.population, 0),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const regionRow = await db
      .insertInto('regions')
      .values({
        country_id: countryRow.id,
        name: country.regionName,
        code: country.regionCode,
        population: country.cities.reduce((sum, c) => sum + c.population, 0),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    for (const city of country.cities) {
      const cityRow = await db
        .insertInto('cities')
        .values({
          region_id: regionRow.id,
          name: city.name,
          population: city.population,
          center: sql`ST_SetSRID(ST_MakePoint(${city.lng}, ${city.lat}), 4326)` as never,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      cityCount += 1;

      for (let i = 0; i < parcelsPerCity; i += 1) {
        // Parcels tile a square grid centred on the city. The 0.92 factor
        // leaves a gap between neighbours so boundaries never overlap.
        const columns = Math.ceil(Math.sqrt(parcelsPerCity));
        const col = i % columns;
        const row = Math.floor(i / columns);
        const size = 0.004; // ~440 m at the equator

        const west = city.lng + (col - columns / 2) * size;
        const south = city.lat + (row - columns / 2) * size;
        const east = west + size * 0.92;
        const north = south + size * 0.92;

        const centreLng = (west + east) / 2;
        const centreLat = (south + north) / 2;
        const distanceKm = haversineKm(
          { lat: city.lat, lng: city.lng },
          { lat: centreLat, lng: centreLng },
        );

        const zoning = pickZoning(random);
        // Utilities thin out with distance from the centre.
        const connected = (chance: number) => random() < chance * Math.exp(-distanceKm / 6);
        const hasPower = connected(0.95);
        const hasWater = connected(0.9);
        const hasRoad = connected(0.98);
        const hasInternet = hasPower && connected(0.85);

        const inserted = await db
          .insertInto('land_parcels')
          .values({
            city_id: cityRow.id,
            region_id: regionRow.id,
            owner_id: null,
            boundary: sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)` as never,
            centroid: sql`ST_SetSRID(ST_MakePoint(${centreLng}, ${centreLat}), 4326)` as never,
            // Let PostGIS compute true area on the spheroid rather than
            // approximating from degrees.
            area_sqm:
              sql`ST_Area(ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)::geography)` as never,
            base_value: '0',
            market_value: '0',
            zoning,
            has_power: hasPower,
            has_water: hasWater,
            has_internet: hasInternet,
            has_road: hasRoad,
            for_sale: false,
          })
          .returning(['id', 'area_sqm'])
          .executeTakeFirstOrThrow();

        const marketValue = valueParcel({
          areaSqm: Number(inserted.area_sqm),
          baseRatePerSqm: city.baseRatePerSqm,
          cityPopulation: city.population,
          distanceToCentreKm: distanceKm,
          zoning,
          hasPower,
          hasWater,
          hasInternet,
          hasRoad,
        });

        const forSale = random() < forSaleRatio;

        await db
          .updateTable('land_parcels')
          .set({
            base_value: marketValue,
            market_value: marketValue,
            for_sale: forSale,
            sale_price: forSale ? marketValue : null,
          })
          .where('id', '=', inserted.id)
          .execute();

        parcelCount += 1;
      }
    }
  }

  return {
    countries: WORLD.length,
    regions: WORLD.length,
    cities: cityCount,
    parcels: parcelCount,
  };
}
