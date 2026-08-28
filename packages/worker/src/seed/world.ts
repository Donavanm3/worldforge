import { type RawBuilder, sql } from 'kysely';
import type { Db } from '@wf/db';
import type { LandZoning } from '@wf/shared';
import { haversineKm, valueParcel } from '@wf/engine';
import { WORLD } from './world-data.js';
import { type Block, polygonizeBlocks } from './blocks.js';
import { type OsmOptions, fetchRoadNetwork } from './osm.js';

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

/**
 * Below this, a city's OSM coverage is too thin to be worth using: a handful of
 * blocks would leave players with almost nothing to buy there, and mixing four
 * real blocks into a grid looks like a bug rather than a feature.
 */
const MIN_REAL_BLOCKS = 12;

/**
 * Per-square-metre discount applied to street-cut parcels.
 *
 * A city block is land you could put a row of buildings on, not a single lot.
 * Priced at the grid's rate a Manhattan block would run to six figures against
 * a 10,000 starting balance. At 0.2 the smallest blocks are pocket change, a
 * typical one is a few thousand, and a prime downtown block is a genuine
 * ambition — which is the progression the land market is meant to have.
 */
const REAL_BLOCK_RATE_SCALE = 0.2;

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
  /**
   * Cut parcels along real streets from OpenStreetMap instead of tiling a
   * synthetic grid. Off in tests, which must not touch the network.
   */
  useRealBlocks?: boolean;
  osm?: OsmOptions;
  /** Called with per-city progress; seeding 40+ cities is not quick. */
  onProgress?: (message: string) => void;
}

export interface SeedSummary {
  countries: number;
  regions: number;
  cities: number;
  parcels: number;
  /** Cities whose parcels follow the real street network. */
  citiesFromStreets: number;
}

/**
 * One parcel's geometry, expressed as SQL so PostGIS owns every measurement.
 *
 * Grid parcels and street blocks differ only in how `boundary` is built, so
 * the insert below has one shape to handle rather than two code paths.
 */
interface ParcelShape {
  boundary: RawBuilder<unknown>;
  lat: number;
  lng: number;
}

/** Real city blocks, cut from the OSM street network. */
function blockShapes(blocks: Block[]): ParcelShape[] {
  return blocks.map((block) => ({
    boundary: sql`ST_SetSRID(ST_GeomFromGeoJSON(${block.geojson}), 4326)`,
    lat: block.lat,
    lng: block.lng,
  }));
}

/**
 * The fallback grid, used where OSM has no usable street network — and it does
 * happen: informal settlements and fast-growing cities are mapped thinly.
 *
 * Squares of ~44 m at the equator, so a parcel is a city lot of roughly
 * 800-1600 m². The 0.92 factor leaves a gap so neighbours never overlap.
 */
function gridShapes(city: { lat: number; lng: number }, count: number): ParcelShape[] {
  const columns = Math.ceil(Math.sqrt(count));
  const size = 0.0004;
  const shapes: ParcelShape[] = [];

  for (let i = 0; i < count; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const west = city.lng + (col - columns / 2) * size;
    const south = city.lat + (row - columns / 2) * size;
    const east = west + size * 0.92;
    const north = south + size * 0.92;

    shapes.push({
      boundary: sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`,
      lat: (south + north) / 2,
      lng: (west + east) / 2,
    });
  }
  return shapes;
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
  const useRealBlocks = options.useRealBlocks ?? false;
  const progress = options.onProgress ?? (() => {});
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
  let regionCount = 0;
  let citiesFromStreets = 0;

  for (const country of WORLD) {
    const countryCities = country.regions.flatMap((region) => region.cities);
    const countryRow = await db
      .insertInto('countries')
      .values({
        name: country.name,
        code: country.code,
        population: countryCities.reduce((sum, c) => sum + c.population, 0),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    for (const region of country.regions) {
      const regionRow = await db
        .insertInto('regions')
        .values({
          country_id: countryRow.id,
          name: region.name,
          code: region.code,
          population: region.cities.reduce((sum, c) => sum + c.population, 0),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      regionCount += 1;

      for (const city of region.cities) {
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

        // Real blocks where OSM can supply them, the grid where it cannot.
        let shapes: ParcelShape[] = [];
        if (useRealBlocks) {
          const roads = await fetchRoadNetwork(city, options.osm);
          const blocks = await polygonizeBlocks(db, roads, city, { limit: parcelsPerCity });
          if (blocks.length >= MIN_REAL_BLOCKS) {
            shapes = blockShapes(blocks);
            citiesFromStreets += 1;
            progress(`  ${city.name}: ${shapes.length} blocks from the street network`);
          } else {
            progress(
              `  ${city.name}: only ${blocks.length} usable blocks from OSM — using the grid`,
            );
          }
        }
        const fromStreets = shapes.length > 0;
        if (!fromStreets) shapes = gridShapes(city, parcelsPerCity);

        // Real blocks average roughly ten times the area of a grid lot, and
        // land is priced per square metre — so charging the same rate would
        // put every parcel out of reach of a starting balance, which is
        // exactly the bug the grid's own rates were tuned to avoid.
        const rateScale = fromStreets ? REAL_BLOCK_RATE_SCALE : 1;

        for (const shape of shapes) {
          const centreLat = shape.lat;
          const centreLng = shape.lng;
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
              boundary: shape.boundary as never,
              // ST_PointOnSurface, not the centroid: a concave block's centroid
              // can fall outside the block itself.
              centroid: sql`ST_SetSRID(ST_MakePoint(${centreLng}, ${centreLat}), 4326)` as never,
              // Let PostGIS compute true area on the spheroid rather than
              // approximating from degrees.
              area_sqm: sql`ST_Area(${shape.boundary}::geography)` as never,
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
            baseRatePerSqm: city.baseRatePerSqm * rateScale,
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
  }

  return {
    countries: WORLD.length,
    regions: regionCount,
    cities: cityCount,
    parcels: parcelCount,
    citiesFromStreets,
  };
}
