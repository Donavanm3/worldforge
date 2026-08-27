export const PACKAGE_NAME = '@wf/worker';

export { seedWorld, type SeedOptions, type SeedSummary } from './seed/world.js';
export { seedCatalog, type CatalogSummary } from './seed/catalog.js';
export {
  runEconomyTick,
  runInterestTick,
  runPriceTick,
  runProductionTick,
  type TickResult,
} from './tick.js';
