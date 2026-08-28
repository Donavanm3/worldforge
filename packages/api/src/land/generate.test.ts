import { describe, expect, it } from 'vitest';
import { TILE_DEGREES, tileBounds, tileIndex, tilesForViewport } from './generate.js';

describe('the worldwide land grid', () => {
  it('puts a point inside the tile it indexes to', () => {
    const points = [
      { lng: -74.006, lat: 40.7128 },
      { lng: 139.6503, lat: 35.6762 },
      { lng: -0.1276, lat: 51.5072 },
      { lng: 18.4241, lat: -33.9249 },
      { lng: 0, lat: 0 },
    ];

    for (const point of points) {
      const { x, y } = tileIndex(point.lng, point.lat);
      const bounds = tileBounds(x, y);
      expect(point.lng, `${point.lng} within tile`).toBeGreaterThanOrEqual(bounds.west);
      expect(point.lng).toBeLessThan(bounds.east);
      expect(point.lat).toBeGreaterThanOrEqual(bounds.south);
      expect(point.lat).toBeLessThan(bounds.north);
    }
  });

  it('gives negative coordinates their own tiles rather than folding them onto positive ones', () => {
    // Math.trunc would map -0.01 and 0.01 to the same tile, silently merging
    // opposite sides of the equator and the prime meridian.
    expect(tileIndex(-0.01, -0.01)).not.toEqual(tileIndex(0.01, 0.01));
  });

  it('tiles the same area to the same indices every time', () => {
    expect(tileIndex(2.3522, 48.8566)).toEqual(tileIndex(2.3523, 48.8567));
  });

  it('covers a small viewport with the tiles it touches', () => {
    const tiles = tilesForViewport({
      west: 0,
      south: 0,
      east: TILE_DEGREES * 1.5,
      north: 0 + 0.001,
    });
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles).toContainEqual({ x: 0, y: 0 });
    expect(tiles).toContainEqual({ x: 1, y: 0 });
  });

  it('caps how many tiles one request can generate', () => {
    // A whole-country viewport must not turn into thousands of Overpass calls.
    const tiles = tilesForViewport({ west: -10, south: 40, east: 10, north: 55 });
    expect(tiles.length).toBeLessThanOrEqual(4);
  });

  it('produces tiles of the declared size', () => {
    const bounds = tileBounds(5, -3);
    expect(bounds.east - bounds.west).toBeCloseTo(TILE_DEGREES, 10);
    expect(bounds.north - bounds.south).toBeCloseTo(TILE_DEGREES, 10);
  });
});
