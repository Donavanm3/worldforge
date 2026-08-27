import { Redis } from 'ioredis';
import type { AppConfig } from '@wf/shared';

export function createRedis(config: AppConfig): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    // The offline queue stays ON deliberately. Disabling it makes ioredis
    // reject every command issued before the socket is ready — including
    // during a normal reconnect — which turned the rate limiter into a
    // 500 on every request, health checks included.
    enableOfflineQueue: true,
  });
}

export type { Redis };
