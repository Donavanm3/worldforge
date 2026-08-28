import { describe, expect, it } from 'vitest';
import { WORLD } from './world-data.js';

const cities = WORLD.flatMap((country) =>
  country.regions.flatMap((region) =>
    region.cities.map((city) => ({ ...city, country: country.name, region: region.name })),
  ),
);

describe('world data', () => {
  it('places every city on the globe', () => {
    for (const city of cities) {
      expect(Math.abs(city.lat), `${city.name} latitude`).toBeLessThanOrEqual(90);
      expect(Math.abs(city.lng), `${city.name} longitude`).toBeLessThanOrEqual(180);
    }
  });

  it('has no duplicate country or region codes', () => {
    const countryCodes = WORLD.map((c) => c.code);
    expect(new Set(countryCodes).size).toBe(countryCodes.length);

    const regionCodes = WORLD.flatMap((c) => c.regions.map((r) => r.code));
    expect(new Set(regionCodes).size).toBe(regionCodes.length);
  });

  it('keeps land rates inside the balanced band', () => {
    // Outside this range parcels are either free or unbuyable on a starting
    // balance, which is what the pre-launch valuation bug did (see land tests).
    for (const city of cities) {
      expect(city.baseRatePerSqm, `${city.name} rate`).toBeGreaterThanOrEqual(0.3);
      expect(city.baseRatePerSqm, `${city.name} rate`).toBeLessThanOrEqual(1.7);
    }
  });

  it('gives every city a population', () => {
    for (const city of cities) {
      expect(city.population, `${city.name} population`).toBeGreaterThan(0);
    }
  });

  it('spans both hemispheres so play is not concentrated in one timezone', () => {
    expect(cities.some((c) => c.lat > 0)).toBe(true);
    expect(cities.some((c) => c.lat < 0)).toBe(true);
    expect(cities.some((c) => c.lng > 90)).toBe(true);
    expect(cities.some((c) => c.lng < -90)).toBe(true);
  });
});
