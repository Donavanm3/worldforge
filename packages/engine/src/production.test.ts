import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABOUR_RATE,
  planProduction,
  unitCostFloor,
  type RecipeSpec,
} from './production.js';

const steel: RecipeSpec = {
  outputQuantity: '10',
  labourHours: '2',
  inputs: [
    { itemId: 'iron-ore', quantity: '20' },
    { itemId: 'coal', quantity: '5' },
  ],
};

describe('planProduction', () => {
  it('scales inputs, output and labour by batch count', () => {
    const plan = planProduction(steel, 3);

    expect(plan.producesQuantity).toBe('30.0000');
    expect(plan.consumes).toStrictEqual([
      { itemId: 'iron-ore', quantity: '60.0000' },
      { itemId: 'coal', quantity: '15.0000' },
    ]);
    expect(plan.labourHours).toBe(6);
  });

  it('costs labour at the given rate', () => {
    expect(planProduction(steel, 1).labourCost).toBe(String((2 * DEFAULT_LABOUR_RATE).toFixed(4)));
    expect(planProduction(steel, 2, 10).labourCost).toBe('40.0000');
  });

  it('takes longer for more batches', () => {
    expect(planProduction(steel, 4).durationMs).toBeGreaterThan(
      planProduction(steel, 1).durationMs,
    );
  });

  it('always takes some time, even for trivial labour', () => {
    const instant: RecipeSpec = { outputQuantity: '1', labourHours: '0', inputs: [] };
    expect(planProduction(instant, 1).durationMs).toBeGreaterThan(0);
  });

  it('rejects a non-positive or fractional batch count', () => {
    for (const batches of [0, -1, 1.5, Number.NaN]) {
      expect(() => planProduction(steel, batches), String(batches)).toThrow(RangeError);
    }
  });

  it('treats a negative labour rate as zero rather than paying negative wages', () => {
    expect(planProduction(steel, 1, -50).labourCost).toBe('0.0000');
  });

  it('handles a recipe with no inputs', () => {
    const mine: RecipeSpec = { outputQuantity: '5', labourHours: '1', inputs: [] };
    const plan = planProduction(mine, 2);
    expect(plan.consumes).toStrictEqual([]);
    expect(plan.producesQuantity).toBe('10.0000');
  });
});

describe('unitCostFloor', () => {
  it('includes materials and labour, per unit of output', () => {
    // (20*2 + 5*4 + 2*12) / 10 = (40 + 20 + 24) / 10 = 8.4
    const floor = unitCostFloor(steel, { 'iron-ore': '2', coal: '4' }, 12);
    expect(floor).toBe('8.4000');
  });

  it('treats unpriced inputs as free rather than NaN', () => {
    expect(unitCostFloor(steel, {}, 0)).toBe('0.0000');
  });

  it('returns zero for a recipe that outputs nothing', () => {
    const broken: RecipeSpec = { outputQuantity: '0', labourHours: '1', inputs: [] };
    expect(unitCostFloor(broken, {})).toBe('0.0000');
  });
});
