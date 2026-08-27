/**
 * Core domain enums.
 *
 * These live in @wf/shared rather than @wf/db because they are game concepts,
 * not storage details: the engine and the frontend need them without taking a
 * dependency on the database layer.
 */

export type UserRole = 'player' | 'moderator' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'banned' | 'deleted';
export type AccessSource = 'payment' | 'admin';
export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';
export type GameStatus = 'BETA' | 'RELEASED' | 'MAINTENANCE' | 'REGISTRATION_CLOSED';

export type LandZoning =
  'unzoned' | 'residential' | 'commercial' | 'industrial' | 'agricultural' | 'infrastructure';

export const LAND_ZONINGS: readonly LandZoning[] = [
  'unzoned',
  'residential',
  'commercial',
  'industrial',
  'agricultural',
  'infrastructure',
];

export const GAME_STATUSES: readonly GameStatus[] = [
  'BETA',
  'RELEASED',
  'MAINTENANCE',
  'REGISTRATION_CLOSED',
];

/** A map viewport, as [west, south, east, north] in WGS84 degrees. */
export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

// --- Phase 2: companies and the production economy ---

export type Industry =
  | 'agriculture'
  | 'mining'
  | 'oil_and_gas'
  | 'energy'
  | 'manufacturing'
  | 'construction'
  | 'transportation'
  | 'logistics'
  | 'retail'
  | 'restaurants'
  | 'finance'
  | 'technology'
  | 'software'
  | 'telecommunications'
  | 'healthcare'
  | 'entertainment'
  | 'media'
  | 'real_estate';

export const INDUSTRIES: readonly Industry[] = [
  'agriculture',
  'mining',
  'oil_and_gas',
  'energy',
  'manufacturing',
  'construction',
  'transportation',
  'logistics',
  'retail',
  'restaurants',
  'finance',
  'technology',
  'software',
  'telecommunications',
  'healthcare',
  'entertainment',
  'media',
  'real_estate',
];

/**
 * Resources and products are the same thing to inventory, recipes and the
 * market — only their origin differs. Modelling them as one `items` table with
 * a kind discriminator avoids duplicating every one of those systems.
 */
export type ItemKind = 'resource' | 'product';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'filled' | 'cancelled';
export type ProductionStatus = 'running' | 'completed' | 'cancelled';
export type EmploymentStatus = 'active' | 'resigned' | 'terminated';
