import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Timestamps are written by the database (`now()`) unless explicitly supplied.
 */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * Monetary and other exact-decimal values.
 *
 * These map to PostgreSQL `numeric` and are read back as strings. Never widen
 * these to `number` — IEEE-754 rounding on currency is how duplication and
 * negative-balance exploits get in (spec 52).
 */
export type Numeric = ColumnType<string, string | number, string | number>;

/** PostGIS geometry columns, read as GeoJSON text. Parsed at the query layer. */
export type Geometry = ColumnType<string, string, string>;

// Domain enums are owned by @wf/shared and re-exported here so query code can
// keep importing them alongside the table types.
export type {
  AccessSource,
  BondStatus,
  BuildingStatus,
  BuildingType,
  EmploymentStatus,
  ListingStatus,
  LoanStatus,
  GameStatus,
  Industry,
  ItemKind,
  LandZoning,
  OrderSide,
  OrderStatus,
  PaymentStatus,
  ProductionStatus,
  UnitUse,
  UserRole,
  UserStatus,
} from '@wf/shared';

import type {
  AccessSource,
  BondStatus,
  BuildingStatus,
  BuildingType,
  EmploymentStatus,
  ListingStatus,
  LoanStatus,
  Industry,
  ItemKind,
  LandZoning,
  OrderSide,
  OrderStatus,
  PaymentStatus,
  ProductionStatus,
  UnitUse,
  UserRole,
  UserStatus,
} from '@wf/shared';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  username: string;
  password_hash: string;
  role: Generated<UserRole>;
  status: Generated<UserStatus>;

  /** Beta gating (spec 69). Never trust the client for any of these. */
  beta_access: Generated<boolean>;
  beta_access_granted_at: Timestamp | null;
  beta_access_payment_id: string | null;
  access_source: AccessSource | null;

  last_login_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ProfilesTable {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  reputation: Generated<number>;
  /** Denormalised cache, recomputed by the worker. Authoritative value is derived. */
  net_worth: Generated<Numeric>;
  balance: Generated<Numeric>;
  home_city_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  /** SHA-256 of the refresh token. The raw token is never stored. */
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface CountriesTable {
  id: Generated<string>;
  name: string;
  code: string;
  boundary: Geometry | null;
  population: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface RegionsTable {
  id: Generated<string>;
  country_id: string;
  name: string;
  code: string | null;
  boundary: Geometry | null;
  population: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface CitiesTable {
  id: Generated<string>;
  region_id: string;
  name: string;
  center: Geometry;
  population: Generated<number>;
  /** Game-balance land rate, used to value parcels near this city. */
  base_rate_per_sqm: Generated<Numeric>;
  created_at: Generated<Timestamp>;
}

export interface LandParcelsTable {
  id: Generated<string>;
  city_id: string | null;
  region_id: string | null;
  owner_id: string | null;
  boundary: Geometry;
  centroid: Geometry;
  area_sqm: Numeric;
  base_value: Numeric;
  market_value: Numeric;
  zoning: Generated<LandZoning>;
  has_power: Generated<boolean>;
  has_water: Generated<boolean>;
  has_internet: Generated<boolean>;
  has_road: Generated<boolean>;
  for_sale: Generated<boolean>;
  sale_price: Numeric | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * Immutable financial ledger (spec 52). Rows are insert-only; corrections are
 * issued as new reversing entries, never as updates or deletes.
 */
export interface TransactionsTable {
  id: Generated<string>;
  sender_user_id: string | null;
  receiver_user_id: string | null;
  amount: Numeric;
  currency: Generated<string>;
  reason: string;
  /** Caller-supplied uniqueness key that makes retries safe. */
  idempotency_key: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Timestamp>;
}

export interface PaymentsTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount: Numeric;
  currency: Generated<string>;
  status: Generated<PaymentStatus>;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

/**
 * One row per webhook delivery. The unique (provider, provider_event_id) index
 * is what makes granting beta access idempotent under provider retries.
 */
export interface PaymentEventsTable {
  id: Generated<string>;
  provider: string;
  provider_event_id: string;
  event_type: string;
  payment_id: string | null;
  payload: Generated<unknown>;
  received_at: Generated<Timestamp>;
  processed_at: Timestamp | null;
  error: string | null;
}

export interface AdminActionsTable {
  id: Generated<string>;
  admin_user_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Generated<unknown>;
  created_at: Generated<Timestamp>;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  read_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

/**
 * Runtime-tunable configuration (spec 70). Beta price and game status live here
 * so they are never hard-coded through the application.
 */
export interface GameSettingsTable {
  key: string;
  value: string;
  description: string | null;
  updated_at: Generated<Timestamp>;
}

// --- Phase 2: companies and the production economy ---

export interface ItemsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  kind: ItemKind;
  unit: Generated<string>;
  base_price: Numeric;
  /** Live price, recomputed by the economy tick from supply and demand. */
  market_price: Generated<Numeric>;
  tier: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface RecipesTable {
  id: Generated<string>;
  output_item_id: string;
  output_quantity: Numeric;
  labour_hours: Numeric;
  industry: Industry;
  created_at: Generated<Timestamp>;
}

export interface RecipeInputsTable {
  recipe_id: string;
  item_id: string;
  quantity: Numeric;
}

export interface CompaniesTable {
  id: Generated<string>;
  name: string;
  owner_id: string;
  industry: Industry;
  headquarters_parcel_id: string | null;
  cash: Generated<Numeric>;
  reputation: Generated<number>;
  description: string | null;
  listing_status: Generated<ListingStatus>;
  shares_outstanding: Generated<number>;
  share_price: Numeric | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface InventoryTable {
  company_id: string;
  item_id: string;
  quantity: Generated<Numeric>;
  updated_at: Generated<Timestamp>;
}

export interface ProductionOrdersTable {
  id: Generated<string>;
  company_id: string;
  recipe_id: string;
  batches: number;
  status: Generated<ProductionStatus>;
  labour_cost: Generated<Numeric>;
  started_at: Generated<Timestamp>;
  completes_at: Timestamp;
  collected_at: Timestamp | null;
}

export interface JobListingsTable {
  id: Generated<string>;
  company_id: string;
  title: string;
  salary: Numeric;
  positions: Generated<number>;
  filled: Generated<number>;
  open: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface EmploymentsTable {
  id: Generated<string>;
  user_id: string;
  company_id: string;
  listing_id: string | null;
  title: string;
  salary: Numeric;
  status: Generated<EmploymentStatus>;
  started_at: Generated<Timestamp>;
  ended_at: Timestamp | null;
}

export interface MarketOrdersTable {
  id: Generated<string>;
  company_id: string;
  item_id: string;
  side: OrderSide;
  quantity: Numeric;
  remaining: Numeric;
  price: Numeric;
  status: Generated<OrderStatus>;
  created_at: Generated<Timestamp>;
  closed_at: Timestamp | null;
}

export interface MarketTradesTable {
  id: Generated<string>;
  item_id: string;
  buy_order_id: string;
  sell_order_id: string;
  buyer_company_id: string;
  seller_company_id: string;
  quantity: Numeric;
  price: Numeric;
  created_at: Generated<Timestamp>;
}

// --- Phase 3: finance and the dynamic economy ---

export interface PriceHistoryTable {
  id: Generated<string>;
  item_id: string;
  price: Numeric;
  supply: Generated<Numeric>;
  demand: Generated<Numeric>;
  volume: Generated<Numeric>;
  recorded_at: Generated<Timestamp>;
}

export interface BanksTable {
  id: Generated<string>;
  company_id: string;
  name: string;
  deposit_rate: Generated<Numeric>;
  loan_rate: Generated<Numeric>;
  reserves: Generated<Numeric>;
  created_at: Generated<Timestamp>;
}

export interface LoansTable {
  id: Generated<string>;
  bank_id: string;
  borrower_company_id: string;
  principal: Numeric;
  outstanding: Numeric;
  rate: Numeric;
  status: Generated<LoanStatus>;
  opened_at: Generated<Timestamp>;
  closed_at: Timestamp | null;
}

export interface ShareholdingsTable {
  company_id: string;
  holder_user_id: string;
  shares: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface ShareOrdersTable {
  id: Generated<string>;
  company_id: string;
  user_id: string;
  side: OrderSide;
  shares: number;
  remaining: number;
  price: Numeric;
  status: Generated<OrderStatus>;
  created_at: Generated<Timestamp>;
  closed_at: Timestamp | null;
}

export interface ShareTradesTable {
  id: Generated<string>;
  company_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  shares: number;
  price: Numeric;
  created_at: Generated<Timestamp>;
}

export interface BondsTable {
  id: Generated<string>;
  issuer_company_id: string;
  face_value: Numeric;
  coupon_rate: Numeric;
  matures_at: Timestamp;
  status: Generated<BondStatus>;
  holder_user_id: string | null;
  purchased_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface TickRunsTable {
  id: Generated<string>;
  kind: string;
  started_at: Generated<Timestamp>;
  finished_at: Timestamp | null;
  details: Generated<unknown>;
  error: string | null;
}

/**
 * A building occupies exactly one parcel (spec 14). Construction is not
 * instant: `completes_at` is set when work starts and the tick flips the
 * status, so a half-built tower cannot be sold as finished space.
 */
export interface BuildingsTable {
  id: Generated<string>;
  parcel_id: string;
  owner_id: string;
  company_id: string | null;
  name: string;
  type: BuildingType;
  status: Generated<BuildingStatus>;
  floors: number;
  footprint_sqm: Numeric;
  construction_cost: Numeric;
  completes_at: Timestamp;
  /** The deed trades separately from the units inside. */
  for_sale: Generated<boolean>;
  sale_price: Numeric | null;
  appraised_value: Generated<Numeric>;
  /** Passing trade, from street frontage. Drives unit revenue. */
  foot_traffic: Generated<Numeric>;
  npc_owner_name: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** Ground floor is level 0; basements are negative. */
export interface BuildingFloorsTable {
  id: Generated<string>;
  building_id: string;
  level: number;
  floor_area_sqm: Numeric;
  use: UnitUse;
  created_at: Generated<Timestamp>;
}

/** The tradeable space inside a building: a flat, an office, a shop. */
export interface BuildingUnitsTable {
  id: Generated<string>;
  building_id: string;
  floor_id: string;
  label: string;
  area_sqm: Numeric;
  use: UnitUse;
  owner_id: string | null;
  market_value: Numeric;
  for_sale: Generated<boolean>;
  sale_price: Numeric | null;
  revenue_per_tick: Generated<Numeric>;
  total_earned: Generated<Numeric>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}


/**
 * One cell of the worldwide land grid. A row exists only once a player has
 * caused that patch of the planet to be cut into parcels.
 */
export interface LandTilesTable {
  id: Generated<string>;
  tile_x: number;
  tile_y: number;
  status: Generated<'pending' | 'ready' | 'empty' | 'failed'>;
  parcel_count: Generated<number>;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

export interface Database {
  users: UsersTable;
  profiles: ProfilesTable;
  sessions: SessionsTable;
  countries: CountriesTable;
  regions: RegionsTable;
  cities: CitiesTable;
  land_parcels: LandParcelsTable;
  transactions: TransactionsTable;
  payments: PaymentsTable;
  payment_events: PaymentEventsTable;
  admin_actions: AdminActionsTable;
  notifications: NotificationsTable;
  game_settings: GameSettingsTable;
  items: ItemsTable;
  recipes: RecipesTable;
  recipe_inputs: RecipeInputsTable;
  companies: CompaniesTable;
  inventory: InventoryTable;
  production_orders: ProductionOrdersTable;
  job_listings: JobListingsTable;
  employments: EmploymentsTable;
  market_orders: MarketOrdersTable;
  market_trades: MarketTradesTable;
  price_history: PriceHistoryTable;
  banks: BanksTable;
  loans: LoansTable;
  shareholdings: ShareholdingsTable;
  share_orders: ShareOrdersTable;
  share_trades: ShareTradesTable;
  bonds: BondsTable;
  land_tiles: LandTilesTable;
  buildings: BuildingsTable;
  building_floors: BuildingFloorsTable;
  building_units: BuildingUnitsTable;
  tick_runs: TickRunsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Profile = Selectable<ProfilesTable>;
export type NewProfile = Insertable<ProfilesTable>;

export type LandParcel = Selectable<LandParcelsTable>;
export type NewLandParcel = Insertable<LandParcelsTable>;

export type Payment = Selectable<PaymentsTable>;
export type NewPayment = Insertable<PaymentsTable>;

export type Transaction = Selectable<TransactionsTable>;
export type NewTransaction = Insertable<TransactionsTable>;

export type GameSetting = Selectable<GameSettingsTable>;

export type Item = Selectable<ItemsTable>;
export type Company = Selectable<CompaniesTable>;
export type NewCompany = Insertable<CompaniesTable>;
export type Recipe = Selectable<RecipesTable>;
export type MarketOrder = Selectable<MarketOrdersTable>;
export type MarketTrade = Selectable<MarketTradesTable>;
export type Employment = Selectable<EmploymentsTable>;
export type ProductionOrder = Selectable<ProductionOrdersTable>;

export type Bank = Selectable<BanksTable>;
export type Loan = Selectable<LoansTable>;
export type Bond = Selectable<BondsTable>;
export type Shareholding = Selectable<ShareholdingsTable>;
export type ShareOrder = Selectable<ShareOrdersTable>;
export type PricePoint = Selectable<PriceHistoryTable>;

export type Building = Selectable<BuildingsTable>;
export type NewBuilding = Insertable<BuildingsTable>;
export type BuildingFloor = Selectable<BuildingFloorsTable>;
export type BuildingUnit = Selectable<BuildingUnitsTable>;
