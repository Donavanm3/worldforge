import type { FastifyInstance } from 'fastify';
import {
  ForbiddenError,
  ValidationError,
  loginSchema,
  refreshSchema,
  registerSchema,
} from '@wf/shared';
import { login, logout, refresh, register } from '../auth/service.js';
import { requireAuth } from '../auth/guards.js';
import { canRegister, loadGameSettings } from '../settings.js';
import type { z } from 'zod';

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'Please correct the highlighted fields',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const sessionContext = (req: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    ipAddress: req.ip,
  });

  app.post(
    '/auth/register',
    {
      // Registration is the cheapest endpoint to abuse, so it gets the
      // tightest bucket.
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const settings = await loadGameSettings(app.db);
      if (!canRegister(settings)) {
        throw new ForbiddenError('Registration is currently closed');
      }

      const input = parse(registerSchema, request.body);
      const result = await register(app.db, app.config, input, sessionContext(request));

      reply.code(201);
      return result;
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const input = parse(loginSchema, request.body);
      return login(app.db, app.config, input, sessionContext(request));
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } },
    async (request) => {
      const input = parse(refreshSchema, request.body);
      return refresh(app.db, app.config, input.refreshToken, sessionContext(request));
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const input = parse(refreshSchema, request.body);
    await logout(app.db, input.refreshToken);
    reply.code(204);
    return null;
  });

  /** Current player, including whether they may enter the world (spec 74). */
  app.get('/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const settings = await loadGameSettings(app.db);

    const profile = await app.db
      .selectFrom('profiles')
      .select(['display_name', 'avatar_url', 'balance', 'net_worth', 'reputation'])
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    return {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        betaAccess: user.betaAccess,
      },
      profile: profile ?? null,
      game: {
        status: settings.gameStatus,
        betaPrice: settings.betaPrice,
        betaPaymentRequired: settings.betaPaymentRequired,
      },
    };
  });
}
