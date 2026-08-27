import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, accrueInterest, imbalance, nextPrice, priceIndex } from './pricing.js';

const quiet = { supply: 0, demand: 0, volume: 0 };

describe('imbalance', () => {
  it('is zero when supply matches demand', () => {
    expect(imbalance({ supply: 100, demand: 100, volume: 0 })).toBe(0);
  });

  it('is positive under shortage and negative under glut', () => {
    expect(imbalance({ supply: 0, demand: 100, volume: 0 })).toBe(1);
    expect(imbalance({ supply: 100, demand: 0, volume: 0 })).toBe(-1);
  });

  it('stays bounded no matter how lopsided the book', () => {
    expect(imbalance({ supply: 1, demand: 1_000_000, volume: 0 })).toBeLessThanOrEqual(1);
  });

  it('is zero for an empty book', () => {
    expect(imbalance(quiet)).toBe(0);
  });
});

describe('nextPrice', () => {
  it('raises the price when demand exceeds supply', () => {
    const next = Number(nextPrice('100', '100', { supply: 10, demand: 90, volume: 5 }));
    expect(next).toBeGreaterThan(100);
  });

  it('lowers the price when supply exceeds demand', () => {
    const next = Number(nextPrice('100', '100', { supply: 90, demand: 10, volume: 5 }));
    expect(next).toBeLessThan(100);
  });

  it('never moves further than maxStep in one tick', () => {
    const next = Number(nextPrice('100', '100', { supply: 0, demand: 1_000_000, volume: 0 }));
    expect(next).toBeLessThanOrEqual(100 * (1 + DEFAULT_PRICING.maxStep) + 0.0001);
  });

  it('reverts toward base when nobody is trading', () => {
    // A market abandoned above base drifts down, and below base drifts up.
    expect(Number(nextPrice('200', '100', quiet))).toBeLessThan(200);
    expect(Number(nextPrice('50', '100', quiet))).toBeGreaterThan(50);
  });

  it('respects the floor and ceiling', () => {
    let price = '100';
    for (let i = 0; i < 200; i += 1) {
      price = nextPrice(price, '100', { supply: 0, demand: 1000, volume: 0 });
    }
    expect(Number(price)).toBeLessThanOrEqual(100 * DEFAULT_PRICING.ceilingMultiple + 0.0001);

    price = '100';
    for (let i = 0; i < 200; i += 1) {
      price = nextPrice(price, '100', { supply: 1000, demand: 0, volume: 0 });
    }
    expect(Number(price)).toBeGreaterThanOrEqual(100 * DEFAULT_PRICING.floorMultiple - 0.0001);
  });

  it('never returns a non-positive price', () => {
    let price = '100';
    for (let i = 0; i < 500; i += 1) {
      price = nextPrice(price, '100', { supply: 1e9, demand: 0, volume: 0 });
      expect(Number(price)).toBeGreaterThan(0);
    }
  });

  it('recovers from malformed input rather than propagating NaN', () => {
    expect(nextPrice('not-a-number', '50', quiet)).toBe('50.0000');
    expect(nextPrice('0', '50', quiet)).toBe('50.0000');
    expect(nextPrice('-10', '50', quiet)).toBe('50.0000');
  });

  it('is deterministic', () => {
    const signal = { supply: 30, demand: 70, volume: 10 };
    expect(nextPrice('100', '100', signal)).toBe(nextPrice('100', '100', signal));
  });

  it('honours a zero-sensitivity config', () => {
    const frozen = { ...DEFAULT_PRICING, sensitivity: 0 };
    expect(nextPrice('100', '100', { supply: 0, demand: 999, volume: 0 }, frozen)).toBe('100.0000');
  });
});

describe('priceIndex', () => {
  it('is 1 when everything trades at base', () => {
    expect(
      priceIndex([
        { price: 10, basePrice: 10 },
        { price: 20, basePrice: 20 },
      ]),
    ).toBeCloseTo(1, 6);
  });

  it('rises above 1 under inflation', () => {
    expect(priceIndex([{ price: 20, basePrice: 10 }])).toBeCloseTo(2, 6);
  });

  it('weights items', () => {
    const index = priceIndex([
      { price: 20, basePrice: 10, weight: 3 },
      { price: 10, basePrice: 10, weight: 1 },
    ]);
    expect(index).toBeCloseTo((2 * 3 + 1 * 1) / 4, 6);
  });

  it('ignores malformed entries instead of returning NaN', () => {
    expect(
      priceIndex([
        { price: 10, basePrice: 0 },
        { price: 20, basePrice: 10 },
      ]),
    ).toBeCloseTo(2, 6);
    expect(priceIndex([])).toBe(1);
  });
});

describe('accrueInterest', () => {
  it('computes simple interest over a period', () => {
    // 1000 at 10% for 365 days = 100
    expect(accrueInterest('1000', '0.1', 365)).toBe('100.0000');
    expect(accrueInterest('1000', '0.1', 36.5)).toBe('10.0000');
  });

  it('returns nothing for zero rate, zero days or bad input', () => {
    expect(accrueInterest('1000', '0', 365)).toBe('0.0000');
    expect(accrueInterest('1000', '0.1', 0)).toBe('0.0000');
    expect(accrueInterest('0', '0.1', 365)).toBe('0.0000');
    expect(accrueInterest('abc', '0.1', 365)).toBe('0.0000');
  });
});
