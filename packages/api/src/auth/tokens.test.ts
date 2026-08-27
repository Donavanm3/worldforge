import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@wf/shared';
import {
  generateRefreshToken,
  hashRefreshToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
} from './tokens.js';

const config: AppConfig = loadConfig({
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(48),
});

const claims = {
  sub: '11111111-1111-1111-1111-111111111111',
  username: 'ada',
  role: 'player' as const,
  betaAccess: true,
};

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await signAccessToken(config, claims);
    await expect(verifyAccessToken(config, token)).resolves.toStrictEqual(claims);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken(config, claims);
    const other = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'b'.repeat(48),
    });
    await expect(verifyAccessToken(other, token)).resolves.toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(config, claims);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, role: 'admin', betaAccess: true }),
    ).toString('base64url');
    await expect(verifyAccessToken(config, `${header}.${forged}.${signature}`)).resolves.toBeNull();
  });

  it('rejects garbage rather than throwing', async () => {
    await expect(verifyAccessToken(config, 'not-a-token')).resolves.toBeNull();
    await expect(verifyAccessToken(config, '')).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const shortLived = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a'.repeat(48),
      ACCESS_TOKEN_TTL_SECONDS: '1',
    });
    const token = await signAccessToken(shortLived, claims);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(verifyAccessToken(shortLived, token)).resolves.toBeNull();
  });
});

describe('refresh tokens', () => {
  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(43);
    }
  });

  it('hashes deterministically and irreversibly', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(token);
    expect(hashRefreshToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
