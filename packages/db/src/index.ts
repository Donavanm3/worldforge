export const PACKAGE_NAME = '@wf/db';

export * from './schema.js';
export { createDb, createPool, type Db, type DbConfig } from './client.js';
export {
  createMigrator,
  migrateDown,
  migrateToLatest,
  reportMigrationResults,
} from './migrator.js';
export { migrations, StaticMigrationProvider } from './migrations/index.js';
