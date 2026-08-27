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

// --- Phase 2: companies and the production economy ---

export interface Item {
  id: string;
  slug: string;
  name: string;
  kind: 'resource' | 'product';
  unit: string;
  base_price: string;
  tier: number;
}

export interface Company {
  id: string;
  name: string;
  owner_id: string;
  industry: string;
  cash: string;
  reputation: number;
  description: string | null;
  created_at: string;
  owner_name?: string;
}

export interface InventoryRow {
  item_id: string;
  quantity: string;
  slug: string;
  name: string;
  kind: 'resource' | 'product';
  unit: string;
  base_price: string;
}

export interface RecipeInput {
  recipe_id: string;
  item_id: string;
  quantity: string;
  item_name: string;
  item_slug: string;
}

export interface Recipe {
  id: string;
  output_item_id: string;
  output_quantity: string;
  labour_hours: string;
  industry: string;
  output_name: string;
  output_slug: string;
  output_base_price: string;
  inputs: RecipeInput[];
}

export interface ProductionRun {
  id: string;
  batches: number;
  status: 'running' | 'completed' | 'cancelled';
  labour_cost: string;
  started_at: string;
  completes_at: string;
  output_name: string;
  output_quantity: string;
}

export interface OrderBookEntry {
  id: string;
  side: 'buy' | 'sell';
  price: string;
  remaining: string;
  created_at: string;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface MarketTrade {
  id: string;
  quantity: string;
  price: string;
  created_at: string;
}

export interface CompanyOrder {
  id: string;
  side: 'buy' | 'sell';
  quantity: string;
  remaining: string;
  price: string;
  status: 'open' | 'filled' | 'cancelled';
  created_at: string;
  item_name: string;
  item_slug: string;
}

export interface PlaceOrderResult {
  orderId: string;
  status: 'open' | 'filled';
  filledQuantity: string;
  remainingQuantity: string;
  totalValue: string;
  trades: Array<{ quantity: string; price: string }>;
}

export interface JobListing {
  id: string;
  title: string;
  salary: string;
  positions: number;
  filled: number;
  created_at: string;
  company_id: string;
  company_name: string;
  industry: string;
}

export interface MyEmployment {
  id: string;
  title: string;
  salary: string;
  started_at: string;
  company_id: string;
  company_name: string;
  industry: string;
}

export interface Employee {
  id: string;
  title: string;
  salary: string;
  started_at: string;
  username: string;
}

export interface PayrollResult {
  paid: number;
  unpaid: number;
  total: string;
}
