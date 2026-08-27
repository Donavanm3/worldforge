import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import { currencyExponent, fromMinorUnits, isValidAmount, toMinorUnits } from './money.js';

describe('toMinorUnits', () => {
  it('converts the default beta price', () => {
    expect(toMinorUnits('3.00', 'USD')).toBe(300);
    expect(toMinorUnits('3', 'USD')).toBe(300);
    expect(toMinorUnits('3.5', 'USD')).toBe(350);
  });

  it('handles zero and free access', () => {
    expect(toMinorUnits('0', 'USD')).toBe(0);
    expect(toMinorUnits('0.00', 'USD')).toBe(0);
  });

  it('avoids binary floating point error', () => {
    // parseFloat('1.005') * 100 is 100.49999999999999, which rounds to 100.
    expect(toMinorUnits('1.005', 'BHD')).toBe(1005);
    expect(toMinorUnits('0.07', 'USD')).toBe(7);
    expect(toMinorUnits('0.29', 'USD')).toBe(29);
    expect(toMinorUnits('1.10', 'USD')).toBe(110);
  });

  it('respects zero-decimal currencies', () => {
    expect(toMinorUnits('1000', 'JPY')).toBe(1000);
    expect(toMinorUnits('1000.0', 'JPY')).toBe(1000);
  });

  it('respects three-decimal currencies', () => {
    expect(toMinorUnits('1.234', 'KWD')).toBe(1234);
  });

  it('is case-insensitive about the currency code', () => {
    expect(toMinorUnits('3.00', 'usd')).toBe(300);
  });

  it('rejects excess precision rather than truncating', () => {
    expect(() => toMinorUnits('3.001', 'USD')).toThrow(ValidationError);
    expect(() => toMinorUnits('1000.5', 'JPY')).toThrow(ValidationError);
  });

  it('ignores trailing zeros when checking precision', () => {
    expect(toMinorUnits('3.0000', 'USD')).toBe(300);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '3.', '.5', '1,000', '1e3', ' ']) {
      expect(() => toMinorUnits(bad, 'USD'), bad).toThrow(ValidationError);
    }
  });

  it('handles negatives for refunds', () => {
    expect(toMinorUnits('-3.00', 'USD')).toBe(-300);
  });
});

describe('fromMinorUnits', () => {
  it('round-trips through toMinorUnits', () => {
    for (const [amount, currency] of [
      ['3.00', 'USD'],
      ['0.01', 'USD'],
      ['1234.56', 'USD'],
      ['1000', 'JPY'],
      ['1.234', 'KWD'],
    ] as const) {
      expect(fromMinorUnits(toMinorUnits(amount, currency), currency), currency).toBe(amount);
    }
  });

  it('pads small amounts correctly', () => {
    expect(fromMinorUnits(5, 'USD')).toBe('0.05');
    expect(fromMinorUnits(0, 'USD')).toBe('0.00');
    expect(fromMinorUnits(300, 'USD')).toBe('3.00');
  });

  it('omits the separator for zero-decimal currencies', () => {
    expect(fromMinorUnits(1000, 'JPY')).toBe('1000');
  });

  it('handles negatives', () => {
    expect(fromMinorUnits(-300, 'USD')).toBe('-3.00');
  });
});

describe('currencyExponent', () => {
  it('defaults to two decimals', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('XYZ')).toBe(2);
  });
});

describe('isValidAmount', () => {
  it('accepts valid non-negative amounts', () => {
    expect(isValidAmount('3.00', 'USD')).toBe(true);
    expect(isValidAmount('0', 'USD')).toBe(true);
  });

  it('rejects negatives and malformed values without throwing', () => {
    expect(isValidAmount('-1.00', 'USD')).toBe(false);
    expect(isValidAmount('nope', 'USD')).toBe(false);
  });
});
