import { Migrator, type MigrationResultSet } from 'kysely';
import type { Db } from './client.js';
import { StaticMigrationProvider } from './migrations/index.js';

export function createMigrator(db: Db): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider() });
}

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest();
}

export async function migrateDown(db: Db): Promise<MigrationResultSet> {
  return createMigrator(db).migrateDown();
}

/**
 * Renders a migration run for the console and reports whether it succeeded.
 * Returns false if any migration errored so callers can set a non-zero exit code.
 */
export function reportMigrationResults({ error, results }: MigrationResultSet): boolean {
  for (const result of results ?? []) {
    const label = `${result.direction} ${result.migrationName}`;
    if (result.status === 'Success') {
      console.log(`  ok      ${label}`);
    } else if (result.status === 'Error') {
      console.error(`  FAILED  ${label}`);
    } else {
      console.log(`  skipped ${label}`);
    }
  }

  if (!results?.length && !error) {
    console.log('  no pending migrations');
  }

  if (error) {
    console.error('Migration failed:', error);
    return false;
  }
  return true;
}
