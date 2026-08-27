import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type AppConfig, type AppError, isAppError, isProduction } from '@wf/shared';
import { createDb, type Db } from '@wf/db';
import { createRedis, type Redis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { betaRoutes } from './routes/beta.js';
import { landRoutes } from './routes/land.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { PaymentProvider } from './payments/provider.js';
import { StripePaymentProvider } from './payments/stripe.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Db;
    redis: Redis;
    /** Null when payment keys are absent — the game still runs, checkout 503s. */
    paymentProvider: PaymentProvider | null;
  }
}

export interface BuildServerOptions {
  config: AppConfig;
  /** Injectable for tests; created from config when omitted. */
  db?: Db;
  redis?: Redis;
  paymentProvider?: PaymentProvider | null;
}

/**
 * Builds the configured provider, or null when keys are missing.
 *
 * A missing key must not crash the server: the rest of the game works and only
 * checkout is unavailable. In production it is logged as an error.
 */
function resolvePaymentProvider(config: AppConfig): PaymentProvider | null {
  if (config.PAYMENT_PROVIDER !== 'stripe') return null;
  if (!config.PAYMENT_SECRET_KEY || !config.PAYMENT_WEBHOOK_SECRET) return null;

  return new StripePaymentProvider({
    secretKey: config.PAYMENT_SECRET_KEY,
    webhookSecret: config.PAYMENT_WEBHOOK_SECRET,
  });
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let credentials or tokens reach the log sink.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    },
    // Behind Nginx/Cloudflare, the client IP comes from X-Forwarded-For, and
    // rate limiting is worthless without it.
    trustProxy: true,
    disableRequestLogging: false,
  });

  const db = options.db ?? createDb({ connectionString: config.DATABASE_URL });
  const redis = options.redis ?? createRedis(config);

  const paymentProvider =
    options.paymentProvider !== undefined
      ? options.paymentProvider
      : resolvePaymentProvider(config);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('paymentProvider', paymentProvider);

  if (!paymentProvider && isProduction(config)) {
    app.log.error('No payment provider configured — beta checkout will be unavailable');
  }

  await app.register(helmet, {
    // The API serves JSON only; CSP belongs on the frontend origin.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: isProduction(config) ? [config.PUBLIC_URL] : true,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Shared across processes so PM2 cluster mode can't multiply the limit.
    redis,
    keyGenerator: (request) => request.ip,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const appError: AppError | null = isAppError(error) ? error : null;
    if (appError) {
      reply.code(appError.statusCode);
      return reply.send({
        error: {
          code: appError.code,
          message: appError.message,
          details: appError.details ?? undefined,
        },
      });
    }

    if (error.statusCode === 429) {
      reply.code(429);
      return reply.send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      });
    }

    if (error.validation) {
      reply.code(400);
      return reply.send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } });
    }

    // Unexpected: log the detail, return none of it.
    request.log.error({ err: error }, 'Unhandled error');
    reply.code(500);
    return reply.send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404);
    return reply.send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(betaRoutes);
      await api.register(landRoutes);
      await api.register(adminRoutes);
      // Registered last and in its own scope so its raw-body parser stays
      // isolated from the JSON routes above.
      await api.register(webhookRoutes);
    },
    { prefix: '/api' },
  );

  app.addHook('onClose', async () => {
    await db.destroy();
    redis.disconnect();
  });

  return app;
}
