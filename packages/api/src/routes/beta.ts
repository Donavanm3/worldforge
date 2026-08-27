import type { FastifyInstance } from 'fastify';
import { ServiceUnavailableError } from '@wf/shared';
import { requireAuth } from '../auth/guards.js';
import { createBetaCheckout } from '../payments/service.js';
import { hasWorldAccess, loadGameSettings } from '../settings.js';

export async function betaRoutes(app: FastifyInstance): Promise<void> {
  /** Public: drives the /beta landing page (spec 73). */
  app.get('/beta/status', async () => {
    const settings = await loadGameSettings(app.db);
    return {
      gameStatus: settings.gameStatus,
      betaPrice: settings.betaPrice,
      currency: 'USD',
      betaPaymentRequired: settings.betaPaymentRequired,
      registrationEnabled: settings.registrationEnabled,
      paymentsConfigured: app.paymentProvider !== null,
    };
  });

  /**
   * Starts checkout. Returns a provider URL for the browser to visit; access is
   * granted only when the webhook arrives (spec 67).
   */
  app.post(
    '/beta/checkout',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request) => {
      const provider = app.paymentProvider;
      if (!provider) {
        throw new ServiceUnavailableError('Payments are not configured');
      }

      const authUser = request.user!;
      const account = await app.db
        .selectFrom('users')
        .select(['id', 'username', 'email', 'beta_access'])
        .where('id', '=', authUser.id)
        .executeTakeFirstOrThrow();

      const result = await createBetaCheckout(app.db, provider, app.config.PUBLIC_URL, {
        id: account.id,
        username: account.username,
        email: account.email,
        betaAccess: account.beta_access,
      });

      return {
        checkoutUrl: result.url,
        paymentId: result.paymentId,
        amount: result.amount,
        currency: result.currency,
      };
    },
  );

  /**
   * Whether this player may enter the world, and why not if they may not.
   * The client uses this to choose between the game and the paywall page.
   */
  app.get('/beta/access', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const settings = await loadGameSettings(app.db);
    const allowed = hasWorldAccess(settings, user.betaAccess);

    const payment = await app.db
      .selectFrom('payments')
      .select(['id', 'status', 'amount', 'currency', 'created_at'])
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    return {
      hasAccess: allowed,
      betaAccess: user.betaAccess,
      gameStatus: settings.gameStatus,
      betaPrice: settings.betaPrice,
      betaPaymentRequired: settings.betaPaymentRequired,
      latestPayment: payment ?? null,
    };
  });
}
