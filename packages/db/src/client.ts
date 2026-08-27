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
  /** Overrides the sslmode inferred from the connection string. */
  ssl?: boolean;
}

/**
 * Derives TLS settings from the connection string, following libpq's sslmode
 * semantics: `require` encrypts without verifying the certificate chain, while
 * `verify-ca` and `verify-full` demand a trusted chain.
 *
 * Managed providers (Neon, Supabase, RDS) hand out `?sslmode=require` URLs, and
 * without this the connection is refused.
 */
function sslFromConnectionString(connectionString: string): pg.PoolConfig['ssl'] {
  const match = /[?&]sslmode=([a-z-]+)/i.exec(connectionString);
  const mode = match?.[1]?.toLowerCase();

  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function createPool(config: DbConfig): pg.Pool {
  const ssl =
    config.ssl === undefined
      ? sslFromConnectionString(config.connectionString)
      : config.ssl
        ? { rejectUnauthorized: false }
        : undefined;

  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    ssl,
  });
}

export function createDb(config: DbConfig): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(config) }),
  });
}

export type Db = Kysely<Database>;
