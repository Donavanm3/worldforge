import { sql } from 'kysely';
import { ConflictError, NotFoundError, ValidationError, toMinorUnits } from '@wf/shared';
import type { Db, Payment } from '@wf/db';
import type { ParsedPaymentEvent, PaymentProvider } from './provider.js';
import { loadGameSettings } from '../settings.js';

export interface CheckoutResult {
  paymentId: string;
  url: string;
  amount: string;
  currency: string;
}

const BETA_CURRENCY = 'USD';

/**
 * Creates a pending payment row and a provider checkout session.
 *
 * The price comes from `game_settings` at request time, never from the client
 * and never from a constant (spec 70, 78).
 */
export async function createBetaCheckout(
  db: Db,
  provider: PaymentProvider,
  publicUrl: string,
  user: { id: string; username: string; email: string; betaAccess: boolean },
): Promise<CheckoutResult> {
  if (user.betaAccess) {
    throw new ConflictError('You already have beta access');
  }

  const settings = await loadGameSettings(db);
  if (!settings.betaPaymentRequired) {
    throw new ConflictError('Beta access does not currently require payment');
  }

  const amountMinor = toMinorUnits(settings.betaPrice, BETA_CURRENCY);
  if (amountMinor <= 0) {
    throw new ValidationError('Beta access price is not configured for payment');
  }

  const payment = await db
    .insertInto('payments')
    .values({
      user_id: user.id,
      provider: provider.name,
      amount: settings.betaPrice,
      currency: BETA_CURRENCY,
      status: 'pending',
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const session = await provider.createCheckout({
    paymentId: payment.id,
    userId: user.id,
    username: user.username,
    email: user.email,
    amountMinor,
    currency: BETA_CURRENCY,
    // These only drive the browser redirect. Access is granted by the webhook
    // alone — reaching the success URL proves nothing (spec 67).
    successUrl: `${publicUrl}/beta/success`,
    cancelUrl: `${publicUrl}/beta`,
    productName: 'WorldForge Beta Access',
  });

  await db
    .updateTable('payments')
    .set({ provider_payment_id: session.providerPaymentId })
    .where('id', '=', payment.id)
    .execute();

  return {
    paymentId: payment.id,
    url: session.url,
    amount: settings.betaPrice,
    currency: BETA_CURRENCY,
  };
}

export type WebhookOutcome = 'granted' | 'duplicate' | 'ignored' | 'failed' | 'refunded';

/**
 * Applies a verified webhook event.
 *
 * Idempotency comes from inserting into `payment_events` first: the unique
 * (provider, provider_event_id) index means a replayed delivery takes the
 * duplicate branch and grants nothing a second time.
 */
export async function processPaymentEvent(
  db: Db,
  providerName: string,
  event: ParsedPaymentEvent,
): Promise<WebhookOutcome> {
  const inserted = await db
    .insertInto('payment_events')
    .values({
      provider: providerName,
      provider_event_id: event.providerEventId,
      event_type: event.type,
      payment_id: event.paymentId,
      payload: JSON.stringify(event.raw),
    })
    .onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    return 'duplicate';
  }

  const markProcessed = async (error?: string) => {
    await db
      .updateTable('payment_events')
      .set({ processed_at: new Date(), error: error ?? null })
      .where('id', '=', inserted.id)
      .execute();
  };

  if (event.type === 'ignored' || !event.paymentId) {
    await markProcessed(event.paymentId ? undefined : 'No paymentId in event metadata');
    return 'ignored';
  }

  const payment = await db
    .selectFrom('payments')
    .selectAll()
    .where('id', '=', event.paymentId)
    .executeTakeFirst();

  if (!payment) {
    await markProcessed('Unknown paymentId');
    return 'ignored';
  }

  if (event.type === 'failed') {
    await db
      .updateTable('payments')
      .set({ status: 'failed' })
      .where('id', '=', payment.id)
      .where('status', '=', 'pending')
      .execute();
    await markProcessed();
    return 'failed';
  }

  if (event.type === 'refunded') {
    await db
      .updateTable('payments')
      .set({ status: 'refunded' })
      .where('id', '=', payment.id)
      .execute();
    // Beta access is deliberately NOT revoked here — that is an admin decision
    // (spec 79), not an automatic consequence of a refund.
    await markProcessed();
    return 'refunded';
  }

  // Guard against a tampered or mismatched amount before granting anything.
  const expectedMinor = toMinorUnits(payment.amount, payment.currency);
  if (event.amountMinor !== null && event.amountMinor !== expectedMinor) {
    await markProcessed(
      `Amount mismatch: expected ${expectedMinor}, received ${event.amountMinor}`,
    );
    return 'ignored';
  }

  await grantBetaAccessForPayment(db, payment, event.providerPaymentId);
  await markProcessed();
  return 'granted';
}

async function grantBetaAccessForPayment(
  db: Db,
  payment: Payment,
  providerPaymentId: string | null,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('payments')
      .set({
        status: 'completed',
        completed_at: new Date(),
        ...(providerPaymentId ? { provider_payment_id: providerPaymentId } : {}),
      })
      .where('id', '=', payment.id)
      .execute();

    // Only flip accounts that do not already have access, so a second grant
    // cannot overwrite an earlier granted_at or access_source.
    await trx
      .updateTable('users')
      .set({
        beta_access: true,
        beta_access_granted_at: new Date(),
        beta_access_payment_id: payment.id,
        access_source: 'payment',
        // Database clock, so updated_at stays consistent across app instances.
        updated_at: sql`now()`,
      })
      .where('id', '=', payment.user_id)
      .where('beta_access', '=', false)
      .execute();

    await trx
      .insertInto('notifications')
      .values({
        user_id: payment.user_id,
        kind: 'beta_access_granted',
        title: 'Welcome to WorldForge',
        body: 'Your beta access is active. Choose a starting location to begin.',
      })
      .execute();
  });
}

