import type { Migration, MigrationProvider } from 'kysely';
import * as initialSchema from './001-initial-schema.js';
import * as paymentEventsAndAudit from './002-payment-events-and-audit.js';
import * as companiesAndEconomy from './003-companies-and-economy.js';
import * as financeAndPrices from './004-finance-and-prices.js';

/**
 * Migrations are registered statically rather than read from disk.
 *
 * Kysely's FileMigrationProvider resolves migrations by dynamic `import()` of a
 * filesystem path, which breaks under ESM on Windows and after bundling. An
 * explicit map keeps the runner portable and makes the set testable without a
 * database.
 *
 * Keys are applied in lexicographic order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001-initial-schema': initialSchema,
  '002-payment-events-and-audit': paymentEventsAndAudit,
  '003-companies-and-economy': companiesAndEconomy,
  '004-finance-and-prices': financeAndPrices,
};

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
