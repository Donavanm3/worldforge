import { sql } from 'kysely';
import { ConflictError, NotFoundError, ValidationError } from '@wf/shared';
import type { Db } from '@wf/db';
import { planProduction, type RecipeSpec } from '@wf/engine';
import { requireCompanyOwner } from '../companies/service.js';

export async function listRecipes(db: Db) {
  const recipes = await db
    .selectFrom('recipes')
    .innerJoin('items', 'items.id', 'recipes.output_item_id')
    .select([
      'recipes.id',
      'recipes.output_quantity',
      'recipes.labour_hours',
      'recipes.industry',
      'items.id as output_item_id',
      'items.name as output_name',
      'items.slug as output_slug',
      'items.base_price as output_base_price',
    ])
    .orderBy('items.tier', 'asc')
    .orderBy('items.name', 'asc')
    .execute();

  const inputs = await db
    .selectFrom('recipe_inputs')
    .innerJoin('items', 'items.id', 'recipe_inputs.item_id')
    .select([
      'recipe_inputs.recipe_id',
      'recipe_inputs.item_id',
      'recipe_inputs.quantity',
      'items.name as item_name',
      'items.slug as item_slug',
    ])
    .execute();

  return recipes.map((recipe) => ({
    ...recipe,
    inputs: inputs.filter((i) => i.recipe_id === recipe.id),
  }));
}

async function loadRecipeSpec(db: Db, recipeId: string): Promise<RecipeSpec & { id: string }> {
  const recipe = await db
    .selectFrom('recipes')
    .selectAll()
    .where('id', '=', recipeId)
    .executeTakeFirst();
  if (!recipe) throw new NotFoundError('Recipe not found');

  const inputs = await db
    .selectFrom('recipe_inputs')
    .select(['item_id', 'quantity'])
    .where('recipe_id', '=', recipeId)
    .execute();

  return {
    id: recipe.id,
    outputQuantity: String(recipe.output_quantity),
    labourHours: String(recipe.labour_hours),
    inputs: inputs.map((i) => ({ itemId: i.item_id, quantity: String(i.quantity) })),
  };
}

/**
 * Starts a production run.
 *
 * Materials and wages are taken immediately, not on completion, so a company
 * cannot queue runs it has no stock for and have them all succeed later. Output
 * lands in inventory when the run is collected.
 */
export async function startProduction(
  db: Db,
  userId: string,
  companyId: string,
  recipeId: string,
  batches: number,
): Promise<{ orderId: string; completesAt: Date; labourCost: string }> {
  if (!Number.isInteger(batches) || batches < 1) {
    throw new ValidationError('Batches must be a positive whole number');
  }
  await requireCompanyOwner(db, userId, companyId);

  const recipe = await loadRecipeSpec(db, recipeId);
  const plan = planProduction(recipe, batches);

  return db.transaction().execute(async (trx) => {
    for (const consumed of plan.consumes) {
      const taken = await trx
        .updateTable('inventory')
        .set({ quantity: sql`quantity - ${consumed.quantity}::numeric`, updated_at: sql`now()` })
        .where('company_id', '=', companyId)
        .where('item_id', '=', consumed.itemId)
        .where(sql<boolean>`quantity >= ${consumed.quantity}::numeric`)
        .executeTakeFirst();

      if (taken.numUpdatedRows !== 1n) {
        const item = await trx
          .selectFrom('items')
          .select('name')
          .where('id', '=', consumed.itemId)
          .executeTakeFirst();
        throw new ConflictError(`Not enough ${item?.name ?? 'materials'} in stock`);
      }
    }

    if (Number(plan.labourCost) > 0) {
      const paid = await trx
        .updateTable('companies')
        .set({ cash: sql`cash - ${plan.labourCost}::numeric`, updated_at: sql`now()` })
        .where('id', '=', companyId)
        .where(sql<boolean>`cash >= ${plan.labourCost}::numeric`)
        .executeTakeFirst();

      if (paid.numUpdatedRows !== 1n) {
        throw new ConflictError(`Not enough cash to pay wages of ${plan.labourCost}`);
      }
    }

    const completesAt = new Date(Date.now() + plan.durationMs);
    const order = await trx
      .insertInto('production_orders')
      .values({
        company_id: companyId,
        recipe_id: recipeId,
        batches,
        labour_cost: sql`${plan.labourCost}::numeric`,
        completes_at: completesAt,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return { orderId: order.id, completesAt, labourCost: plan.labourCost };
  });
}

/**
 * Delivers the output of any runs that have finished.
 *
 * Called on read for now. The scheduled tick that will drive this arrives with
 * the economy engine (spec 42); until then, collecting on demand keeps the
 * behaviour correct without pretending a scheduler exists.
 */
export async function collectCompletedRuns(db: Db, companyId: string): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('production_orders')
      .innerJoin('recipes', 'recipes.id', 'production_orders.recipe_id')
      .select([
        'production_orders.id',
        'production_orders.batches',
        'recipes.output_item_id',
        'recipes.output_quantity',
      ])
      .where('production_orders.company_id', '=', companyId)
      .where('production_orders.status', '=', 'running')
      .where(sql<boolean>`production_orders.completes_at <= now()`)
      .forUpdate()
      .execute();

    for (const run of due) {
      const produced = (Number(run.output_quantity) * run.batches).toFixed(4);

      await trx
        .insertInto('inventory')
        .values({
          company_id: companyId,
          item_id: run.output_item_id,
          quantity: sql`${produced}::numeric`,
        })
        .onConflict((oc) =>
          oc.columns(['company_id', 'item_id']).doUpdateSet({
            quantity: sql`inventory.quantity + ${produced}::numeric`,
            updated_at: sql`now()`,
          }),
        )
        .execute();

      await trx
        .updateTable('production_orders')
        .set({ status: 'completed', collected_at: new Date() })
        .where('id', '=', run.id)
        .execute();
    }

    return due.length;
  });
}

export async function listProductionOrders(db: Db, companyId: string) {
  // Deliver anything finished before reporting, so the list is never stale.
  await collectCompletedRuns(db, companyId);

  return db
    .selectFrom('production_orders')
    .innerJoin('recipes', 'recipes.id', 'production_orders.recipe_id')
    .innerJoin('items', 'items.id', 'recipes.output_item_id')
    .select([
      'production_orders.id',
      'production_orders.batches',
      'production_orders.status',
      'production_orders.labour_cost',
      'production_orders.started_at',
      'production_orders.completes_at',
      'items.name as output_name',
      'recipes.output_quantity',
    ])
    .where('production_orders.company_id', '=', companyId)
    .orderBy('production_orders.started_at', 'desc')
    .limit(50)
    .execute();
}
