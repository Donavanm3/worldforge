import { describe, expect, it } from 'vitest';
import { BuildingPlanError, planBuilding, unitValue } from './building.js';

const base = { parcelAreaSqm: 2000, footprintSqm: 1000, floors: 5, type: 'office' as const };

describe('planBuilding', () => {
  it('lays out one floor per storey, ground floor first', () => {
    const plan = planBuilding(base);
    expect(plan.floors).toHaveLength(5);
    expect(plan.floors.map((f) => f.level)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reserves a service core, so net area is below gross', () => {
    const plan = planBuilding(base);
    expect(plan.netFloorAreaSqm).toBeLessThan(plan.grossFloorAreaSqm);
    expect(plan.netFloorAreaSqm).toBeCloseTo(plan.grossFloorAreaSqm * 0.82, 0);
  });

  it('divides every floor fully into units', () => {
    const plan = planBuilding(base);
    for (const floor of plan.floors) {
      const total = floor.units.reduce((sum, unit) => sum + unit.areaSqm, 0);
      expect(total).toBeCloseTo(floor.floorAreaSqm, 0);
    }
  });

  it('gives each unit a unique label', () => {
    const plan = planBuilding(base);
    const labels = plan.floors.flatMap((floor) => floor.units.map((unit) => unit.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('0-01');
  });

  it('charges more per floor as the building climbs', () => {
    const low = planBuilding({ ...base, floors: 1 });
    const high = planBuilding({ ...base, floors: 20 });
    const lowPerFloor = low.constructionCost / 1;
    const highPerFloor = high.constructionCost / 20;
    expect(highPerFloor).toBeGreaterThan(lowPerFloor);
  });

  it('costs more on expensive land', () => {
    const cheap = planBuilding({ ...base, landRatePerSqm: 0.4 });
    const dear = planBuilding({ ...base, landRatePerSqm: 1.6 });
    expect(dear.constructionCost).toBeGreaterThan(cheap.constructionCost);
  });

  it('puts shops at street level in a mixed-use block and homes above', () => {
    const plan = planBuilding({ ...base, type: 'mixed_use' });
    expect(plan.floors[0]!.use).toBe('shop');
    expect(plan.floors[1]!.use).toBe('apartment');
  });

  it('always yields at least one unit per floor, however small the plot', () => {
    const plan = planBuilding({ parcelAreaSqm: 60, footprintSqm: 40, floors: 2, type: 'retail' });
    for (const floor of plan.floors) {
      expect(floor.units.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('takes longer to build the taller it is', () => {
    expect(planBuilding({ ...base, floors: 30 }).buildMinutes).toBeGreaterThan(
      planBuilding({ ...base, floors: 3 }).buildMinutes,
    );
  });

  it('refuses to cover more than 70% of the parcel', () => {
    expect(() => planBuilding({ ...base, footprintSqm: 1500 })).toThrow(BuildingPlanError);
  });

  it('refuses impossible floor counts', () => {
    expect(() => planBuilding({ ...base, floors: 0 })).toThrow(BuildingPlanError);
    expect(() => planBuilding({ ...base, floors: 121 })).toThrow(BuildingPlanError);
    expect(() => planBuilding({ ...base, floors: 2.5 })).toThrow(BuildingPlanError);
  });
});

describe('unitValue', () => {
  it('devalues shops as they climb away from the street', () => {
    const ground = unitValue({ areaSqm: 100, use: 'shop', level: 0 });
    const tenth = unitValue({ areaSqm: 100, use: 'shop', level: 10 });
    expect(tenth).toBeLessThan(ground);
  });

  it('rewards height for apartments', () => {
    const ground = unitValue({ areaSqm: 100, use: 'apartment', level: 0 });
    const twentieth = unitValue({ areaSqm: 100, use: 'apartment', level: 20 });
    expect(twentieth).toBeGreaterThan(ground);
  });

  it('scales with area', () => {
    const small = unitValue({ areaSqm: 50, use: 'office', level: 3 });
    const large = unitValue({ areaSqm: 100, use: 'office', level: 3 });
    expect(large).toBeCloseTo(small * 2, 1);
  });

  it('never lets a shop fall below the floor discount', () => {
    const veryHigh = unitValue({ areaSqm: 100, use: 'shop', level: 100 });
    const ground = unitValue({ areaSqm: 100, use: 'shop', level: 0 });
    expect(veryHigh).toBeCloseTo(ground * 0.55, 1);
  });
});
