import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Loads `.env` into the test environment.
 *
 * The integration suites gate on DATABASE_URL / REDIS_URL being present, and
 * Vitest does not read `.env` on its own — without this they silently skip even
 * when the dev database is running, which looks like a green run but proves
 * nothing. Existing variables always win, so CI's real environment is never
 * overwritten by a stray local file.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // The integration suites all share one database and truncate tables in
    // their hooks, so running files in parallel makes them clobber each
    // other. Sequential is slower but is the only correct option until each
    // suite gets its own schema.
    fileParallelism: false,
    // The integration suites migrate a real database on first use.
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
