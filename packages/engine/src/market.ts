import type { OrderSide } from '@wf/shared';

/**
 * An open order as the matcher sees it. Quantities and prices are decimal
 * strings from the database; the matcher converts once, works in integers
 * scaled by SCALE, and hands back strings so no rounding drifts back into
 * money columns.
 */
export interface BookOrder {
  id: string;
  companyId: string;
  price: string;
  remaining: string;
  /** Tie-breaker: earlier orders fill first at equal price. */
  createdAt: number;
}

export interface Fill {
  orderId: string;
  companyId: string;
  quantity: string;
  price: string;
  /** Total consideration for this fill, quantity * price. */
  value: string;
}

export interface MatchResult {
  fills: Fill[];
  filledQuantity: string;
  remainingQuantity: string;
  totalValue: string;
}

/** Four decimal places, matching the `numeric(20,4)` money and quantity columns. */
const SCALE = 10_000n;

function toScaled(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.');
  // Pad or truncate to exactly 4 dp; the database never stores more.
  const padded = fraction.padEnd(4, '0').slice(0, 4);
  const scaled = BigInt(`${whole || '0'}${padded}`);
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, '0');
  const whole = digits.slice(0, digits.length - 4);
  const fraction = digits.slice(digits.length - 4);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Multiplies two scaled values, keeping the result scaled once.
 *
 * (a*S) * (b*S) = a*b*S², so divide by S. Truncation here is deliberate and
 * always toward zero, so a fill's value can never exceed what the counterparty
 * agreed to pay.
 */
function mulScaled(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

/**
 * Sorts a book so the best counterparty comes first: sellers cheapest-first,
 * buyers highest-first, then oldest-first at equal price.
 */
export function sortBook(orders: BookOrder[], side: OrderSide): BookOrder[] {
  return [...orders].sort((a, b) => {
    const priceA = toScaled(a.price);
    const priceB = toScaled(b.price);
    if (priceA !== priceB) {
      // Matching a buy walks the sell book, so cheapest sells rank first.
      return side === 'sell' ? (priceA < priceB ? -1 : 1) : priceA > priceB ? -1 : 1;
    }
    return a.createdAt - b.createdAt;
  });
}

/**
 * Matches an incoming order against a resting book.
 *
 * Rules:
 *  - A buy crosses sells priced at or below its limit; a sell crosses buys at
 *    or above.
 *  - Trades execute at the **resting** order's price, so the party who posted
 *    first sets the terms and a late order cannot improve on its own limit.
 *  - A company never trades with itself; such orders are skipped rather than
 *    matched, which would let a player wash-trade to fake volume.
 *
 * Pure: no I/O, so the whole price-time priority policy is unit-testable.
 */
export function matchOrder(
  incoming: { side: OrderSide; price: string; quantity: string; companyId: string },
  book: BookOrder[],
): MatchResult {
  const limit = toScaled(incoming.price);
  let unfilled = toScaled(incoming.quantity);

  const fills: Fill[] = [];
  let totalValue = 0n;
  let filled = 0n;

  const restingSide: OrderSide = incoming.side === 'buy' ? 'sell' : 'buy';

  for (const order of sortBook(book, restingSide)) {
    if (unfilled <= 0n) break;
    if (order.companyId === incoming.companyId) continue;

    const restingPrice = toScaled(order.price);
    const crosses = incoming.side === 'buy' ? restingPrice <= limit : restingPrice >= limit;
    if (!crosses) break; // The book is sorted, so nothing further can cross.

    const available = toScaled(order.remaining);
    if (available <= 0n) continue;

    const quantity = available < unfilled ? available : unfilled;
    const value = mulScaled(quantity, restingPrice);

    fills.push({
      orderId: order.id,
      companyId: order.companyId,
      quantity: fromScaled(quantity),
      price: fromScaled(restingPrice),
      value: fromScaled(value),
    });

    unfilled -= quantity;
    filled += quantity;
    totalValue += value;
  }

  return {
    fills,
    filledQuantity: fromScaled(filled),
    remainingQuantity: fromScaled(unfilled),
    totalValue: fromScaled(totalValue),
  };
}

/**
 * Worst-case cost of a buy order: what must be reserved before matching.
 * Uses the limit price for the unfilled remainder, so a partially filled order
 * can never leave the buyer unable to pay.
 */
export function maxBuyCost(quantity: string, price: string): string {
  return fromScaled(mulScaled(toScaled(quantity), toScaled(price)));
}

export { fromScaled as scaledToString, toScaled as stringToScaled };
