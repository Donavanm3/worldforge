import { Redis } from 'ioredis';
import type { AppConfig } from '@wf/shared';

export function createRedis(config: AppConfig): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    // Fail fast at boot rather than queueing commands against a dead server.
    lazyConnect: false,
    enableOfflineQueue: false,
  });
}

export type { Redis };
