import { sql } from 'kysely';
import { type BoundingBox, ValidationError } from '@wf/shared';
import type { Db } from '@wf/db';
import { valueParcel } from '@wf/engine';
import { fetchRoadNetwork, polygonizeBlocks } from '@wf/worker';

/**
 * Land anywhere on Earth, cut on demand (spec 5).
 *
 * Pre-generating the planet is not an option — Earth's street network runs to
 * hundreds of millions of blocks. So the world is a fixed grid, and a tile is
 * cut into parcels the first time somebody looks at it closely. `land_tiles`
 * makes that exactly-once: the unique constraint on (tile_x, tile_y) is what
 * stops two players staring at the same street from generating it twice.
 */

/** Tile size in degrees. About 2.2 km at the equator. */
export const TILE_DEGREES = 0.02;

/** Generating a tile means an Overpass round trip, so a request does few. */
const MAX_TILES_PER_REQUEST = 4;

/** Parcels per tile. Enough to be worth having, small enough to stay quick. */
const MAX_PARCELS_PER_TILE = 120;

/** Rural land, where no seeded city is near enough to lend its rate. */
const WILDERNESS_RATE = 0.22;
const CITY_INFLUENCE_KM = 60;

export interface GenerateResult {
  tilesRequested: number;
  tilesGenerated: number;
  parcelsCreated: number;
  /** True when the area was already cut and nothing needed doing. */
  alreadyGenerated: boolean;
}

export function tileIndex(lng: number, lat: number): { x: number; y: number } {
  return {
    x: Math.floor(lng / TILE_DEGREES),
    y: Math.floor(lat / TILE_DEGREES),
  };
}

export function tileBounds(x: number, y: number): BoundingBox {
  return {
    west: x * TILE_DEGREES,
    south: y * TILE_DEGREES,
    east: (x + 1) * TILE_DEGREES,
    north: (y + 1) * TILE_DEGREES,
  };
}

/** Every tile a viewport touches, capped so one request cannot cut a continent. */
export function tilesForViewport(bbox: BoundingBox): Array<{ x: number; y: number }> {
  const min = tileIndex(bbox.west, bbox.south);
  const max = tileIndex(bbox.east, bbox.north);

  const tiles: Array<{ x: number; y: number }> = [];
  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      tiles.push({ x, y });
      if (tiles.length >= MAX_TILES_PER_REQUEST) return tiles;
    }
  }
  return tiles;
}

interface NearestCity {
  id: string;
  region_id: string;
  rate: number;
  population: number;
  distance_km: number;
}

/**
 * The seeded city closest to a point.
 *
 * Land far from any city is worth less and belongs to no region — which is
 * correct, not a gap: unincorporated land is a real thing, and governments
 * (Phase 5) will be able to claim it.
 */
async function nearestCity(db: Db, lng: number, lat: number): Promise<NearestCity | null> {
  const { rows } = await sql<NearestCity>`
    select
      cities.id,
      cities.region_id,
      cities.base_rate_per_sqm::float8 as rate,
      cities.population,
      ST_Distance(
        cities.center::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      ) / 1000 as distance_km
    from cities
    order by cities.center <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
    limit 1
  `.execute(db);

  return rows[0] ?? null;
}

/**
 * Cuts one tile into parcels.
 *
 * Claiming the tile row first is the concurrency control: `on conflict do
 * nothing` means the loser of a race inserts no row, sees no claim, and skips
 * the work rather than duplicating it.
 */
