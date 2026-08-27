import { describe, expect, it } from 'vitest';
import type { LandZoning } from '@wf/shared';
import {
  haversineKm,
  infrastructureMultiplier,
  populationMultiplier,
  proximityMultiplier,
  toMoneyString,
  valueParcel,
  type ParcelValuationInputs,
} from './land.js';

const base: ParcelValuationInputs = {
  areaSqm: 1000,
  baseRatePerSqm: 5,
  cityPopulation: 100_000,
  distanceToCentreKm: 5,
  zoning: 'unzoned',
  hasPower: false,
  hasWater: false,
  hasInternet: false,
  hasRoad: false,
};

const value = (overrides: Partial<ParcelValuationInputs> = {}) =>
  Number(valueParcel({ ...base, ...overrides }));

describe('valueParcel', () => {
  it('returns an exact money string with 4 decimals', () => {
    expect(valueParcel(base)).toMatch(/^\d+\.\d{4}$/);
  });

  // Results are rounded to 4dp, so doubling an input can differ from double the
  // rounded output by one unit in the last place. Assert to 3dp accordingly.
  it('scales linearly with area', () => {
    expect(value({ areaSqm: 2000 })).toBeCloseTo(value({ areaSqm: 1000 }) * 2, 3);
  });

  it('scales linearly with the base rate', () => {
    expect(value({ baseRatePerSqm: 10 })).toBeCloseTo(value({ baseRatePerSqm: 5 }) * 2, 3);
  });

  it('is worth more closer to the city centre', () => {
    expect(value({ distanceToCentreKm: 1 })).toBeGreaterThan(value({ distanceToCentreKm: 20 }));
  });

  it('is worth more in a larger city', () => {
    expect(value({ cityPopulation: 5_000_000 })).toBeGreaterThan(value({ cityPopulation: 1_000 }));
  });

  it('never decreases when a utility is connected', () => {
    const none = value();
    for (const utility of ['hasPower', 'hasWater', 'hasInternet', 'hasRoad'] as const) {
      expect(value({ [utility]: true }), utility).toBeGreaterThan(none);
    }
    expect(
      value({ hasPower: true, hasWater: true, hasInternet: true, hasRoad: true }),
    ).toBeGreaterThan(none);
  });

  it('prices commercial above residential above agricultural', () => {
    const byZoning = (zoning: LandZoning) => value({ zoning });
    expect(byZoning('commercial')).toBeGreaterThan(byZoning('residential'));
    expect(byZoning('residential')).toBeGreaterThan(byZoning('unzoned'));
    expect(byZoning('unzoned')).toBeGreaterThan(byZoning('agricultural'));
  });

  it('returns zero for zero area or zero rate', () => {
    expect(valueParcel({ ...base, areaSqm: 0 })).toBe('0.0000');
    expect(valueParcel({ ...base, baseRatePerSqm: 0 })).toBe('0.0000');
  });

  it('clamps negative inputs to zero rather than producing negative money', () => {
    expect(Number(valueParcel({ ...base, areaSqm: -500 }))).toBe(0);
    expect(Number(valueParcel({ ...base, baseRatePerSqm: -5 }))).toBe(0);
  });

  it('is deterministic', () => {
    expect(valueParcel(base)).toBe(valueParcel(base));
  });
});

describe('populationMultiplier', () => {
  it('increases with population but sublinearly', () => {
    expect(populationMultiplier(0)).toBe(1);
    expect(populationMultiplier(1_000_000)).toBeGreaterThan(populationMultiplier(1_000));
    // Ten times the people must not mean ten times the multiplier.
    expect(populationMultiplier(1_000_000)).toBeLessThan(populationMultiplier(100_000) * 2);
  });

  it('treats negative population as zero', () => {
    expect(populationMultiplier(-100)).toBe(1);
  });
});

describe('proximityMultiplier', () => {
  it('decays with distance and stays above the floor', () => {
    expect(proximityMultiplier(0)).toBeCloseTo(1, 5);
    expect(proximityMultiplier(8)).toBeLessThan(proximityMultiplier(0));
    expect(proximityMultiplier(10_000)).toBeGreaterThan(0.34);
  });
});

describe('infrastructureMultiplier', () => {
  it('is 1 with nothing connected and additive thereafter', () => {
    const none = { hasPower: false, hasWater: false, hasInternet: false, hasRoad: false };
    expect(infrastructureMultiplier(none)).toBe(1);
    expect(infrastructureMultiplier({ ...none, hasPower: true, hasRoad: true })).toBeCloseTo(
      1.33,
      5,
    );
  });
});

describe('toMoneyString', () => {
  it('formats to four decimals', () => {
    expect(toMoneyString(3)).toBe('3.0000');
    expect(toMoneyString(1234.56789)).toBe('1234.5679');
  });

  it('never emits negative or non-finite money', () => {
    expect(toMoneyString(-5)).toBe('0.0000');
    expect(toMoneyString(Number.NaN)).toBe('0.0000');
    expect(toMoneyString(Number.POSITIVE_INFINITY)).toBe('0.0000');
  });
});

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0);
  });

  it('matches a known distance (London to Paris ~344 km)', () => {
    const distance = haversineKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    expect(distance).toBeGreaterThan(330);
    expect(distance).toBeLessThan(350);
  });

  it('is symmetric', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: -30, lng: 100 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
});
