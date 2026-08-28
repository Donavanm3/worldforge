export const PACKAGE_NAME = '@wf/engine';

export {
  haversineKm,
  infrastructureMultiplier,
  populationMultiplier,
  proximityMultiplier,
  toMoneyString,
  valueParcel,
  type ParcelValuationInputs,
} from './land.js';

export {
  matchOrder,
  maxBuyCost,
  scaledToString,
  sortBook,
  stringToScaled,
  type BookOrder,
  type Fill,
  type MatchResult,
} from './market.js';

export {
  DEFAULT_LABOUR_RATE,
  planProduction,
  unitCostFloor,
  type ProductionPlan,
  type RecipeSpec,
} from './production.js';

export {
  DEFAULT_PRICING,
  accrueInterest,
  imbalance,
  nextPrice,
  priceIndex,
  type PricingConfig,
} from './pricing.js';

export {
  BuildingPlanError,
  planBuilding,
  unitValue,
  type BuildingPlan,
  type BuildingPlanInput,
  type PlannedFloor,
  type PlannedUnit,
  type UnitValueInput,
} from './building.js';