async function generateTile(db: Db, x: number, y: number): Promise<number> {
  const claim = await db
    .insertInto('land_tiles')
    .values({ tile_x: x, tile_y: y, status: 'pending' })
    .onConflict((oc) => oc.columns(['tile_x', 'tile_y']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!claim) return 0;

  const bounds = tileBounds(x, y);
  const centre = {
    lat: (bounds.south + bounds.north) / 2,
    lng: (bounds.west + bounds.east) / 2,
  };

  try {
    // Half the tile's diagonal, so the fetch covers the cell without the
    // request growing as tiles move away from the equator.
    const radiusM = (TILE_DEGREES * 111_320) / 1.6;
    const roads = await fetchRoadNetwork(
      { name: `tile-${x}-${y}`, lat: centre.lat, lng: centre.lng },
      { radiusM },
    );

    const blocks = await polygonizeBlocks(db, roads, centre, { limit: MAX_PARCELS_PER_TILE });

    if (blocks.length === 0) {
      // Ocean, desert, or simply unmapped. Recorded so it is never retried.
      await db
        .updateTable('land_tiles')
        .set({ status: 'empty', completed_at: sql`now()` })
        .where('id', '=', claim.id)
        .execute();
      return 0;
    }

    const city = await nearestCity(db, centre.lng, centre.lat);
    const nearCity = city !== null && city.distance_km <= CITY_INFLUENCE_KM;
    // Rates fade with distance rather than stepping off a cliff at the city
    // limit, so the countryside between two cities prices sensibly.
    const rate = nearCity
      ? Math.max(WILDERNESS_RATE, city.rate * Math.exp(-city.distance_km / 25)) * 0.2
      : WILDERNESS_RATE * 0.2;

    let created = 0;
    for (const block of blocks) {
      const inserted = await db
        .insertInto('land_parcels')
        .values({
          city_id: nearCity ? city.id : null,
          region_id: nearCity ? city.region_id : null,
          owner_id: null,
          boundary: sql`ST_SetSRID(ST_GeomFromGeoJSON(${block.geojson}), 4326)` as never,
          centroid: sql`ST_SetSRID(ST_MakePoint(${block.lng}, ${block.lat}), 4326)` as never,
          area_sqm: sql`${block.areaSqm}::numeric` as never,
          base_value: '0',
          market_value: '0',
          zoning: 'unzoned',
          // Utilities follow the city, not the wilderness.
          has_power: nearCity,
          has_water: nearCity,
          has_internet: nearCity && city.distance_km < 20,
          has_road: true,
          for_sale: false,
        })
        .returning(['id', 'area_sqm'])
        .executeTakeFirstOrThrow();

      const value = valueParcel({
        areaSqm: Number(inserted.area_sqm),
        baseRatePerSqm: rate,
        cityPopulation: nearCity ? Number(city.population) : 5_000,
        distanceToCentreKm: nearCity ? city.distance_km : CITY_INFLUENCE_KM,
        zoning: 'unzoned',
        hasPower: nearCity,
        hasWater: nearCity,
        hasInternet: nearCity && city.distance_km < 20,
        hasRoad: true,
      });

      // Generated land is offered by the world: unowned parcels nobody can buy
      // would make the whole feature pointless.
      await db
        .updateTable('land_parcels')
        .set({
          base_value: value,
          market_value: value,
          for_sale: true,
          sale_price: value,
        })
        .where('id', '=', inserted.id)
        .execute();

      created += 1;
    }

    await db
      .updateTable('land_tiles')
      .set({ status: 'ready', parcel_count: created, completed_at: sql`now()` })
      .where('id', '=', claim.id)
      .execute();

    return created;
  } catch (error) {
    // A failed tile is marked, not left pending: a pending row would block
    // every future attempt, and this way an operator can find and clear them.
    await db
      .updateTable('land_tiles')
      .set({ status: 'failed', completed_at: sql`now()` })
      .where('id', '=', claim.id)
      .execute();
    throw error;
  }
}

/** Largest viewport we will generate land for, in square degrees. */
const MAX_GENERATE_AREA = 0.02;

/**
 * Ensures the viewport has parcels, cutting any tile not yet done.
 *
 * Bounded deliberately: generation is slow and hits a volunteer service, so a
 * player must be zoomed into a neighbourhood, not looking at a country.
 */
export async function generateLandForViewport(db: Db, bbox: BoundingBox): Promise<GenerateResult> {
  if ((bbox.east - bbox.west) * (bbox.north - bbox.south) > MAX_GENERATE_AREA) {
    throw new ValidationError('Zoom in further to claim land here');
  }

  const tiles = tilesForViewport(bbox);
  let generated = 0;
  let parcels = 0;

  for (const tile of tiles) {
    const created = await generateTile(db, tile.x, tile.y);
    if (created > 0) {
      generated += 1;
      parcels += created;
    }
  }

  return {
    tilesRequested: tiles.length,
    tilesGenerated: generated,
    parcelsCreated: parcels,
    alreadyGenerated: generated === 0,
  };
}
