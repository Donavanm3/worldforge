import { ApiError, toApiError } from './errors.js';
import type {
  AuthResponse,
  Company,
  CompanyOrder,
  Employee,
  InventoryRow,
  Item,
  JobListing,
  MarketTrade,
  MyEmployment,
  OrderBook,
  PayrollResult,
  PlaceOrderResult,
  ProductionRun,
  Recipe,
  BetaAccessResponse,
  BetaStatus,
  GameSettings,
  MeResponse,
  OwnedParcel,
  BuildingDetail,
  BuildingQuote,
  BuildingSummary,
  CitySummary,
  ParcelCollection,
  StartBuildResult,
  UnitSummary,
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

  let response: Response;
  try {
    response = await send();
  } catch {
    // fetch rejects outright when the server is unreachable. Surface that as
    // an ApiError so callers get one error type and an actionable message,
    // rather than a bare TypeError and a generic "something went wrong".
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the WorldForge server.');
  }

  // A short-lived access token expiring mid-session is normal; rotate and
  // replay once rather than bouncing the player to the login screen.
  if (response.status === 401 && retryOnUnauthorized && (await refreshSession())) {
    response = await send();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  // A proxy error page, a gateway timeout or an empty body are all non-JSON.
  // Parsing must never throw past this point: toApiError falls back to a
  // status-based message, which is far more useful than a SyntaxError.
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw toApiError(response.status, payload);
  }
  if (payload === null && text) {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'The server returned an unreadable reply.');
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
  cities: () => request<CitySummary[]>('/land/cities'),
  generateLand: (bbox: { west: number; south: number; east: number; north: number }) =>
    request<{
      tilesRequested: number;
      tilesGenerated: number;
      parcelsCreated: number;
      alreadyGenerated: boolean;
    }>('/land/generate', { method: 'POST', body: bbox }),
  parcel: (id: string) => request<ParcelDetail>(`/land/parcels/${id}`),
  myParcels: () => request<OwnedParcel[]>('/land/mine'),
  market: () => request<MarketListing[]>('/land/market'),
  buyParcel: (id: string) => request<PurchaseResult>(`/land/parcels/${id}/buy`, { method: 'POST' }),
  listParcel: (id: string, price: string) =>
    request<void>(`/land/parcels/${id}/list`, { method: 'POST', body: { price } }),
  unlistParcel: (id: string) => request<void>(`/land/parcels/${id}/list`, { method: 'DELETE' }),

  // --- buildings ---
  quoteBuilding: (parcelId: string, plan: { footprintSqm: number; floors: number; type: string }) =>
    request<BuildingQuote>(`/land/parcels/${parcelId}/quote`, { method: 'POST', body: plan }),
  startBuild: (
    parcelId: string,
    plan: { name: string; footprintSqm: number; floors: number; type: string },
  ) => request<StartBuildResult>(`/land/parcels/${parcelId}/build`, { method: 'POST', body: plan }),
  myBuildings: () => request<BuildingSummary[]>('/buildings/mine'),
  buildingMarket: () => request<BuildingSummary[]>('/buildings/market'),
  building: (id: string) => request<BuildingDetail>(`/buildings/${id}`),
  myUnits: () => request<UnitSummary[]>('/units/mine'),
  listUnit: (id: string, price: string) =>
    request<void>(`/units/${id}/list`, { method: 'POST', body: { price } }),
  unlistUnit: (id: string) => request<void>(`/units/${id}/list`, { method: 'DELETE' }),
  buyUnit: (id: string) =>
    request<{ unitId: string; pricePaid: string; balance: string }>(`/units/${id}/buy`, {
      method: 'POST',
    }),

  // --- economy: catalogue ---
  items: () => request<Item[]>('/items'),
  recipes: () => request<Recipe[]>('/recipes'),

  // --- economy: companies ---
  companies: () => request<Company[]>('/companies'),
  myCompanies: () => request<Company[]>('/companies/mine'),
  company: (id: string) => request<Company>(`/companies/${id}`),
  createCompany: (input: {
    name: string;
    industry: string;
    description?: string;
    initialCapital?: string;
  }) => request<Company>('/companies', { method: 'POST', body: input }),
  companyInventory: (id: string) => request<InventoryRow[]>(`/companies/${id}/inventory`),
  treasury: (id: string, direction: 'deposit' | 'withdraw', amount: string) =>
    request<{ balance: string; cash: string }>(`/companies/${id}/treasury`, {
      method: 'POST',
      body: { direction, amount },
    }),

  // --- economy: production ---
  production: (companyId: string) => request<ProductionRun[]>(`/companies/${companyId}/production`),
  startProduction: (companyId: string, recipeId: string, batches: number) =>
    request<{ orderId: string; completesAt: string; labourCost: string }>(
      `/companies/${companyId}/production`,
      { method: 'POST', body: { recipeId, batches } },
    ),

  // --- economy: market ---
  orderBook: (itemId: string) => request<OrderBook>(`/market/items/${itemId}/book`),
  itemTrades: (itemId: string) => request<MarketTrade[]>(`/market/items/${itemId}/trades`),
  companyOrders: (companyId: string) => request<CompanyOrder[]>(`/companies/${companyId}/orders`),
  placeOrder: (input: {
    companyId: string;
    itemId: string;
    side: 'buy' | 'sell';
    quantity: string;
    price: string;
  }) => request<PlaceOrderResult>('/market/orders', { method: 'POST', body: input }),
  cancelOrder: (orderId: string) =>
    request<void>(`/market/orders/${orderId}`, { method: 'DELETE' }),

  // --- economy: employment ---
  jobs: () => request<JobListing[]>('/jobs'),
  myJob: () => request<MyEmployment | null>('/jobs/mine'),
  applyForJob: (listingId: string) =>
    request<{ id: string }>(`/jobs/${listingId}/apply`, { method: 'POST' }),
  resign: () => request<void>('/jobs/resign', { method: 'POST' }),
  createJobListing: (
    companyId: string,
    input: { title: string; salary: string; positions: number },
  ) => request<JobListing>(`/companies/${companyId}/jobs`, { method: 'POST', body: input }),
  employees: (companyId: string) => request<Employee[]>(`/companies/${companyId}/employees`),
  fireEmployee: (companyId: string, employmentId: string) =>
    request<void>(`/companies/${companyId}/employees/${employmentId}`, { method: 'DELETE' }),
  runPayroll: (companyId: string) =>
    request<PayrollResult>(`/companies/${companyId}/payroll`, { method: 'POST' }),

  // --- admin ---
  adminSettings: () => request<GameSettings>('/admin/settings'),
  updateAdminSettings: (patch: Partial<GameSettings>) =>
    request<GameSettings>('/admin/settings', { method: 'PATCH', body: patch }),
  adminPayments: () => request<PaymentsDashboard>('/admin/payments'),
};

export { ApiError } from './errors.js';
