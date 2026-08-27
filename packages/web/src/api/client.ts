import { toApiError } from './errors.js';
import type {
  AuthResponse,
  BetaAccessResponse,
  BetaStatus,
  GameSettings,
  MeResponse,
  OwnedParcel,
  ParcelCollection,
  ParcelDetail,
  MarketListing,
  PaymentsDashboard,
  PurchaseResult,
} from './types.js';

const REFRESH_STORAGE_KEY = 'wf.refreshToken';

/**
 * Token handling.
 *
 * The access token is held in memory only, so it never survives a tab close and
 * is not readable from storage. The refresh token does live in localStorage,
 * which is the pragmatic trade-off for "stay signed in" without cookies; it is
 * single-use and rotated on every refresh, so a stolen one has a short life.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_STORAGE_KEY, token);
    else localStorage.removeItem(REFRESH_STORAGE_KEY);
  } catch {
    // Private browsing can deny storage; the session still works until reload.
  }
}

export function storeSession(auth: AuthResponse): void {
  setAccessToken(auth.accessToken);
  setRefreshToken(auth.refreshToken);
}

export function clearSession(): void {
  setAccessToken(null);
  setRefreshToken(null);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Set false for auth endpoints, so a failed refresh cannot recurse. */
  retryOnUnauthorized?: boolean;
}

/** In-flight refresh, shared so concurrent 401s trigger only one rotation. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        clearSession();
        return false;
      }

      storeSession((await response.json()) as AuthResponse);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, retryOnUnauthorized = true } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    return fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let response = await send();

  // A short-lived access token expiring mid-session is normal; rotate and
  // replay once rather than bouncing the player to the login screen.
  if (response.status === 401 && retryOnUnauthorized && (await refreshSession())) {
    response = await send();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw toApiError(response.status, payload);
  }
  return payload as T;
}

export const api = {
  // --- auth ---
  register: (input: { email: string; username: string; password: string }) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: input,
      retryOnUnauthorized: false,
    }),

  login: (input: { identifier: string; password: string }) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: input,
      retryOnUnauthorized: false,
    }),

  logout: (refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: { refreshToken } }),

  me: () => request<MeResponse>('/auth/me'),

  // --- beta ---
  betaStatus: () => request<BetaStatus>('/beta/status'),
  betaAccess: () => request<BetaAccessResponse>('/beta/access'),
  startCheckout: () =>
    request<{ checkoutUrl: string; paymentId: string; amount: string; currency: string }>(
      '/beta/checkout',
      { method: 'POST' },
    ),

  // --- land ---
  parcelsInViewport: (bbox: { west: number; south: number; east: number; north: number }) =>
    request<ParcelCollection>(
      `/land/parcels?west=${bbox.west}&south=${bbox.south}&east=${bbox.east}&north=${bbox.north}`,
    ),
  parcel: (id: string) => request<ParcelDetail>(`/land/parcels/${id}`),
  myParcels: () => request<OwnedParcel[]>('/land/mine'),
  market: () => request<MarketListing[]>('/land/market'),
  buyParcel: (id: string) => request<PurchaseResult>(`/land/parcels/${id}/buy`, { method: 'POST' }),
  listParcel: (id: string, price: string) =>
    request<void>(`/land/parcels/${id}/list`, { method: 'POST', body: { price } }),
  unlistParcel: (id: string) => request<void>(`/land/parcels/${id}/list`, { method: 'DELETE' }),

  // --- admin ---
  adminSettings: () => request<GameSettings>('/admin/settings'),
  updateAdminSettings: (patch: Partial<GameSettings>) =>
    request<GameSettings>('/admin/settings', { method: 'PATCH', body: patch }),
  adminPayments: () => request<PaymentsDashboard>('/admin/payments'),
};

export { ApiError } from './errors.js';
