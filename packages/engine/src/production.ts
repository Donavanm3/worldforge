import { toMoneyString } from './land.js';

export interface RecipeSpec {
  outputQuantity: string;
  labourHours: string;
  inputs: Array<{ itemId: string; quantity: string }>;
}

export interface ProductionPlan {
  batches: number;
  /** Item quantities consumed up front. */
  consumes: Array<{ itemId: string; quantity: string }>;
  producesQuantity: string;
  labourHours: number;
  labourCost: string;
  durationMs: number;
}

/** Game-minutes of wall-clock time per worker-hour of labour. */
const MINUTES_PER_LABOUR_HOUR = 2;

/** Wage paid per labour-hour when a company has no employees to do the work. */
export const DEFAULT_LABOUR_RATE = 12;

/**
 * Expands a recipe into a concrete production plan.
 *
 * Inputs are consumed up front rather than on completion so a company cannot
 * queue ten runs it lacks the materials for and have them all succeed later.
 *
 * Pure, so cost and duration are testable without a database.
 */
export function planProduction(
  recipe: RecipeSpec,
  batches: number,
  labourRate: number = DEFAULT_LABOUR_RATE,
): ProductionPlan {
  if (!Number.isInteger(batches) || batches < 1) {
    throw new RangeError('batches must be a positive integer');
  }

  const labourHours = Number(recipe.labourHours) * batches;
  const rate = Math.max(0, labourRate);

  return {
    batches,
    consumes: recipe.inputs.map((input) => ({
      itemId: input.itemId,
      quantity: toMoneyString(Number(input.quantity) * batches),
    })),
    producesQuantity: toMoneyString(Number(recipe.outputQuantity) * batches),
    labourHours,
    labourCost: toMoneyString(labourHours * rate),
    durationMs: Math.max(1_000, Math.round(labourHours * MINUTES_PER_LABOUR_HOUR * 60_000)),
  };
}

/**
 * Cost floor for one unit of output: materials at their base price plus labour.
 * Used to seed sensible starting prices and to tell a player when they are
 * selling below cost.
 */
export function unitCostFloor(
  recipe: RecipeSpec,
  inputBasePrices: Record<string, string>,
  labourRate: number = DEFAULT_LABOUR_RATE,
): string {
  const materials = recipe.inputs.reduce((sum, input) => {
    const price = Number(inputBasePrices[input.itemId] ?? 0);
    return sum + price * Number(input.quantity);
  }, 0);

  const labour = Number(recipe.labourHours) * Math.max(0, labourRate);
  const output = Number(recipe.outputQuantity);

  if (!Number.isFinite(output) || output <= 0) return '0.0000';
  return toMoneyString((materials + labour) / output);
}
