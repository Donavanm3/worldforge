import type { FastifyReply, FastifyRequest } from 'fastify';
import { BetaAccessRequiredError, ForbiddenError, UnauthorizedError } from '@wf/shared';
import type { UserRole } from '@wf/db';
import { verifyAccessToken } from './tokens.js';
import { hasWorldAccess, loadGameSettings } from '../settings.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
  betaAccess: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Verifies the access token and re-reads the account from the database.
 *
 * The token's claims are a cache, not the source of truth: a ban or a revoked
 * beta grant must take effect immediately rather than at token expiry.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    throw new UnauthorizedError();
  }

  const claims = await verifyAccessToken(request.server.config, token);
  if (!claims) {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const user = await request.server.db
    .selectFrom('users')
    .select(['id', 'username', 'role', 'status', 'beta_access'])
    .where('id', '=', claims.sub)
    .executeTakeFirst();

  if (!user || user.status !== 'active') {
    throw new UnauthorizedError('Account is not active');
  }

  request.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    betaAccess: user.beta_access,
  };
}

/**
 * Gate for anything inside the game world (spec 76). Runs after requireAuth.
 */
export async function requireWorldAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const user = request.user;
  if (!user) {
    throw new UnauthorizedError();
  }

  const settings = await loadGameSettings(request.server.db);
  if (!hasWorldAccess(settings, user.betaAccess)) {
    if (settings.gameStatus === 'MAINTENANCE') {
      throw new ForbiddenError('WorldForge is currently under maintenance');
    }
    throw new BetaAccessRequiredError();
  }
}

export function requireRole(...roles: UserRole[]) {
  return async function roleGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const user = request.user;
    if (!user) {
      throw new UnauthorizedError();
    }
    if (!roles.includes(user.role)) {
      throw new ForbiddenError();
    }
  };
}
