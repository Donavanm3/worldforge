import type { GameStatus, LandZoning, UserRole } from '@wf/shared';

export interface PublicUser {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  betaAccess: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

export interface Profile {
  display_name: string;
  avatar_url: string | null;
  balance: string;
  net_worth: string;
  reputation: number;
}

export interface MeResponse {
  user: PublicUser;
  profile: Profile | null;
  game: {
    status: GameStatus;
    betaPrice: string;
    betaPaymentRequired: boolean;
  };
}

export interface BetaStatus {
  gameStatus: GameStatus;
  betaPrice: string;
  currency: string;
  betaPaymentRequired: boolean;
  registrationEnabled: boolean;
  paymentsConfigured: boolean;
}

export interface BetaAccessResponse {
  hasAccess: boolean;
  betaAccess: boolean;
  gameStatus: GameStatus;
  betaPrice: string;
  betaPaymentRequired: boolean;
  latestPayment: {
    id: string;
    status: string;
    amount: string;
    currency: string;
  } | null;
}

export interface ParcelProperties {
  id: string;
  ownerId: string | null;
  ownerName: string | null;
  zoning: LandZoning;
  areaSqm: string;
  marketValue: string;
  forSale: boolean;
  salePrice: string | null;
  hasPower: boolean;
  hasWater: boolean;
  hasInternet: boolean;
  hasRoad: boolean;
  cityName: string | null;
}

/** Minimal GeoJSON polygon, avoiding a dependency on @types/geojson. */
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface ParcelFeature {
  type: 'Feature';
  id: string;
  geometry: PolygonGeometry;
  properties: ParcelProperties;
}

export interface ParcelCollection {
  type: 'FeatureCollection';
  features: ParcelFeature[];
  truncated: boolean;
}

export interface ParcelDetail extends ParcelProperties {
  owner_name: string | null;
  city_name: string | null;
  area_sqm: string;
  market_value: string;
  sale_price: string | null;
  for_sale: boolean;
  owner_id: string | null;
}

export interface OwnedParcel {
  id: string;
  zoning: LandZoning;
  area_sqm: string;
  market_value: string;
  for_sale: boolean;
  sale_price: string | null;
  city_name: string | null;
}

export interface MarketListing extends OwnedParcel {
  owner_name: string | null;
}

export interface PurchaseResult {
  parcelId: string;
  pricePaid: string;
  newBalance: string;
  sellerId: string | null;
}

export interface GameSettings {
  gameStatus: GameStatus;
  betaPrice: string;
  betaPaymentRequired: boolean;
  registrationEnabled: boolean;
  startingBalance: string;
}

export interface PaymentsDashboard {
  stats: {
    totalPurchases: number;
    totalRevenue: string;
    successful: number;
    pending: number;
    failed: number;
    refunded: number;
  };
  payments: Array<{
    id: string;
    username: string;
    amount: string;
    currency: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  }>;
}
