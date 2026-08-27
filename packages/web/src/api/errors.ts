/** Server error envelope: `{ error: { code, message, details? } }`. */
export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Array<{ field: string; message: string }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorShape['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the player is authenticated but has not bought beta access. */
  get isBetaAccessRequired(): boolean {
    return this.status === 402 || this.code === 'BETA_ACCESS_REQUIRED';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Field-level messages keyed by field name, for form rendering. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      if (detail.field) result[detail.field] = detail.message;
    }
    return result;
  }
}

/**
 * Normalises any failed response into an ApiError.
 *
 * Falls back to a generic message when the body is not our error envelope —
 * a proxy 502 or an HTML error page must not surface as "undefined".
 */
export function toApiError(status: number, body: unknown): ApiError {
  const envelope =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: Partial<ApiErrorShape> }).error
      : null;

  if (envelope && typeof envelope.message === 'string') {
    return new ApiError(
      status,
      typeof envelope.code === 'string' ? envelope.code : 'UNKNOWN',
      envelope.message,
      Array.isArray(envelope.details) ? envelope.details : undefined,
    );
  }

  return new ApiError(status, 'UNKNOWN', `Request failed (${status})`);
}
