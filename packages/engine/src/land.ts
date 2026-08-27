import type { LandZoning } from '@wf/shared';

/**
 * Land valuation (spec 3).
 *
 * Deliberately a pure function of explicit inputs: valuation drives real money
 * movement, so it must be reproducible and testable without a database. The
 * worker recomputes market values on a tick using the same code the seed uses.
 */
export interface ParcelValuationInputs {
  areaSqm: number;
  /** Base land rate for the region, in game currency per m². */
  baseRatePerSqm: number;
  cityPopulation: number;
  distanceToCentreKm: number;
  zoning: LandZoning;
  hasPower: boolean;
  hasWater: boolean;
  hasInternet: boolean;
  hasRoad: boolean;
}

const ZONING_MULTIPLIER: Readonly<Record<LandZoning, number>> = {
  unzoned: 1.0,
  agricultural: 0.6,
  infrastructure: 0.9,
  residential: 1.25,
  industrial: 1.4,
  commercial: 1.75,
};

/** Each utility a parcel is connected to adds this fraction of base value. */
const UTILITY_BONUS = {
  power: 0.18,
  water: 0.12,
  internet: 0.1,
  road: 0.15,
} as const;

/**
 * Population pressure. Logarithmic so a city ten times larger is worth more per
 * m² but not ten times more — otherwise megacities dominate every market.
 */
export function populationMultiplier(population: number): number {
  const safe = Math.max(0, population);
  return 1 + Math.log10(1 + safe) / 6;
}

/**
 * Distance decay from the city centre. Halves roughly every 8 km, floored so
 * remote land still has a floor price rather than trending to zero.
 */
export function proximityMultiplier(distanceKm: number): number {
  const safe = Math.max(0, distanceKm);
  return 0.35 + 0.65 * Math.exp(-safe / 8);
}

export function infrastructureMultiplier(inputs: {
  hasPower: boolean;
  hasWater: boolean;
  hasInternet: boolean;
  hasRoad: boolean;
}): number {
  return (
    1 +
    (inputs.hasPower ? UTILITY_BONUS.power : 0) +
    (inputs.hasWater ? UTILITY_BONUS.water : 0) +
    (inputs.hasInternet ? UTILITY_BONUS.internet : 0) +
    (inputs.hasRoad ? UTILITY_BONUS.road : 0)
  );
}

/** Rounds to 4 decimal places, matching the `numeric(20,4)` money columns. */
export function toMoneyString(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0.0000';
  return value.toFixed(4);
}

/**
 * Computes a parcel's market value as an exact money string.
 *
 * Monotonic in every input that should raise value: area, population,
 * proximity, and each utility connection.
 */
export function valueParcel(inputs: ParcelValuationInputs): string {
  const area = Math.max(0, inputs.areaSqm);
  const rate = Math.max(0, inputs.baseRatePerSqm);

  const value =
    area *
    rate *
    populationMultiplier(inputs.cityPopulation) *
    proximityMultiplier(inputs.distanceToCentreKm) *
    (ZONING_MULTIPLIER[inputs.zoning] ?? 1) *
    infrastructureMultiplier(inputs);

  return toMoneyString(value);
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres. Used for parcel-to-centre distance. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
