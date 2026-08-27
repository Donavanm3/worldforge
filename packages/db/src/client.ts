import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

const { Pool, types } = pg;

/**
 * Return `numeric` columns as strings instead of JS numbers.
 *
 * node-postgres parses NUMERIC into a float by default, which silently corrupts
 * money once values exceed 2^53 or carry fractional cents. Everything monetary
 * stays a string until it reaches a decimal-aware layer.
 */
types.setTypeParser(types.builtins.NUMERIC, (value) => value);
// int8 (bigint) likewise overflows a JS number; keep populations exact.
types.setTypeParser(types.builtins.INT8, (value) => value);

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
  ssl?: boolean;
}

export function createPool(config: DbConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    ssl: config.ssl === true ? { rejectUnauthorized: false } : undefined,
  });
}

export function createDb(config: DbConfig): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(config) }),
  });
}

export type Db = Kysely<Database>;
