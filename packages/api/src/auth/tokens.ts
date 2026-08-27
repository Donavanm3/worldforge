import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '@wf/shared';
import type { UserRole } from '@wf/db';

export interface AccessTokenClaims {
  sub: string;
  username: string;
  role: UserRole;
  betaAccess: boolean;
}

const ISSUER = 'worldforge';
const AUDIENCE = 'worldforge-client';

function secretKey(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export async function signAccessToken(
  config: AppConfig,
  claims: AccessTokenClaims,
): Promise<string> {
  return new SignJWT({
    username: claims.username,
    role: claims.role,
    betaAccess: claims.betaAccess,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey(config));
}

/**
 * Returns the claims, or null if the token is expired, tampered with, or was
 * issued for a different issuer/audience. Never throws to the caller.
 */
export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    if (typeof payload.sub !== 'string' || typeof payload['username'] !== 'string') {
      return null;
    }

    return {
      sub: payload.sub,
      username: payload['username'],
      role: payload['role'] as UserRole,
      betaAccess: payload['betaAccess'] === true,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh tokens are opaque random strings — only their SHA-256 is stored, so a
 * database leak does not hand out usable sessions.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for any secret-bearing string. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
