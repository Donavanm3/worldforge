import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

type Check = 'ok' | 'down';

async function checkDatabase(app: FastifyInstance): Promise<Check> {
  try {
    await sql`select 1`.execute(app.db);
    return 'ok';
  } catch {
    return 'down';
  }
}

async function checkRedis(app: FastifyInstance): Promise<Check> {
  try {
    const pong = await app.redis.ping();
    return pong === 'PONG' ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * GET /api/health — server, database, and Redis status (spec 54).
 *
 * Deliberately unauthenticated so a load balancer can poll it, and therefore it
 * must never expose connection strings, versions, or any other internal detail.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const [database, redis] = await Promise.all([checkDatabase(app), checkRedis(app)]);
    const healthy = database === 'ok' && redis === 'ok';

    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      redis,
      // The tick service lands with the economy engine; report it honestly
      // rather than claiming a green check for something that isn't running.
      gameTick: 'not_started',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });
}
