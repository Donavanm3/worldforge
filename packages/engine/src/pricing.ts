import type { PriceSignal } from '@wf/shared';
import { toMoneyString } from './land.js';

/**
 * Supply and demand pricing (spec 11).
 *
 * Deliberately a configurable formula rather than randomness: a shortage must
 * reliably raise prices so players can reason about cause and effect, and so
 * the chain "oil falls -> fuel rises -> transport costs rise -> food rises"
 * actually holds.
 */
export interface PricingConfig {
  /** How hard imbalance pushes price. 0 disables movement entirely. */
  sensitivity: number;
  /** Largest fractional move allowed in one tick, up or down. */
  maxStep: number;
  /** Pull back toward base price when nobody is trading. */
  reversion: number;
  /** Price floor and ceiling as multiples of the item's base price. */
  floorMultiple: number;
  ceilingMultiple: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  sensitivity: 0.35,
  maxStep: 0.15,
  reversion: 0.05,
  floorMultiple: 0.25,
  ceilingMultiple: 6,
};

/**
 * Imbalance in [-1, 1]: +1 is pure demand with no supply, -1 the reverse.
 *
 * Using the normalised difference rather than a raw ratio keeps the signal
 * bounded, so a single enormous order cannot move the price arbitrarily far.
 */
export function imbalance(signal: PriceSignal): number {
  const supply = Math.max(0, signal.supply);
  const demand = Math.max(0, signal.demand);
  const total = supply + demand;
  if (total === 0) return 0;
  return (demand - supply) / total;
}

/**
 * Computes the next price for an item.
 *
 * With no book at all the price drifts back toward base, so an abandoned market
 * recovers instead of staying stuck wherever the last trade left it.
 */
export function nextPrice(
  currentPrice: string | number,
  basePrice: string | number,
  signal: PriceSignal,
  config: PricingConfig = DEFAULT_PRICING,
): string {
  const current = Number(currentPrice);
  const base = Number(basePrice);

  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(base) || base <= 0) {
    return toMoneyString(Math.max(0, base));
  }

  const pressure = imbalance(signal);
  const hasBook = signal.supply + signal.demand > 0;

  // Imbalance moves the price; with an empty book, mean reversion instead.
  const move = hasBook
    ? clamp(pressure * config.sensitivity, -config.maxStep, config.maxStep)
    : clamp((base - current) / current, -config.reversion, config.reversion);

  const proposed = current * (1 + move);
  const floor = base * config.floorMultiple;
  const ceiling = base * config.ceilingMultiple;

  return toMoneyString(clamp(proposed, floor, ceiling));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A simple price index across items, expressed relative to base prices.
 *
 * 1.0 means the economy is trading at its baseline; above that is inflation.
 */
export function priceIndex(
  items: Array<{ price: string | number; basePrice: string | number; weight?: number }>,
): number {
  let weighted = 0;
  let totalWeight = 0;

  for (const item of items) {
    const price = Number(item.price);
    const base = Number(item.basePrice);
    const weight = item.weight ?? 1;
    if (!Number.isFinite(price) || !Number.isFinite(base) || base <= 0 || weight <= 0) continue;
    weighted += (price / base) * weight;
    totalWeight += weight;
  }

  return totalWeight === 0 ? 1 : weighted / totalWeight;
}

/**
 * Simple interest accrued over a period, as an exact money string.
 * Rates are annual fractions; periods are in days.
 */
export function accrueInterest(
  principal: string | number,
  annualRate: string | number,
  days: number,
): string {
  const amount = Number(principal);
  const rate = Number(annualRate);
  if (!Number.isFinite(amount) || amount <= 0) return '0.0000';
  if (!Number.isFinite(rate) || rate <= 0 || days <= 0) return '0.0000';
  return toMoneyString((amount * rate * days) / 365);
}
