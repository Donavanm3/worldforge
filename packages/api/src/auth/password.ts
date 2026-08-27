import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters. OWASP's baseline: 19 MiB memory, 2 iterations, 1 lane.
 * Raising memoryCost is the main lever if login latency budget allows.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * A malformed or truncated hash in the database must read as "wrong password",
 * not as a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, OPTIONS);
  } catch {
    return false;
  }
}
