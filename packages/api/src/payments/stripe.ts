import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type CheckoutParams,
  type CheckoutSession,
  type ParsedPaymentEvent,
  type PaymentProvider,
  PaymentProviderError,
  WebhookVerificationError,
} from './provider.js';

const API_BASE = 'https://api.stripe.com/v1';

/** Deliveries older than this are rejected to blunt replay attacks. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

/**
 * Parses Stripe's `Stripe-Signature` header: `t=<ts>,v1=<sig>,v1=<sig>`.
 * Multiple v1 entries occur while a webhook secret is being rotated.
 */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }

  return { timestamp, signatures };
}

function constantTimeIncludes(candidates: string[], expected: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  let matched = false;
  // Check every candidate rather than short-circuiting, so timing does not
  // reveal which signature matched.
  for (const candidate of candidates) {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Verifies a Stripe webhook signature over the raw request bytes.
 *
 * Implemented directly rather than via the SDK because this is the security
 * boundary for granting paid access, and it must be unit-testable without
 * network or SDK stubs.
 *
 * @param nowSeconds injectable clock, for tests
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  webhookSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError('Malformed signature header');
  }

  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('Signature timestamp outside tolerance');
  }

  // The signed payload is the timestamp and the raw body, joined by a period.
  // Re-serialising parsed JSON here would break verification.
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

  if (!constantTimeIncludes(signatures, expected)) {
    throw new WebhookVerificationError();
  }
}

interface StripeEventShape {
  id?: unknown;
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}

export function parseStripeEvent(rawBody: Buffer): ParsedPaymentEvent {
  let event: StripeEventShape;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as StripeEventShape;
  } catch {
    throw new WebhookVerificationError('Webhook body is not valid JSON');
  }

  if (typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw new WebhookVerificationError('Webhook body is missing id or type');
  }

  const object = event.data?.object ?? {};
  const metadata = (object['metadata'] as Record<string, unknown> | undefined) ?? {};

  const type: ParsedPaymentEvent['type'] =
    event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded'
      ? 'succeeded'
      : event.type === 'payment_intent.payment_failed' ||
          event.type === 'checkout.session.async_payment_failed'
        ? 'failed'
        : event.type === 'charge.refunded'
          ? 'refunded'
          : 'ignored';

  // A completed Checkout Session is only actually paid when payment_status says
  // so; a session can complete with payment still pending.
  const paymentStatus = object['payment_status'];
  const settled =
    type !== 'succeeded' ||
    paymentStatus === undefined ||
    paymentStatus === 'paid' ||
    paymentStatus === 'no_payment_required';

  return {
    providerEventId: event.id,
    type: settled ? type : 'ignored',
    providerPaymentId: typeof object['id'] === 'string' ? object['id'] : null,
    paymentId: typeof metadata['paymentId'] === 'string' ? metadata['paymentId'] : null,
    userId: typeof metadata['userId'] === 'string' ? metadata['userId'] : null,
    amountMinor:
      typeof object['amount_total'] === 'number'
        ? object['amount_total']
        : typeof object['amount'] === 'number'
          ? object['amount']
          : null,
    currency: typeof object['currency'] === 'string' ? object['currency'].toUpperCase() : null,
    raw: event,
  };
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(private readonly config: StripeConfig) {}

  async createCheckout(params: CheckoutParams): Promise<CheckoutSession> {
    // Form-encoded per Stripe's API. Using fetch avoids pulling in the SDK for
    // what is a single request.
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.email,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': params.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(params.amountMinor),
      'line_items[0][price_data][product_data][name]': params.productName,
      // Round-tripped back to us on the webhook; this is how a payment is
      // attributed without trusting anything the browser sends.
      'metadata[paymentId]': params.paymentId,
      'metadata[userId]': params.userId,
      'payment_intent_data[metadata][paymentId]': params.paymentId,
      'payment_intent_data[metadata][userId]': params.userId,
    });

    const response = await fetch(`${API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Makes a retried checkout return the same session instead of a second one.
        'Idempotency-Key': params.paymentId,
      },
      body: form,
    });

    const body = (await response.json()) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    };

    if (!response.ok || !body.id || !body.url) {
      throw new PaymentProviderError(
        body.error?.message ?? `Stripe checkout failed with status ${response.status}`,
      );
    }

    return { providerPaymentId: body.id, url: body.url };
  }

  verifyAndParse(rawBody: Buffer, signatureHeader: string): ParsedPaymentEvent {
    verifyStripeSignature(rawBody, signatureHeader, this.config.webhookSecret);
    return parseStripeEvent(rawBody);
  }
}
