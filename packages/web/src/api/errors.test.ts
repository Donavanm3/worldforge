import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from './errors.js';

describe('toApiError', () => {
  it('parses the server error envelope', () => {
    const error = toApiError(409, {
      error: { code: 'CONFLICT', message: 'That username is taken' },
    });
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('That username is taken');
  });

  it('keeps field-level validation details', () => {
    const error = toApiError(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please correct the highlighted fields',
        details: [{ field: 'password', message: 'Too short' }],
      },
    });
    expect(error.fieldErrors()).toStrictEqual({ password: 'Too short' });
  });

  it('falls back when the body is not our envelope', () => {
    // A proxy 502 or HTML error page must not surface as "undefined".
    for (const body of [null, 'Bad Gateway', {}, { error: 'nope' }, 42]) {
      const error = toApiError(502, body);
      expect(error.code).toBe('UNKNOWN');
      expect(error.message).toBe('Request failed (502)');
    }
  });

  it('identifies the beta paywall', () => {
    const error = toApiError(402, {
      error: { code: 'BETA_ACCESS_REQUIRED', message: 'Beta access required' },
    });
    expect(error.isBetaAccessRequired).toBe(true);
    expect(error.isUnauthorized).toBe(false);
  });

  it('identifies an expired session', () => {
    const error = toApiError(401, { error: { code: 'UNAUTHORIZED', message: 'nope' } });
    expect(error.isUnauthorized).toBe(true);
    expect(error.isBetaAccessRequired).toBe(false);
  });

  it('returns an empty map when there are no details', () => {
    expect(new ApiError(500, 'X', 'y').fieldErrors()).toStrictEqual({});
  });
});
