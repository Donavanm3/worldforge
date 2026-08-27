/** What a webhook delivery means to us, independent of the provider. */
export type PaymentEventType = 'succeeded' | 'failed' | 'refunded' | 'ignored';

export interface ParsedPaymentEvent {
  /** Provider-assigned event id. The idempotency key for the whole pipeline. */
  providerEventId: string;
  type: PaymentEventType;
  /** Provider-assigned payment/session id, recorded on the payments row. */
  providerPaymentId: string | null;
  /** Our own payments.id, round-tripped through provider metadata. */
  paymentId: string | null;
  userId: string | null;
  amountMinor: number | null;
  currency: string | null;
  raw: unknown;
}

export interface CheckoutParams {
  paymentId: string;
  userId: string;
  username: string;
  email: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  productName: string;
}

export interface CheckoutSession {
  providerPaymentId: string;
  url: string;
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** Raised when a webhook signature fails verification. Never retry these. */
export class WebhookVerificationError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(params: CheckoutParams): Promise<CheckoutSession>;
  /**
   * Verifies the signature over the exact raw bytes and parses the event.
   * Must throw {@link WebhookVerificationError} rather than returning anything
   * when verification fails.
   */
  verifyAndParse(rawBody: Buffer, signatureHeader: string): ParsedPaymentEvent;
}
