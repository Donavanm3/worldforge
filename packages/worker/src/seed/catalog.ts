import { sql } from 'kysely';
import type { Db } from '@wf/db';
import type { Industry, ItemKind } from '@wf/shared';

interface ItemSeed {
  slug: string;
  name: string;
  kind: ItemKind;
  unit: string;
  basePrice: string;
  tier: number;
}

interface RecipeSeed {
  output: string;
  outputQuantity: string;
  labourHours: string;
  industry: Industry;
  inputs: Array<{ item: string; quantity: string }>;
}

/**
 * Tier 0 items are extracted from the world; everything above is made from
 * something below it, so every product traces back to raw resources (spec 10).
 */
const ITEMS: ItemSeed[] = [
  // Tier 0 — raw resources
  { slug: 'iron-ore', name: 'Iron Ore', kind: 'resource', unit: 't', basePrice: '12', tier: 0 },
  { slug: 'coal', name: 'Coal', kind: 'resource', unit: 't', basePrice: '9', tier: 0 },
  { slug: 'copper-ore', name: 'Copper Ore', kind: 'resource', unit: 't', basePrice: '18', tier: 0 },
  { slug: 'crude-oil', name: 'Crude Oil', kind: 'resource', unit: 'bbl', basePrice: '22', tier: 0 },
  {
    slug: 'silica-sand',
    name: 'Silica Sand',
    kind: 'resource',
    unit: 't',
    basePrice: '6',
    tier: 0,
  },
  { slug: 'timber', name: 'Timber', kind: 'resource', unit: 'm³', basePrice: '14', tier: 0 },
  { slug: 'grain', name: 'Grain', kind: 'resource', unit: 't', basePrice: '11', tier: 0 },
  { slug: 'water', name: 'Water', kind: 'resource', unit: 'kL', basePrice: '2', tier: 0 },

  // Tier 1 — refined materials
  { slug: 'steel', name: 'Steel', kind: 'product', unit: 't', basePrice: '48', tier: 1 },
  {
    slug: 'copper-wire',
    name: 'Copper Wire',
    kind: 'product',
    unit: 'km',
    basePrice: '62',
    tier: 1,
  },
  { slug: 'plastic', name: 'Plastic', kind: 'product', unit: 't', basePrice: '55', tier: 1 },
  { slug: 'silicon', name: 'Silicon', kind: 'product', unit: 'kg', basePrice: '40', tier: 1 },
  { slug: 'lumber', name: 'Lumber', kind: 'product', unit: 'm³', basePrice: '34', tier: 1 },
  { slug: 'flour', name: 'Flour', kind: 'product', unit: 't', basePrice: '30', tier: 1 },

  // Tier 2 — components and goods
  {
    slug: 'machine-parts',
    name: 'Machine Parts',
    kind: 'product',
    unit: 'unit',
    basePrice: '145',
    tier: 2,
  },
  {
    slug: 'circuit-board',
    name: 'Circuit Board',
    kind: 'product',
    unit: 'unit',
    basePrice: '180',
    tier: 2,
  },
  { slug: 'bread', name: 'Bread', kind: 'product', unit: 'crate', basePrice: '78', tier: 2 },

  // Tier 3 — finished equipment
  { slug: 'computer', name: 'Computer', kind: 'product', unit: 'unit', basePrice: '620', tier: 3 },
  {
    slug: 'industrial-robot',
    name: 'Industrial Robot',
    kind: 'product',
    unit: 'unit',
    basePrice: '1450',
    tier: 3,
  },
];

