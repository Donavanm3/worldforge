import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@wf/shared';
import { createDb, migrateToLatest, type Db } from '@wf/db';
import { buildServer } from '../server.js';

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
const shouldRun = Boolean(databaseUrl && redisUrl);

/**
 * Full auth flow against real Postgres and Redis. Skipped without both, since
 * rate limiting is Redis-backed. CI provides both services.
 */
describe.runIf(shouldRun)('auth routes (integration)', () => {
  let app: FastifyInstance;
  let db: Db;

  const credentials = {
    email: 'ada@worldforge.test',
    username: 'ada_lovelace',
    password: 'analytical-engine-1843',
  };

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      REDIS_URL: redisUrl!,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
      LOG_LEVEL: 'silent',
    });

    db = createDb({ connectionString: databaseUrl! });
    const { error } = await migrateToLatest(db);
    if (error) throw error;

    await sql`truncate table sessions, profiles, users restart identity cascade`.execute(db);

    app = await buildServer({ config, db });
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  it('reports health without exposing internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.redis).toBe('ok');
    expect(JSON.stringify(body)).not.toContain('postgresql://');
  });

  it('registers a player and starts them at 10000', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: credentials,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe(credentials.username);
    expect(body.user.betaAccess).toBe(false);
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    const profile = await db
      .selectFrom('profiles')
      .select(['balance'])
      .where('user_id', '=', body.user.id)
      .executeTakeFirstOrThrow();
    expect(profile.balance).toBe('10000.0000');
  });

  it('never returns the password hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: credentials.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('argon2');
    expect(response.json().user.password_hash).toBeUndefined();
  });

  it('rejects a duplicate username regardless of case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...credentials, email: 'other@worldforge.test', username: 'ADA_LOVELACE' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a weak password with field-level detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'new@worldforge.test', username: 'newbie', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in by email or username', async () => {
    for (const identifier of [credentials.username, credentials.email, 'ADA@WORLDFORGE.TEST']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier, password: credentials.password },
      });
      expect(response.statusCode, `identifier ${identifier}`).toBe(200);
    }
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: 'wrong-password-here' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'nobody', password: 'wrong-password-here' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // User enumeration: the responses must be indistinguishable.
    expect(wrongPassword.json()).toStrictEqual(unknownUser.json());
  });

  it('rotates refresh tokens and revokes the used one', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: credentials.password },
    });
    const { refreshToken } = loginResponse.json();

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().refreshToken).not.toBe(refreshToken);

    // Replaying the consumed token must fail.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('invalidates the refresh token on logout', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: credentials.password },
    });
    const { refreshToken } = loginResponse.json();

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refreshToken },
    });
    expect(logoutResponse.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('guards /auth/me against missing and forged tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);

    const forged = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('returns the current player and game status from /auth/me', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: credentials.password },
    });
    const { accessToken } = loginResponse.json();

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.username).toBe(credentials.username);
    expect(body.game.status).toBe('BETA');
    expect(body.game.betaPrice).toBe('3.00');
    expect(body.profile.balance).toBe('10000.0000');
  });

  it('refuses login for a banned account', async () => {
    await db
      .updateTable('users')
      .set({ status: 'banned' })
      .where('username', '=', credentials.username)
      .execute();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: credentials.username, password: credentials.password },
    });
    expect(response.statusCode).toBe(403);

    await db
      .updateTable('users')
      .set({ status: 'active' })
      .where('username', '=', credentials.username)
      .execute();
  });
});
