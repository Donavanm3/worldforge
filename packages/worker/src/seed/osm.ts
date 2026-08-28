import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Road geometry from OpenStreetMap, used to cut land parcels along real streets.
 *
 * Parcels used to be a synthetic grid floating over the basemap: squares that
 * ignored the city underneath them, straddling rivers and buildings alike. The
 * street network is what actually divides land in the real world, so the seeder
 * asks OSM for it and lets PostGIS polygonize the result into city blocks.
 *
 * Overpass is a shared volunteer service. Every response is cached on disk, so
 * a re-seed costs nothing, and requests are issued one at a time with a pause
 * between them (spec 89: the game may depend on no proprietary service, and
 * being a good citizen of a free one is part of that).
 */

/** Roads that enclose blocks. Footpaths and driveways would shatter them. */
const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'pedestrian',
].join('|');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OsmOptions {
  /** Half-width of the fetched square, in metres. */
  radiusM?: number;
  cacheDir?: string;
  /** Milliseconds to wait between live requests. */
  politenessMs?: number;
  fetchImpl?: typeof fetch;
}

/** A road centreline as [lng, lat] pairs. */
export type RoadLine = Array<[number, number]>;

interface OverpassWay {
  type: string;
  geometry?: Array<{ lat: number; lon: number }>;
}

function bbox(lat: number, lng: number, radiusM: number): [number, number, number, number] {
  const latDelta = radiusM / 111_320;
  // Meridians converge toward the poles, so a metre is more degrees of
  // longitude the further from the equator you are.
  const lngDelta = radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return [lat - latDelta, lng - lngDelta, lat + latDelta, lng + lngDelta];
}

function cacheKey(name: string, lat: number, lng: number, radiusM: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${slug}-${lat.toFixed(4)}-${lng.toFixed(4)}-${radiusM}.json`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches the road network around a point, preferring a cached copy.
 *
 * Returns an empty array rather than throwing when OSM is unreachable: a seed
 * run must not fail because a volunteer server is busy. The caller falls back
 * to the synthetic grid for that city and says so.
 */
export async function fetchRoadNetwork(
  city: { name: string; lat: number; lng: number },
  options: OsmOptions = {},
): Promise<RoadLine[]> {
  const radiusM = options.radiusM ?? 1100;
  const cacheDir = options.cacheDir ?? join(process.cwd(), '.cache', 'osm');
  const doFetch = options.fetchImpl ?? fetch;
  const file = join(cacheDir, cacheKey(city.name, city.lat, city.lng, radiusM));

  try {
    return parseWays(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // No usable cache entry; fall through to the network.
  }

  const [south, west, north, east] = bbox(city.lat, city.lng, radiusM);
  const query =
    `[out:json][timeout:90];` +
    `way["highway"~"^(${ROAD_CLASSES})$"](${south},${west},${north},${east});` +
    `out geom;`;

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass asks that clients identify themselves so operators can
          // get in touch instead of silently blocking an address.
          'User-Agent': 'WorldForge/1.0 (game world seeder)',
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!response.ok) continue;

      const payload = (await response.json()) as unknown;
      const lines = parseWays(payload);
      if (lines.length === 0) continue;

      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(payload), 'utf8');
      await sleep(options.politenessMs ?? 1200);
      return lines;
    } catch {
      // Try the next mirror.
    }
  }

  return [];
}

function parseWays(payload: unknown): RoadLine[] {
  const elements = (payload as { elements?: OverpassWay[] } | null)?.elements;
  if (!Array.isArray(elements)) return [];

  const lines: RoadLine[] = [];
  for (const element of elements) {
    const geometry = element.geometry;
    if (!Array.isArray(geometry) || geometry.length < 2) continue;
    lines.push(geometry.map((point) => [point.lon, point.lat] as [number, number]));
  }
  return lines;
}
