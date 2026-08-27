import {
  type AppConfig,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  type LoginInput,
  type RegisterInput,
} from '@wf/shared';
import type { Db, User } from '@wf/db';
import { hashPassword, verifyPassword } from './password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type AccessTokenClaims,
} from './tokens.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface AuthResult extends AuthTokens {
  user: {
    id: string;
    username: string;
    email: string;
    role: User['role'];
    betaAccess: boolean;
  };
}

/**
 * A dummy Argon2 hash used to equalise timing when an account does not exist.
 * Without it, a failed lookup returns measurably faster than a wrong password
 * and leaks which usernames are registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZXg$K5Xb0Zf7pQ0mVQ2Wl0S6h5xW1cZ1zY9k8bQe1LqNq3A';

function toPublicUser(user: User): AuthResult['user'] {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    betaAccess: user.beta_access,
  };
}

async function issueTokens(
  db: Db,
  config: AppConfig,
  user: User,
  context: SessionContext,
): Promise<AuthTokens> {
  const claims: AccessTokenClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    betaAccess: user.beta_access,
  };

  const accessToken = await signAccessToken(config, claims);
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000);

  await db
    .insertInto('sessions')
    .values({
      user_id: user.id,
      token_hash: hashRefreshToken(refreshToken),
      user_agent: context.userAgent ?? null,
      ip_address: context.ipAddress ?? null,
      expires_at: expiresAt,
    })
    .execute();

  return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
}

function assertUsable(user: User): void {
  if (user.status === 'banned') {
    throw new ForbiddenError('This account has been banned');
  }
  if (user.status === 'suspended') {
    throw new ForbiddenError('This account is suspended');
  }
  if (user.status === 'deleted') {
    // Same message as a bad password: don't confirm the account ever existed.
    throw new UnauthorizedError('Incorrect username or password');
  }
}

export async function register(
  db: Db,
  config: AppConfig,
  input: RegisterInput,
  context: SessionContext = {},
): Promise<AuthResult> {
  const password_hash = await hashPassword(input.password);

  // The unique indexes are the real guard against a race between check and
  // insert; this pre-check only produces a friendlier message.
  const existing = await db
    .selectFrom('users')
    .select(['id'])
    .where((eb) =>
      eb.or([
        eb('email', '=', input.email.toLowerCase()),
        eb('username', '=', input.username.toLowerCase()),
      ]),
    )
    .executeTakeFirst();
  if (existing) {
    throw new ConflictError('That email or username is already taken');
  }

  const user = await db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('users')
      .values({
        email: input.email.toLowerCase(),
        username: input.username,
        password_hash,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('profiles')
      .values({
        user_id: created.id,
        display_name: input.displayName ?? created.username,
      })
      .execute();

    return created;
  });

  const tokens = await issueTokens(db, config, user, context);
  return { ...tokens, user: toPublicUser(user) };
}

export async function login(
  db: Db,
  config: AppConfig,
  input: LoginInput,
  context: SessionContext = {},
): Promise<AuthResult> {
  const identifier = input.identifier.toLowerCase();

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['email']), '=', identifier),
        eb(eb.fn('lower', ['username']), '=', identifier),
      ]),
    )
    .executeTakeFirst();

  if (!user) {
    // Burn comparable time so a missing account is indistinguishable.
    await verifyPassword(DUMMY_HASH, input.password);
    throw new UnauthorizedError('Incorrect username or password');
  }

  const ok = await verifyPassword(user.password_hash, input.password);
  if (!ok) {
    throw new UnauthorizedError('Incorrect username or password');
  }

  assertUsable(user);

  await db
    .updateTable('users')
    .set({ last_login_at: new Date() })
    .where('id', '=', user.id)
    .execute();

  const tokens = await issueTokens(db, config, user, context);
  return { ...tokens, user: toPublicUser(user) };
}

/**
 * Exchanges a refresh token for a new pair, rotating the old one.
 *
 * Rotation is single-use: the presented session is revoked as part of the same
 * transaction, so a stolen token stops working the moment the real client
 * refreshes.
 */
export async function refresh(
  db: Db,
  config: AppConfig,
  refreshToken: string,
  context: SessionContext = {},
): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(refreshToken);

  const session = await db
    .selectFrom('sessions')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (!session || session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
    throw new UnauthorizedError('Invalid or expired session');
  }

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .executeTakeFirst();

  if (!user) {
    throw new UnauthorizedError('Invalid or expired session');
  }
  assertUsable(user);

  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', session.id)
    .execute();

  const tokens = await issueTokens(db, config, user, context);
  return { ...tokens, user: toPublicUser(user) };
}

export async function logout(db: Db, refreshToken: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('token_hash', '=', hashRefreshToken(refreshToken))
    .where('revoked_at', 'is', null)
    .execute();
}

/** Revokes every active session for a user — used on password change or ban. */
export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
