import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchRoadNetwork } from './osm.js';

const CITY = { name: 'Testville', lat: 40.7128, lng: -74.006 };

function overpassResponse(ways: Array<Array<[number, number]>>) {
  return {
    elements: ways.map((way) => ({
      type: 'way',
      geometry: way.map(([lon, lat]) => ({ lat, lon })),
    })),
  };
}

function stubFetch(payload: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''));
    void url;
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function cacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-osm-'));
}

describe('fetchRoadNetwork', () => {
  it('converts Overpass ways into [lng, lat] lines', async () => {
    const lines = await fetchRoadNetwork(CITY, {
      cacheDir: await cacheDir(),
      politenessMs: 0,
      fetchImpl: stubFetch(
        overpassResponse([
          [
            [-74.01, 40.71],
            [-74.0, 40.72],
          ],
        ]),
      ),
    });

    expect(lines).toEqual([
      [
        [-74.01, 40.71],
        [-74.0, 40.72],
      ],
    ]);
  });

  it('drops ways with fewer than two points', async () => {
    const lines = await fetchRoadNetwork(CITY, {
      cacheDir: await cacheDir(),
      politenessMs: 0,
      fetchImpl: stubFetch(overpassResponse([[[-74.01, 40.71]]])),
    });

    expect(lines).toEqual([]);
  });

  it('caches the response so a re-seed makes no request', async () => {
    const dir = await cacheDir();
    const payload = overpassResponse([
      [
        [-74.01, 40.71],
        [-74.0, 40.72],
      ],
    ]);
    const calls: string[] = [];

    await fetchRoadNetwork(CITY, {
      cacheDir: dir,
      politenessMs: 0,
      fetchImpl: stubFetch(payload, calls),
    });
    expect(calls).toHaveLength(1);
    expect(await readdir(dir)).toHaveLength(1);

    const second = await fetchRoadNetwork(CITY, {
      cacheDir: dir,
      politenessMs: 0,
      fetchImpl: stubFetch(payload, calls),
    });
    // Still one call: the second read came from disk.
    expect(calls).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('queries a bounding box around the city', async () => {
    const calls: string[] = [];
    await fetchRoadNetwork(CITY, {
      cacheDir: await cacheDir(),
      radiusM: 1000,
      politenessMs: 0,
      fetchImpl: stubFetch(overpassResponse([]), calls),
    });

    const query = decodeURIComponent(calls[0]!);
    const bounds = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query);
    expect(bounds).not.toBeNull();

    const [south, west, north, east] = bounds!.slice(1).map(Number);
    expect(south).toBeLessThan(CITY.lat);
    expect(north).toBeGreaterThan(CITY.lat);
    expect(west).toBeLessThan(CITY.lng);
    expect(east).toBeGreaterThan(CITY.lng);
    // Longitude degrees are shorter than latitude degrees at 40°N, so the
    // box must be wider in degrees to stay square in metres.
    expect(east - west).toBeGreaterThan(north - south);
  });

  it('returns nothing rather than throwing when Overpass is unreachable', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      fetchRoadNetwork(CITY, { cacheDir: await cacheDir(), politenessMs: 0, fetchImpl: failing }),
    ).resolves.toEqual([]);
  });
});
