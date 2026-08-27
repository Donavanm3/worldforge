import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { buildServer } from '../server.js';
import type { CheckoutParams, CheckoutSession, PaymentProvider } from './provider.js';
import { parseStripeEvent, verifyStripeSignature } from './stripe.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

const WEBHOOK_SECRET = 'whsec_integration_test';

/**
 * Stands in for Stripe: real signature verification and event parsing, but
 * checkout creation is local so the suite makes no network calls.
 */
class TestPaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  lastCheckout: CheckoutParams | null = null;

  async createCheckout(params: CheckoutParams): Promise<CheckoutSession> {
    this.lastCheckout = params;
    return {
      providerPaymentId: `cs_test_${params.paymentId}`,
      url: `https://checkout.test/session/${params.paymentId}`,
    };
  }

  verifyAndParse(rawBody: Buffer, signatureHeader: string) {
    verifyStripeSignature(rawBody, signatureHeader, WEBHOOK_SECRET);
    return parseStripeEvent(rawBody);
  }
}

function signedWebhook(payload: unknown): { body: string; header: string } {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { body, header: `t=${timestamp},v1=${signature}` };
}

describe.runIf(shouldRun)('beta payments (integration)', () => {
  let app: FastifyInstance;
  let db: Db;
  let provider: TestPaymentProvider;

  const player = {
    email: 'payer@worldforge.test',
    username: 'payer',
    password: 'a-sufficiently-long-password',
  };

  let accessToken = '';
  let userId = '';

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      REDIS_URL: redisUrl!,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
      PUBLIC_URL: 'https://worldforge.test',
      LOG_LEVEL: 'silent' as never,
    });

    db = createDb({ connectionString: databaseUrl! });
    const { error } = await migrateToLatest(db);
    if (error) throw error;

    provider = new TestPaymentProvider();
    app = await buildServer({ config, db, paymentProvider: provider });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    await sql`truncate table payment_events, admin_actions, notifications, payments, sessions, profiles, users restart identity cascade`.execute(
      db,
    );

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: player,
    });
    const body = registered.json();
    accessToken = body.accessToken;
    userId = body.user.id;
  });

  async function startCheckout() {
    const response = await app.inject({
      method: 'POST',
      url: '/api/beta/checkout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return response;
  }

  async function postWebhook(payload: unknown) {
    const { body, header } = signedWebhook(payload);
    return app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      payload: body,
    });
  }

  function succeededEvent(paymentId: string, eventId = 'evt_success_1', amountTotal = 300) {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_${paymentId}`,
          payment_status: 'paid',
          amount_total: amountTotal,
          currency: 'usd',
          metadata: { paymentId, userId },
        },
      },
    };
  }

  it('exposes the beta price publicly without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/beta/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json().betaPrice).toBe('3.00');
    expect(response.json().gameStatus).toBe('BETA');
  });

  it('requires authentication to start checkout', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/beta/checkout' });
    expect(response.statusCode).toBe(401);
  });

  it('creates a pending payment charged at the configured price', async () => {
    const response = await startCheckout();
    expect(response.statusCode).toBe(200);
    expect(response.json().checkoutUrl).toContain('https://checkout.test/');

    // The price must come from game_settings, converted exactly to cents.
    expect(provider.lastCheckout?.amountMinor).toBe(300);
    expect(provider.lastCheckout?.currency).toBe('USD');

    const payment = await db.selectFrom('payments').selectAll().executeTakeFirstOrThrow();
    expect(payment.status).toBe('pending');
    expect(payment.amount).toBe('3.00');
  });

  it('does not grant access merely by creating a checkout session', async () => {
    await startCheckout();
    const user = await db
      .selectFrom('users')
      .select(['beta_access'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(user.beta_access).toBe(false);
  });

  it('grants beta access on a verified webhook', async () => {
    const checkout = await startCheckout();
    const { paymentId } = checkout.json();

    const response = await postWebhook(succeededEvent(paymentId));
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('granted');

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(user.beta_access).toBe(true);
    expect(user.access_source).toBe('payment');
    expect(user.beta_access_payment_id).toBe(paymentId);
    expect(user.beta_access_granted_at).not.toBeNull();

    const payment = await db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('completed');
    expect(payment.completed_at).not.toBeNull();
  });

  it('rejects a webhook with an invalid signature', async () => {
    const checkout = await startCheckout();
    const { paymentId } = checkout.json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/webhook',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      payload: JSON.stringify(succeededEvent(paymentId)),
    });

    expect(response.statusCode).toBe(400);
    const user = await db
      .selectFrom('users')
      .select(['beta_access'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    // A forged webhook must never grant access.
    expect(user.beta_access).toBe(false);
  });

  it('processes a replayed webhook exactly once', async () => {
    const checkout = await startCheckout();
    const { paymentId } = checkout.json();
    const event = succeededEvent(paymentId);

    const first = await postWebhook(event);
    const second = await postWebhook(event);

    expect(first.json().outcome).toBe('granted');
    expect(second.json().outcome).toBe('duplicate');
    // Still 200, so the provider stops retrying.
    expect(second.statusCode).toBe(200);

    const events = await db.selectFrom('payment_events').selectAll().execute();
    expect(events).toHaveLength(1);

    const notifications = await db
      .selectFrom('notifications')
      .selectAll()
      .where('kind', '=', 'beta_access_granted')
      .execute();
    expect(notifications).toHaveLength(1);
  });

  it('refuses to grant access when the paid amount does not match', async () => {
    const checkout = await startCheckout();
    const { paymentId } = checkout.json();

    // Someone pays 1 cent for a $3 product.
    const response = await postWebhook(succeededEvent(paymentId, 'evt_underpaid', 1));
    expect(response.json().outcome).toBe('ignored');

    const user = await db
      .selectFrom('users')
      .select(['beta_access'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(user.beta_access).toBe(false);

    const event = await db.selectFrom('payment_events').selectAll().executeTakeFirstOrThrow();
    expect(event.error).toContain('Amount mismatch');
  });

  it('marks a failed payment without granting access', async () => {
    const checkout = await startCheckout();
    const { paymentId } = checkout.json();

    const response = await postWebhook({
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1', metadata: { paymentId, userId } } },
    });

    expect(response.json().outcome).toBe('failed');
    const payment = await db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('failed');
  });

  it('blocks a second checkout once access is held', async () => {
    const checkout = await startCheckout();
    await postWebhook(succeededEvent(checkout.json().paymentId));

    const second = await startCheckout();
    expect(second.statusCode).toBe(409);
  });

  it('reports access state through /beta/access', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/beta/access',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.json().hasAccess).toBe(false);

    const checkout = await startCheckout();
    await postWebhook(succeededEvent(checkout.json().paymentId));

    const after = await app.inject({
      method: 'GET',
      url: '/api/beta/access',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.json().hasAccess).toBe(true);
    expect(after.json().latestPayment.status).toBe('completed');
  });
});

describe.runIf(shouldRun)('admin controls (integration)', () => {
  let app: FastifyInstance;
  let db: Db;
  let adminToken = '';
  let playerId = '';
  let playerToken = '';

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      REDIS_URL: redisUrl!,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
      LOG_LEVEL: 'silent' as never,
    });

    db = createDb({ connectionString: databaseUrl! });
    await migrateToLatest(db);
    app = await buildServer({ config, db, paymentProvider: null });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    await sql`truncate table payment_events, admin_actions, notifications, payments, sessions, profiles, users restart identity cascade`.execute(
      db,
    );

    const admin = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'admin@worldforge.test',
        username: 'overseer',
        password: 'a-sufficiently-long-password',
      },
    });
    await db
      .updateTable('users')
      .set({ role: 'admin' })
      .where('id', '=', admin.json().user.id)
      .execute();

    // Re-login so the token carries the admin role.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'overseer', password: 'a-sufficiently-long-password' },
    });
    adminToken = relogin.json().accessToken;

    const playerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'player@worldforge.test',
        username: 'regular',
        password: 'a-sufficiently-long-password',
      },
    });
    playerId = playerResponse.json().user.id;
    playerToken = playerResponse.json().accessToken;
  });

  const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });

  it('refuses admin routes to a regular player', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses admin routes without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings' })).statusCode).toBe(401);
  });

  it('changes the beta price at runtime', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: asAdmin(),
      payload: { betaPrice: '5.00' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().betaPrice).toBe('5.00');

    const status = await app.inject({ method: 'GET', url: '/api/beta/status' });
    expect(status.json().betaPrice).toBe('5.00');
  });

  it('rejects an invalid price', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: asAdmin(),
      payload: { betaPrice: 'free please' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('switches beta to a free release, opening the world to unpaid players', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: asAdmin(),
      payload: { gameStatus: 'RELEASED', betaPaymentRequired: false },
    });
    expect(response.statusCode).toBe(200);

    const access = await app.inject({
      method: 'GET',
      url: '/api/beta/access',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(access.json().hasAccess).toBe(true);
  });

  it('grants beta access manually and records the source', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${playerId}/beta-access`,
      headers: asAdmin(),
    });
    expect(response.statusCode).toBe(204);

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', playerId)
      .executeTakeFirstOrThrow();
    expect(user.beta_access).toBe(true);
    expect(user.access_source).toBe('admin');
    // Admin grants must not fabricate a payment record.
    expect(user.beta_access_payment_id).toBeNull();
  });

  it('writes an audit entry for every admin change', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/settings',
      headers: asAdmin(),
      payload: { gameStatus: 'MAINTENANCE' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${playerId}/beta-access`,
      headers: asAdmin(),
    });

    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: asAdmin() });
    const actions = audit.json().map((a: { action: string }) => a.action);
    expect(actions).toContain('update_settings');
    expect(actions).toContain('grant_beta_access');
  });

  it('reports payment statistics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/payments',
      headers: asAdmin(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stats).toMatchObject({ totalPurchases: 0, successful: 0 });
  });

  it('503s checkout when no payment provider is configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/beta/checkout',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(response.statusCode).toBe(503);
  });
});
