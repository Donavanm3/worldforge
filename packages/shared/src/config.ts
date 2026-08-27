import { z } from 'zod';

/**
 * Environment contract for every service.
 *
 * Parsed once at boot and never read from `process.env` again, so a missing or
 * malformed variable fails at startup rather than mid-request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),

  /** Public origin the game is served from. Never hard-code a domain (spec 57). */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // 32 bytes minimum. Generate with: openssl rand -base64 48
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),

  PAYMENT_PROVIDER: z.string().default('stripe'),
  PAYMENT_SECRET_KEY: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),

  // 'silent' is a real Pino level; tests use it to keep output readable.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return Object.freeze(parsed.data);
}

export function isProduction(config: AppConfig): boolean {
  return config.NODE_ENV === 'production';
}
