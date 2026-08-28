import type { BuildingType, UnitUse } from '@wf/shared';

/**
 * Construction planning (spec 14-16).
 *
 * Pure arithmetic over plain numbers: the engine never touches the database and
 * never sees a query. Money crosses back into PostgreSQL as a decimal string,
 * so every figure here is rounded to whole currency units before it leaves.
 */

/** Build cost per square metre of floor area, before the height premium. */
const COST_PER_SQM: Record<BuildingType, number> = {
  residential: 42,
  office: 58,
  retail: 50,
  industrial: 28,
  mixed_use: 52,
  civic: 64,
};

/**
 * Floors above ground level cost more than the one below: deeper foundations,
 * structure, lifts, and pumping water upward. 1.5% compounding lands a
 * 40-storey tower at roughly 1.8x the per-square-metre cost of a bungalow,
 * which is close to the real premium and, more importantly, makes height a
 * decision rather than an automatic yes.
 */
const HEIGHT_PREMIUM = 0.015;

/** Circulation: lifts, stairs, plant. Not sellable, but you pay to build it. */
const CORE_FRACTION = 0.18;

/** A building can cover only so much of its plot. */
const MAX_SITE_COVERAGE = 0.7;

/** Real time from breaking ground to handover. */
const BASE_BUILD_MINUTES = 20;
const MINUTES_PER_FLOOR = 4;

/** Target unit sizes, by use. Actual sizes divide the floor evenly. */
const TARGET_UNIT_SQM: Record<UnitUse, number> = {
  apartment: 85,
  office: 120,
  shop: 95,
  workshop: 150,
  storage: 60,
};

/**
 * How each building type stacks uses by floor. Retail wants the street; homes
 * and offices want to be above it.
 */
const FLOOR_PLAN: Record<BuildingType, { ground: UnitUse; upper: UnitUse }> = {
  residential: { ground: 'apartment', upper: 'apartment' },
  office: { ground: 'office', upper: 'office' },
  retail: { ground: 'shop', upper: 'shop' },
  industrial: { ground: 'workshop', upper: 'storage' },
  mixed_use: { ground: 'shop', upper: 'apartment' },
  civic: { ground: 'office', upper: 'office' },
};

export interface BuildingPlanInput {
  /** Area of the parcel being built on. */
  parcelAreaSqm: number;
  /** Ground area the building covers. */
  footprintSqm: number;
  floors: number;
  type: BuildingType;
  /** The parcel's land rate, so expensive districts cost more to build in. */
  landRatePerSqm?: number;
}

export interface PlannedUnit {
  label: string;
  areaSqm: number;
  use: UnitUse;
  /** Indicative resale value, used as the unit's opening market value. */
  marketValue: number;
}

export interface PlannedFloor {
  level: number;
  floorAreaSqm: number;
  use: UnitUse;
  units: PlannedUnit[];
}

export interface BuildingPlan {
  constructionCost: number;
  buildMinutes: number;
  grossFloorAreaSqm: number;
  /** Floor area actually available as units, after the service core. */
  netFloorAreaSqm: number;
  floors: PlannedFloor[];
  unitCount: number;
}

export class BuildingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildingPlanError';
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Costs a building and lays out its floors and units.
 *
 * Throws rather than clamping on an impossible brief: silently shrinking a
 * player's 40-storey tower to fit would charge them for something they did not
 * ask for.
 */
export function planBuilding(input: BuildingPlanInput): BuildingPlan {
  const { parcelAreaSqm, footprintSqm, floors, type } = input;
  const landRate = input.landRatePerSqm ?? 1;

  if (!Number.isInteger(floors) || floors < 1 || floors > 120) {
    throw new BuildingPlanError('A building must have between 1 and 120 floors.');
  }
  if (!(footprintSqm > 0) || !(parcelAreaSqm > 0)) {
    throw new BuildingPlanError('Footprint and parcel area must both be positive.');
  }
  if (footprintSqm > parcelAreaSqm * MAX_SITE_COVERAGE) {
    throw new BuildingPlanError(
      `A building may cover at most ${Math.round(MAX_SITE_COVERAGE * 100)}% of its parcel.`,
    );
  }

  const plan = FLOOR_PLAN[type];
  const grossFloorArea = footprintSqm * floors;
  const usableFloorArea = footprintSqm * (1 - CORE_FRACTION);

  // Each floor costs the base rate compounded by how high it sits.
  let constructionCost = 0;
  for (let level = 0; level < floors; level += 1) {
    constructionCost += footprintSqm * COST_PER_SQM[type] * (1 + HEIGHT_PREMIUM) ** level;
  }
  // Land value carries into build cost: labour and logistics are dearer where
  // land is dear, and it stops prime plots being cheap to develop.
  constructionCost *= 0.75 + 0.25 * landRate;

  const plannedFloors: PlannedFloor[] = [];
  let unitCount = 0;

  for (let level = 0; level < floors; level += 1) {
    const use = level === 0 ? plan.ground : plan.upper;
    const target = TARGET_UNIT_SQM[use];
    // At least one unit per floor, however small the footprint.
    const unitsOnFloor = Math.max(1, Math.round(usableFloorArea / target));
    const unitArea = usableFloorArea / unitsOnFloor;

    const units: PlannedUnit[] = [];
    for (let index = 0; index < unitsOnFloor; index += 1) {
      units.push({
        // 0-04 reads as "ground floor, fourth unit" the way real addresses do.
        label: `${level}-${String(index + 1).padStart(2, '0')}`,
        areaSqm: round(unitArea),
        use,
        marketValue: round(unitValue({ areaSqm: unitArea, use, level, landRatePerSqm: landRate })),
      });
    }

    plannedFloors.push({
      level,
      floorAreaSqm: round(usableFloorArea),
      use,
      units,
    });
    unitCount += units.length;
  }

  return {
    constructionCost: round(constructionCost),
    buildMinutes: BASE_BUILD_MINUTES + MINUTES_PER_FLOOR * floors,
    grossFloorAreaSqm: round(grossFloorArea),
    netFloorAreaSqm: round(usableFloorArea * floors),
    floors: plannedFloors,
    unitCount,
  };
}

/** Resale value per unit, by use, at ground level. */
const VALUE_PER_SQM: Record<UnitUse, number> = {
  apartment: 78,
  office: 96,
  shop: 130,
  workshop: 44,
  storage: 30,
};

export interface UnitValueInput {
  areaSqm: number;
  use: UnitUse;
  level: number;
  landRatePerSqm?: number;
}

/**
 * What a finished unit is worth.
 *
 * Height cuts both ways in reality — shops want the street, flats want the
 * view — so retail loses value as it climbs while homes and offices gain.
 */
export function unitValue(input: UnitValueInput): number {
  const landRate = input.landRatePerSqm ?? 1;
  const base = input.areaSqm * VALUE_PER_SQM[input.use];

  const heightFactor =
    input.use === 'shop'
      ? Math.max(0.55, 1 - 0.08 * input.level)
      : Math.min(1.6, 1 + 0.012 * input.level);

  return round(base * heightFactor * (0.6 + 0.4 * landRate));
}
