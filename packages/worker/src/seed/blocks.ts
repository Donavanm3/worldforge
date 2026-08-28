import { sql } from 'kysely';
import type { Db } from '@wf/db';
import type { RoadLine } from './osm.js';

/**
 * Turns a road network into city blocks.
 *
 * The whole job is one PostGIS pipeline:
 *
 *   ST_Collect    gather every road centreline
 *   ST_Node       split them at their intersections, so crossings become
 *                 shared endpoints rather than lines merely overlapping
 *   ST_Polygonize find the enclosed faces of that planar graph — the blocks
 *
 * Without ST_Node the polygonizer returns nothing, because OSM ways cross each
 * other without sharing a vertex. That single call is the difference between
 * this working and silently producing zero parcels.
 */

/** Blocks smaller than this are traffic islands and slip roads, not land. */
const MIN_AREA_SQM = 400;
/** Larger faces are parks, industrial estates or unmapped countryside. */
const MAX_AREA_SQM = 20_000;

export interface Block {
  /** GeoJSON polygon geometry. */
  geojson: string;
  areaSqm: number;
  lat: number;
  lng: number;
}

export interface PolygonizeOptions {
  minAreaSqm?: number;
  maxAreaSqm?: number;
  limit?: number;
}

/**
 * Polygonizes road lines into blocks, nearest the centre first.
 *
 * Ordering by distance keeps a city's parcels contiguous around downtown
 * instead of scattered to whichever corner of the bounding box had the densest
 * street grid.
 */
export async function polygonizeBlocks(
  db: Db,
  roads: RoadLine[],
  centre: { lat: number; lng: number },
  options: PolygonizeOptions = {},
): Promise<Block[]> {
  if (roads.length === 0) return [];

  const minArea = options.minAreaSqm ?? MIN_AREA_SQM;
  const maxArea = options.maxAreaSqm ?? MAX_AREA_SQM;
  const limit = options.limit ?? 200;

  // The road set is passed as one GeoJSON MultiLineString: a single bound,
  // rather than a query whose length grows with the number of ways.
  const multiline = JSON.stringify({ type: 'MultiLineString', coordinates: roads });

  const result = await sql<{
    geojson: string;
    area_sqm: string;
    lat: string;
    lng: string;
  }>`
    with roads as (
      select st_setsrid(st_geomfromgeojson(${multiline}), 4326) as geom
    ),
    faces as (
      select (st_dump(st_polygonize(st_node(geom)))).geom as geom from roads
    ),
    measured as (
      select
        geom,
        st_area(geom::geography) as area_sqm,
        st_pointonsurface(geom) as surface
      from faces
      where st_isvalid(geom)
    )
    select
      st_asgeojson(geom) as geojson,
      area_sqm::text as area_sqm,
      st_y(surface)::text as lat,
      st_x(surface)::text as lng
    from measured
    where area_sqm between ${minArea} and ${maxArea}
    order by st_distance(
      surface::geography,
      st_setsrid(st_makepoint(${centre.lng}, ${centre.lat}), 4326)::geography
    )
    limit ${limit}
  `.execute(db);

  return result.rows.map((row) => ({
    geojson: row.geojson,
    areaSqm: Number(row.area_sqm),
    lat: Number(row.lat),
    lng: Number(row.lng),
  }));
}
