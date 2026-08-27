import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://localhost/wf',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(valid);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'too-short' })).toThrow(ConfigError);
  });

  it('rejects missing required variables', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://x', JWT_SECRET: 'x'.repeat(32) })).toThrow(
      ConfigError,
    );
  });

  it('names every offending variable in the error', () => {
    try {
      loadConfig({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('JWT_SECRET');
    }
  });

  it('returns a frozen object', () => {
    const config = loadConfig(valid);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