const RECIPES: RecipeSeed[] = [
  // Extraction: no inputs, pure labour. This is where value enters the economy.
  { output: 'iron-ore', outputQuantity: '10', labourHours: '1', industry: 'mining', inputs: [] },
  { output: 'coal', outputQuantity: '12', labourHours: '1', industry: 'mining', inputs: [] },
  { output: 'copper-ore', outputQuantity: '8', labourHours: '1', industry: 'mining', inputs: [] },
  { output: 'silica-sand', outputQuantity: '20', labourHours: '1', industry: 'mining', inputs: [] },
  {
    output: 'crude-oil',
    outputQuantity: '10',
    labourHours: '1.5',
    industry: 'oil_and_gas',
    inputs: [],
  },
  { output: 'timber', outputQuantity: '12', labourHours: '1', industry: 'agriculture', inputs: [] },
  { output: 'grain', outputQuantity: '15', labourHours: '1', industry: 'agriculture', inputs: [] },
  { output: 'water', outputQuantity: '50', labourHours: '0.5', industry: 'energy', inputs: [] },

  // Tier 1
  {
    output: 'steel',
    outputQuantity: '10',
    labourHours: '2',
    industry: 'manufacturing',
    inputs: [
      { item: 'iron-ore', quantity: '20' },
      { item: 'coal', quantity: '8' },
    ],
  },
  {
    output: 'copper-wire',
    outputQuantity: '10',
    labourHours: '2',
    industry: 'manufacturing',
    inputs: [{ item: 'copper-ore', quantity: '15' }],
  },
  {
    output: 'plastic',
    outputQuantity: '10',
    labourHours: '2',
    industry: 'manufacturing',
    inputs: [{ item: 'crude-oil', quantity: '18' }],
  },
  {
    output: 'silicon',
    outputQuantity: '20',
    labourHours: '3',
    industry: 'manufacturing',
    inputs: [
      { item: 'silica-sand', quantity: '40' },
      { item: 'coal', quantity: '5' },
    ],
  },
  {
    output: 'lumber',
    outputQuantity: '10',
    labourHours: '1.5',
    industry: 'manufacturing',
    inputs: [{ item: 'timber', quantity: '15' }],
  },
  {
    output: 'flour',
    outputQuantity: '10',
    labourHours: '1.5',
    industry: 'agriculture',
    inputs: [{ item: 'grain', quantity: '14' }],
  },

  // Tier 2
  {
    output: 'machine-parts',
    outputQuantity: '10',
    labourHours: '4',
    industry: 'manufacturing',
    inputs: [
      { item: 'steel', quantity: '12' },
      { item: 'plastic', quantity: '4' },
    ],
  },
  {
    output: 'circuit-board',
    outputQuantity: '10',
    labourHours: '4',
    industry: 'technology',
    inputs: [
      { item: 'silicon', quantity: '15' },
      { item: 'copper-wire', quantity: '8' },
      { item: 'plastic', quantity: '3' },
    ],
  },
  {
    output: 'bread',
    outputQuantity: '10',
    labourHours: '2',
    industry: 'restaurants',
    inputs: [
      { item: 'flour', quantity: '12' },
      { item: 'water', quantity: '20' },
    ],
  },

  // Tier 3
  {
    output: 'computer',
    outputQuantity: '5',
    labourHours: '6',
    industry: 'technology',
    inputs: [
      { item: 'circuit-board', quantity: '10' },
      { item: 'plastic', quantity: '6' },
      { item: 'copper-wire', quantity: '4' },
    ],
  },
  {
    output: 'industrial-robot',
    outputQuantity: '2',
    labourHours: '10',
    industry: 'manufacturing',
    inputs: [
      { item: 'machine-parts', quantity: '15' },
      { item: 'circuit-board', quantity: '6' },
      { item: 'steel', quantity: '10' },
    ],
  },
];

export interface CatalogSummary {
  items: number;
  recipes: number;
}

/**
 * Seeds the item catalogue and production recipes.
 *
 * Safe to re-run: items upsert by slug and recipes are replaced, so the
 * catalogue can be revised without wiping player inventories that reference it.
 */
export async function seedCatalog(db: Db): Promise<CatalogSummary> {
  for (const item of ITEMS) {
    await db
      .insertInto('items')
      .values({
        slug: item.slug,
        name: item.name,
        kind: item.kind,
        unit: item.unit,
        base_price: item.basePrice,
        // A new item enters the market at its base price. Deliberately absent
        // from the conflict clause below: re-seeding must not reset the live
        // price and wipe out whatever the economy has discovered.
        market_price: sql`${item.basePrice}::numeric`,
        tier: item.tier,
      })
      .onConflict((oc) =>
        oc.column('slug').doUpdateSet({
          name: item.name,
          unit: item.unit,
          base_price: item.basePrice,
          tier: item.tier,
        }),
      )
      .execute();
  }

  const rows = await db.selectFrom('items').select(['id', 'slug']).execute();
  const idOf = new Map(rows.map((r) => [r.slug, r.id]));

  for (const recipe of RECIPES) {
    const outputId = idOf.get(recipe.output);
    if (!outputId) throw new Error(`Recipe references unknown item: ${recipe.output}`);

    const existing = await db
      .selectFrom('recipes')
      .select('id')
      .where('output_item_id', '=', outputId)
      .executeTakeFirst();

    const recipeId =
      existing?.id ??
      (
        await db
          .insertInto('recipes')
          .values({
            output_item_id: outputId,
            output_quantity: recipe.outputQuantity,
            labour_hours: recipe.labourHours,
            industry: recipe.industry,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    if (existing) {
      await db
        .updateTable('recipes')
        .set({
          output_quantity: recipe.outputQuantity,
          labour_hours: recipe.labourHours,
          industry: recipe.industry,
        })
        .where('id', '=', recipeId)
        .execute();
      await db.deleteFrom('recipe_inputs').where('recipe_id', '=', recipeId).execute();
    }

    for (const input of recipe.inputs) {
      const itemId = idOf.get(input.item);
      if (!itemId) throw new Error(`Recipe input references unknown item: ${input.item}`);
      await db
        .insertInto('recipe_inputs')
        .values({ recipe_id: recipeId, item_id: itemId, quantity: input.quantity })
        .execute();
    }
  }

  return { items: ITEMS.length, recipes: RECIPES.length };
}
