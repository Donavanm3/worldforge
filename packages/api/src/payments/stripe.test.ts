import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from './provider.js';
import { parseSignatureHeader, parseStripeEvent, verifyStripeSignature } from './stripe.js';

const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000;

function sign(body: string, secret = SECRET, timestamp = NOW): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('parseSignatureHeader', () => {
  it('extracts the timestamp and signature', () => {
    const parsed = parseSignatureHeader('t=123,v1=abc');
    expect(parsed.timestamp).toBe(123);
    expect(parsed.signatures).toStrictEqual(['abc']);
  });

  it('collects multiple v1 signatures during secret rotation', () => {
    const parsed = parseSignatureHeader('t=123,v1=abc,v1=def');
    expect(parsed.signatures).toStrictEqual(['abc', 'def']);
  });

  it('ignores unknown schemes such as v0', () => {
    const parsed = parseSignatureHeader('t=123,v0=zzz,v1=abc');
    expect(parsed.signatures).toStrictEqual(['abc']);
  });
});

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a correctly signed payload', () => {
    expect(() => verifyStripeSignature(Buffer.from(body), sign(body), SECRET, NOW)).not.toThrow();
  });

  it('accepts when one of several signatures matches', () => {
    const valid = sign(body).split('v1=')[1];
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${valid}`;
    expect(() => verifyStripeSignature(Buffer.from(body), header, SECRET, NOW)).not.toThrow();
  });

  it('rejects a payload signed with the wrong secret', () => {
    expect(() =>
      verifyStripeSignature(Buffer.from(body), sign(body, 'whsec_wrong'), SECRET, NOW),
    ).toThrow(WebhookVerificationError);
  });

  it('rejects a tampered body', () => {
    const header = sign(body);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', hax: 1 });
    expect(() => verifyStripeSignature(Buffer.from(tampered), header, SECRET, NOW)).toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a replayed delivery outside the tolerance window', () => {
    const header = sign(body, SECRET, NOW - 3600);
    expect(() => verifyStripeSignature(Buffer.from(body), header, SECRET, NOW)).toThrow(
      /tolerance/i,
    );
  });

  it('rejects a timestamp far in the future', () => {
    const header = sign(body, SECRET, NOW + 3600);
    expect(() => verifyStripeSignature(Buffer.from(body), header, SECRET, NOW)).toThrow(
      /tolerance/i,
    );
  });

  it('rejects malformed or empty headers', () => {
    for (const header of ['', 'garbage', 't=123', `v1=${'0'.repeat(64)}`, 't=abc,v1=xyz']) {
      expect(() => verifyStripeSignature(Buffer.from(body), header, SECRET, NOW), header).toThrow(
        WebhookVerificationError,
      );
    }
  });

  it('verifies against exact bytes, not re-serialised JSON', () => {
    // Stripe signs the literal payload; whitespace differences must fail.
    const spaced = '{ "id": "evt_1" }';
    const header = sign(spaced);
    expect(() => verifyStripeSignature(Buffer.from(spaced), header, SECRET, NOW)).not.toThrow();
    expect(() =>
      verifyStripeSignature(Buffer.from(JSON.stringify(JSON.parse(spaced))), header, SECRET, NOW),
    ).toThrow(WebhookVerificationError);
  });
});

describe('parseStripeEvent', () => {
  function event(type: string, object: Record<string, unknown>, id = 'evt_1') {
    return Buffer.from(JSON.stringify({ id, type, data: { object } }));
  }

  it('maps a paid checkout session to succeeded', () => {
    const parsed = parseStripeEvent(
      event('checkout.session.completed', {
        id: 'cs_123',
        payment_status: 'paid',
        amount_total: 300,
        currency: 'usd',
        metadata: { paymentId: 'pay-1', userId: 'user-1' },
      }),
    );

    expect(parsed.type).toBe('succeeded');
    expect(parsed.providerEventId).toBe('evt_1');
    expect(parsed.providerPaymentId).toBe('cs_123');
    expect(parsed.paymentId).toBe('pay-1');
    expect(parsed.userId).toBe('user-1');
    expect(parsed.amountMinor).toBe(300);
    expect(parsed.currency).toBe('USD');
  });

  it('does not treat an unpaid completed session as succeeded', () => {
    // A session can complete while payment is still pending; granting access
    // here would hand out the game for free.
    const parsed = parseStripeEvent(
      event('checkout.session.completed', {
        id: 'cs_123',
        payment_status: 'unpaid',
        metadata: { paymentId: 'pay-1' },
      }),
    );
    expect(parsed.type).toBe('ignored');
  });

  it('maps failures and refunds', () => {
    expect(parseStripeEvent(event('payment_intent.payment_failed', { id: 'pi_1' })).type).toBe(
      'failed',
    );
    expect(parseStripeEvent(event('charge.refunded', { id: 'ch_1' })).type).toBe('refunded');
  });

  it('ignores unrelated event types', () => {
    expect(parseStripeEvent(event('customer.created', { id: 'cus_1' })).type).toBe('ignored');
  });

  it('tolerates missing metadata', () => {
    const parsed = parseStripeEvent(event('checkout.session.completed', { id: 'cs_1' }));
    expect(parsed.paymentId).toBeNull();
    expect(parsed.userId).toBeNull();
  });

  it('rejects invalid JSON and missing fields', () => {
    expect(() => parseStripeEvent(Buffer.from('not json'))).toThrow(WebhookVerificationError);
    expect(() => parseStripeEvent(Buffer.from('{"type":"x"}'))).toThrow(WebhookVerificationError);
    expect(() => parseStripeEvent(Buffer.from('{"id":"evt_1"}'))).toThrow(WebhookVerificationError);
  });
});
