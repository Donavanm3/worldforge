import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { polygonizeBlocks } from './blocks.js';
import type { RoadLine } from './osm.js';

const databaseUrl = process.env['DATABASE_URL'];
const shouldRun = Boolean(databaseUrl);

/**
 * A 3x3 lattice of streets near the equator, where a degree of longitude and a
 * degree of latitude are nearly the same length. 0.002° is about 222 m, so the
 * four enclosed blocks are roughly 49,000 m² each.
 */
function lattice(step = 0.002, lines = 3): RoadLine[] {
  const roads: RoadLine[] = [];
  const end = step * (lines - 1);

  for (let i = 0; i < lines; i += 1) {
    const offset = step * i;
    roads.push([
      [0, offset],
      [end, offset],
    ]);
    roads.push([
      [offset, 0],
      [offset, end],
    ]);
  }
  return roads;
}

describe.runIf(shouldRun)('polygonizeBlocks (integration)', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb({ connectionString: databaseUrl! });
    await migrateToLatest(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('finds the blocks enclosed by a street grid', async () => {
    const blocks = await polygonizeBlocks(
      db,
      lattice(),
      { lat: 0.002, lng: 0.002 },
      {
        maxAreaSqm: 100_000,
      },
    );

    // A 3x3 lattice encloses four faces.
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      expect(block.areaSqm).toBeGreaterThan(40_000);
      expect(block.areaSqm).toBeLessThan(60_000);
      expect(JSON.parse(block.geojson).type).toBe('Polygon');
    }
  });

  it('places every representative point inside its own block', async () => {
    const blocks = await polygonizeBlocks(
      db,
      lattice(),
      { lat: 0, lng: 0 },
      {
        maxAreaSqm: 100_000,
      },
    );

    for (const block of blocks) {
      const { rows } = await sql<{ inside: boolean }>`
        select ST_Contains(
          ST_SetSRID(ST_GeomFromGeoJSON(${block.geojson}), 4326),
          ST_SetSRID(ST_MakePoint(${block.lng}, ${block.lat}), 4326)
        ) as inside
      `.execute(db);
      expect(rows[0]?.inside).toBe(true);
    }
  });

  it('rejects slivers and oversized faces by area', async () => {
    // The same lattice, asking only for blocks far larger than it produces.
    const none = await polygonizeBlocks(
      db,
      lattice(),
      { lat: 0, lng: 0 },
      {
        minAreaSqm: 1_000_000,
      },
    );
    expect(none).toEqual([]);
  });

  it('returns nothing when there are no roads', async () => {
    expect(await polygonizeBlocks(db, [], { lat: 0, lng: 0 })).toEqual([]);
  });

  it('orders blocks by distance from the city centre', async () => {
    const blocks = await polygonizeBlocks(
      db,
      lattice(),
      { lat: 0, lng: 0 },
      {
        maxAreaSqm: 100_000,
      },
    );

    const distances = blocks.map((block) => Math.hypot(block.lat, block.lng));
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });
});
