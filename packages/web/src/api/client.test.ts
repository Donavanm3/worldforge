import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setAccessToken } from './client.js';

function mockFetch(response: Partial<Response> & { textValue?: string }) {
  const stub = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.textValue ?? '',
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('request error handling', () => {
  it('parses a normal JSON response', async () => {
    mockFetch({ textValue: JSON.stringify({ betaPrice: '3.00' }) });
    await expect(api.betaStatus()).resolves.toMatchObject({ betaPrice: '3.00' });
  });

  it('surfaces an unreachable server as an ApiError, not a raw TypeError', async () => {
    // This is what happens when the API is simply not running.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const error = await api.betaStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toMatch(/cannot reach/i);
  });

  it('does not throw a SyntaxError on a non-JSON error page', async () => {
    // A Vite or Nginx proxy error returns HTML, not our JSON envelope.
    mockFetch({ ok: false, status: 502, textValue: '<html>Bad Gateway</html>' });

    const error = await api.betaStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/not responding/i);
  });

  it('reports an unreadable success body rather than returning garbage', async () => {
    mockFetch({ ok: true, status: 200, textValue: 'not json at all' });

    const error = await api.betaStatus().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('BAD_RESPONSE');
  });

  it('keeps structured validation details from the server', async () => {
    mockFetch({
      ok: false,
      status: 400,
      textValue: JSON.stringify({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Please correct the highlighted fields',
          details: [{ field: 'password', message: 'Password must be at least 10 characters' }],
        },
      }),
    });

    const error = await api
      .register({ email: 'a@b.test', username: 'abc', password: 'short' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.fieldErrors()).toStrictEqual({
      password: 'Password must be at least 10 characters',
    });
  });

  it('treats 204 as an empty success', async () => {
    mockFetch({ ok: true, status: 204, textValue: '' });
    await expect(api.resign()).resolves.toBeUndefined();
  });
});