/** Admin-granted access (spec 75). Records `access_source = 'admin'`. */
export async function grantBetaAccessManually(
  db: Db,
  adminUserId: string,
  targetUserId: string,
): Promise<void> {
  const target = await db
    .selectFrom('users')
    .select(['id', 'beta_access'])
    .where('id', '=', targetUserId)
    .executeTakeFirst();

  if (!target) {
    throw new NotFoundError('User not found');
  }
  if (target.beta_access) {
    throw new ConflictError('User already has beta access');
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({
        beta_access: true,
        beta_access_granted_at: new Date(),
        access_source: 'admin',
        // Database clock, so updated_at stays consistent across app instances.
        updated_at: sql`now()`,
      })
      .where('id', '=', targetUserId)
      .execute();

    await trx
      .insertInto('admin_actions')
      .values({
        admin_user_id: adminUserId,
        action: 'grant_beta_access',
        target_type: 'user',
        target_id: targetUserId,
      })
      .execute();

    await trx
      .insertInto('notifications')
      .values({
        user_id: targetUserId,
        kind: 'beta_access_granted',
        title: 'Welcome to WorldForge',
        body: 'An administrator granted you beta access.',
      })
      .execute();
  });
}

export interface PaymentStats {
  totalPurchases: number;
  totalRevenue: string;
  successful: number;
  pending: number;
  failed: number;
  refunded: number;
}

/** Aggregates for the admin payment dashboard (spec 77). */
export async function getPaymentStats(db: Db): Promise<PaymentStats> {
  const rows = await db
    .selectFrom('payments')
    .select(['status'])
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .select((eb) => eb.fn.sum<string>('amount').as('total'))
    .groupBy('status')
    .execute();

  const byStatus = new Map(rows.map((r) => [r.status, r]));
  const completed = byStatus.get('completed');

  return {
    totalPurchases: Number(completed?.count ?? 0),
    totalRevenue: completed?.total ?? '0',
    successful: Number(completed?.count ?? 0),
    pending: Number(byStatus.get('pending')?.count ?? 0),
    failed: Number(byStatus.get('failed')?.count ?? 0),
    refunded: Number(byStatus.get('refunded')?.count ?? 0),
  };
}

export async function listRecentPayments(db: Db, limit = 50, search?: string) {
  let query = db
    .selectFrom('payments')
    .innerJoin('users', 'users.id', 'payments.user_id')
    .select([
      'payments.id',
      'payments.amount',
      'payments.currency',
      'payments.status',
      'payments.provider',
      'payments.provider_payment_id',
      'payments.created_at',
      'payments.completed_at',
      'users.username',
      'users.id as user_id',
    ])
    .orderBy('payments.created_at', 'desc')
    .limit(Math.min(limit, 200));

  if (search) {
    const term = `%${search.toLowerCase()}%`;
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`lower(users.username)`, 'like', term),
        eb(sql<string>`payments.id::text`, 'like', term),
        eb(sql<string>`coalesce(payments.provider_payment_id, '')`, 'like', term),
      ]),
    );
  }

  return query.execute();
}
