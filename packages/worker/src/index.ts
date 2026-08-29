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

// Used by the API to cut land on demand anywhere in the world.
export { fetchRoadNetwork, type OsmOptions, type RoadLine } from './seed/osm.js';
export { polygonizeBlocks, type Block, type PolygonizeOptions } from './seed/blocks.js';

export { refreshBuildingEconomics, runRevenueTick, type RevenueResult } from './revenue.js';
export { seedNpcLandlords, type NpcSeedSummary } from './seed/landlords.js';
