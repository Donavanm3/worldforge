import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError, isValidAmount } from '@wf/shared';
import { requireAuth, requireRole } from '../auth/guards.js';
import {
  getPaymentStats,
  grantBetaAccessManually,
  listRecentPayments,
} from '../payments/service.js';
import { loadGameSettings, setGameSetting } from '../settings.js';

const settingsPatchSchema = z
  .object({
    gameStatus: z.enum(['BETA', 'RELEASED', 'MAINTENANCE', 'REGISTRATION_CLOSED']).optional(),
    betaPrice: z.string().optional(),
    betaPaymentRequired: z.boolean().optional(),
    registrationEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No settings supplied' });

const SETTING_KEYS = {
  gameStatus: 'GAME_STATUS',
  betaPrice: 'BETA_PRICE',
  betaPaymentRequired: 'BETA_PAYMENT_REQUIRED',
  registrationEnabled: 'REGISTRATION_ENABLED',
} as const;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this scope requires an authenticated admin.
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('admin'));

  app.get('/admin/settings', async () => loadGameSettings(app.db));

  /**
   * Updates runtime settings (spec 70, 71, 78). Switching BETA -> RELEASED and
   * flipping betaPaymentRequired is how the free/paid release choice is made,
   * with no redeploy and no database wipe.
   */
  app.patch('/admin/settings', async (request) => {
    const parsed = settingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid settings',
        parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      );
    }

    const patch = parsed.data;

    if (patch.betaPrice !== undefined && !isValidAmount(patch.betaPrice, 'USD')) {
      throw new ValidationError('Beta price must be a non-negative amount like "3.00"');
    }

    const admin = request.user!;
    const before = await loadGameSettings(app.db);

    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      const value = patch[field as keyof typeof SETTING_KEYS];
      if (value === undefined) continue;
      await setGameSetting(app.db, key, String(value));
    }

    const after = await loadGameSettings(app.db);

    await app.db
      .insertInto('admin_actions')
      .values({
        admin_user_id: admin.id,
        action: 'update_settings',
        target_type: 'game_settings',
        target_id: null,
        details: JSON.stringify({ before, after }),
      })
      .execute();

    request.log.info({ adminId: admin.id, patch }, 'Admin updated game settings');
    return after;
  });

  app.get('/admin/payments', async (request) => {
    const query = request.query as { search?: string; limit?: string };
    const limit = query.limit ? Number(query.limit) : 50;

    const [stats, payments] = await Promise.all([
      getPaymentStats(app.db),
      listRecentPayments(app.db, Number.isFinite(limit) ? limit : 50, query.search),
    ]);

    return { stats, payments };
  });

  app.post('/admin/users/:userId/beta-access', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    if (!z.string().uuid().safeParse(userId).success) {
      throw new ValidationError('Invalid user id');
    }

    await grantBetaAccessManually(app.db, request.user!.id, userId);
    request.log.info({ adminId: request.user!.id, userId }, 'Admin granted beta access');

    reply.code(204);
    return null;
  });

  app.get('/admin/users/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    if (!z.string().uuid().safeParse(userId).success) {
      throw new ValidationError('Invalid user id');
    }

    const user = await app.db
      .selectFrom('users')
      .leftJoin('profiles', 'profiles.user_id', 'users.id')
      .select([
        'users.id',
        'users.username',
        'users.email',
        'users.role',
        'users.status',
        'users.beta_access',
        'users.access_source',
        'users.beta_access_granted_at',
        'users.created_at',
        'users.last_login_at',
        'profiles.display_name',
        'profiles.balance',
        'profiles.net_worth',
      ])
      .where('users.id', '=', userId)
      .executeTakeFirst();

    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  });

  /** Recent admin activity, for accountability (spec 55, 83). */
  app.get('/admin/audit', async () => {
    return app.db
      .selectFrom('admin_actions')
      .innerJoin('users', 'users.id', 'admin_actions.admin_user_id')
      .select([
        'admin_actions.id',
        'admin_actions.action',
        'admin_actions.target_type',
        'admin_actions.target_id',
        'admin_actions.created_at',
        'users.username as admin_username',
      ])
      .orderBy('admin_actions.created_at', 'desc')
      .limit(100)
      .execute();
  });
}
