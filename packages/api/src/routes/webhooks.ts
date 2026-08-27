import type { FastifyInstance } from 'fastify';
import { WebhookVerificationError } from '../payments/provider.js';
import { processPaymentEvent } from '../payments/service.js';

/**
 * Payment webhooks. Registered in its own encapsulated scope so the raw-body
 * content-type parser applies here and nowhere else — signature verification
 * runs over the exact bytes received, and re-serialising parsed JSON would
 * change them.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.post(
    '/payments/webhook',
    {
      // Providers retry aggressively; the limit is generous but not unbounded.
      config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const provider = app.paymentProvider;
      if (!provider) {
        request.log.error('Webhook received but no payment provider is configured');
        reply.code(503);
        return { error: { code: 'SERVICE_UNAVAILABLE', message: 'Payments are not configured' } };
      }

      const signature = request.headers['stripe-signature'];
      const rawBody = request.body;

      if (typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) {
        reply.code(400);
        return { error: { code: 'BAD_REQUEST', message: 'Missing signature or body' } };
      }

      let event;
      try {
        event = provider.verifyAndParse(rawBody, signature);
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          // Log without the body: an unverified payload is attacker-controlled.
          request.log.warn({ ip: request.ip }, 'Rejected webhook with invalid signature');
          reply.code(400);
          return { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } };
        }
        throw error;
      }

      try {
        const outcome = await processPaymentEvent(app.db, provider.name, event);
        request.log.info({ outcome, eventId: event.providerEventId }, 'Processed payment event');
        // Always 200 on a verified event: a non-2xx makes the provider retry,
        // and duplicates are already handled idempotently.
        return { received: true, outcome };
      } catch (error) {
        // A genuine processing failure should be retried, so signal 500.
        request.log.error(
          { err: error, eventId: event.providerEventId },
          'Webhook processing failed',
        );
        reply.code(500);
        return { error: { code: 'PROCESSING_FAILED', message: 'Could not process event' } };
      }
    },
  );
}
