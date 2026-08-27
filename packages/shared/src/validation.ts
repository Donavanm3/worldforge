import { z } from 'zod';

/**
 * Usernames are the player's public identity: letters, digits, underscore and
 * hyphen only. Kept ASCII so lookalike characters can't be used to impersonate.
 */
export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Username may only contain letters, numbers, _ and -');

export const emailSchema = z.string().email('Enter a valid email address').max(254);

/**
 * Length is the dominant factor in password strength, so we require a long
 * password rather than imposing character-class rules that push people toward
 * predictable substitutions.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters');

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().min(1).max(48).optional(),
});

export const loginSchema = z.object({
  // Players may sign in with either identifier.
  identifier: z.string().min(1, 'Enter your username or email'),
  password: z.string().min(1, 'Enter your password'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
