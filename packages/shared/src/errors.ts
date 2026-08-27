/**
 * Application errors carry an HTTP status and a stable machine-readable code.
 * Messages are safe to show a player; never put internal detail in them.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message);
  }
}

/** The player is authenticated but has not purchased beta access (spec 74). */
export class BetaAccessRequiredError extends AppError {
  constructor(message = 'WorldForge Beta Access is required to enter the game') {
    super(402, 'BETA_ACCESS_REQUIRED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Already exists') {
    super(409, 'CONFLICT', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
