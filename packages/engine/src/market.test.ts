import { describe, expect, it } from 'vitest';
import { matchOrder, maxBuyCost, sortBook, type BookOrder } from './market.js';

function order(
  id: string,
  price: string,
  remaining: string,
  companyId = `co-${id}`,
  createdAt = 0,
): BookOrder {
  return { id, companyId, price, remaining, createdAt };
}

describe('sortBook', () => {
  it('ranks sells cheapest first', () => {
    const sorted = sortBook([order('a', '5'), order('b', '3'), order('c', '4')], 'sell');
    expect(sorted.map((o) => o.id)).toStrictEqual(['b', 'c', 'a']);
  });

  it('ranks buys highest first', () => {
    const sorted = sortBook([order('a', '5'), order('b', '3'), order('c', '4')], 'buy');
    expect(sorted.map((o) => o.id)).toStrictEqual(['a', 'c', 'b']);
  });

  it('breaks price ties by age, oldest first', () => {
    const sorted = sortBook(
      [order('new', '5', '10', 'co-1', 200), order('old', '5', '10', 'co-2', 100)],
      'sell',
    );
    expect(sorted.map((o) => o.id)).toStrictEqual(['old', 'new']);
  });

  it('does not mutate the input', () => {
    const book = [order('a', '5'), order('b', '3')];
    sortBook(book, 'sell');
    expect(book.map((o) => o.id)).toStrictEqual(['a', 'b']);
  });
});

describe('matchOrder', () => {
  it('fills a buy against the cheapest sell', () => {
    const result = matchOrder({ side: 'buy', price: '10', quantity: '5', companyId: 'buyer' }, [
      order('s1', '8', '5'),
      order('s2', '6', '5'),
    ]);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.orderId).toBe('s2');
    expect(result.filledQuantity).toBe('5.0000');
    expect(result.remainingQuantity).toBe('0.0000');
    expect(result.totalValue).toBe('30.0000');
  });

  it('executes at the resting price, not the incoming limit', () => {
    // The buyer is willing to pay 10 but the book offers 6; they pay 6.
    const result = matchOrder({ side: 'buy', price: '10', quantity: '1', companyId: 'buyer' }, [
      order('s1', '6', '1'),
    ]);
    expect(result.fills[0]!.price).toBe('6.0000');
    expect(result.totalValue).toBe('6.0000');
  });

  it('walks multiple levels when one is not enough', () => {
    const result = matchOrder({ side: 'buy', price: '10', quantity: '8', companyId: 'buyer' }, [
      order('s1', '6', '5'),
      order('s2', '7', '5'),
    ]);

    expect(result.fills.map((f) => [f.orderId, f.quantity])).toStrictEqual([
      ['s1', '5.0000'],
      ['s2', '3.0000'],
    ]);
    // 5 @ 6 + 3 @ 7 = 51
    expect(result.totalValue).toBe('51.0000');
    expect(result.remainingQuantity).toBe('0.0000');
  });

  it('stops at the limit price and leaves the rest unfilled', () => {
    const result = matchOrder({ side: 'buy', price: '6', quantity: '10', companyId: 'buyer' }, [
      order('s1', '6', '4'),
      order('s2', '9', '10'),
    ]);

    expect(result.fills).toHaveLength(1);
    expect(result.filledQuantity).toBe('4.0000');
    expect(result.remainingQuantity).toBe('6.0000');
  });

  it('fills a sell against the highest buy', () => {
    const result = matchOrder({ side: 'sell', price: '5', quantity: '3', companyId: 'seller' }, [
      order('b1', '6', '3'),
      order('b2', '9', '3'),
    ]);

    expect(result.fills[0]!.orderId).toBe('b2');
    expect(result.fills[0]!.price).toBe('9.0000');
    expect(result.totalValue).toBe('27.0000');
  });

  it('refuses to match a company with itself', () => {
    // Wash trading would let one player fake volume and move prices for free.
    const result = matchOrder({ side: 'buy', price: '10', quantity: '5', companyId: 'same' }, [
      order('s1', '6', '5', 'same'),
    ]);

    expect(result.fills).toHaveLength(0);
    expect(result.remainingQuantity).toBe('5.0000');
  });

  it('skips a self order but still matches others behind it', () => {
    const result = matchOrder({ side: 'buy', price: '10', quantity: '5', companyId: 'same' }, [
      order('s1', '6', '5', 'same'),
      order('s2', '7', '5', 'other'),
    ]);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.orderId).toBe('s2');
  });

  it('returns nothing against an empty book', () => {
    const result = matchOrder({ side: 'buy', price: '10', quantity: '5', companyId: 'b' }, []);
    expect(result.fills).toHaveLength(0);
    expect(result.filledQuantity).toBe('0.0000');
    expect(result.remainingQuantity).toBe('5.0000');
  });

  it('ignores exhausted orders', () => {
    const result = matchOrder({ side: 'buy', price: '10', quantity: '5', companyId: 'b' }, [
      order('s1', '6', '0'),
      order('s2', '7', '5'),
    ]);
    expect(result.fills.map((f) => f.orderId)).toStrictEqual(['s2']);
  });

  it('conserves quantity: filled + remaining always equals the request', () => {
    const cases: Array<[string, BookOrder[]]> = [
      ['5', [order('s1', '6', '2'), order('s2', '7', '2')]],
      ['10', [order('s1', '6', '20')]],
      ['3.5', [order('s1', '6', '1.25'), order('s2', '6.5', '10')]],
    ];

    for (const [quantity, book] of cases) {
      const result = matchOrder({ side: 'buy', price: '99', quantity, companyId: 'b' }, book);
      const total = Number(result.filledQuantity) + Number(result.remainingQuantity);
      expect(total, `quantity ${quantity}`).toBeCloseTo(Number(quantity), 4);
    }
  });

  it('handles fractional prices and quantities exactly', () => {
    // 0.1 * 3 is 0.30000000000000004 in float arithmetic.
    const result = matchOrder({ side: 'buy', price: '1', quantity: '3', companyId: 'b' }, [
      order('s1', '0.1', '3'),
    ]);
    expect(result.totalValue).toBe('0.3000');
  });

  it('never charges more than the fill quantity times price', () => {
    const result = matchOrder(
      { side: 'buy', price: '3.3333', quantity: '7.7777', companyId: 'b' },
      [order('s1', '3.3333', '7.7777')],
    );
    const fill = result.fills[0]!;
    // Truncation must go toward zero so the buyer is never overcharged.
    expect(Number(fill.value)).toBeLessThanOrEqual(Number(fill.quantity) * Number(fill.price));
  });
});

describe('maxBuyCost', () => {
  it('computes the worst-case reservation', () => {
    expect(maxBuyCost('10', '2.5')).toBe('25.0000');
    expect(maxBuyCost('3', '0.1')).toBe('0.3000');
  });
});
