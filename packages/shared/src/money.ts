import { ValidationError } from './errors.js';

/**
 * Currencies whose minor unit is not 1/100. Zero-decimal currencies are billed
 * as whole units by every major processor, and getting this wrong overcharges
 * by 100x.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BIF: 0,
  DJF: 0,
  GNF: 0,
  KMF: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Converts a decimal money string to integer minor units (e.g. "3.00" USD -> 300).
 *
 * Works on the digit string rather than going through a float, because
 * `Math.round(parseFloat("1.005") * 100)` is 100 rather than 101 — a rounding
 * error that would silently misbill.
 *
 * Throws if the amount carries more precision than the currency can express, so
 * a bad price in the settings table fails loudly instead of being truncated.
 */
export function toMinorUnits(amount: string, currency: string): number {
  const trimmed = amount.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new ValidationError(`Invalid monetary amount: ${amount}`);
  }

  const exponent = currencyExponent(currency);
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.');

  if (fraction.replace(/0+$/, '').length > exponent) {
    throw new ValidationError(
      `${currency.toUpperCase()} supports at most ${exponent} decimal places, got ${amount}`,
    );
  }

  const padded = fraction.padEnd(exponent, '0').slice(0, exponent);
  const minor = Number(`${whole}${padded}`);

  if (!Number.isSafeInteger(minor)) {
    throw new ValidationError(`Monetary amount out of range: ${amount}`);
  }

  return negative ? -minor : minor;
}

/** Inverse of {@link toMinorUnits}: 300 USD minor units -> "3.00". */
export function fromMinorUnits(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new ValidationError(`Invalid minor-unit amount: ${minor}`);
  }

  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, '0');

  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;

  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** True when the amount is a well-formed, non-negative money string. */
export function isValidAmount(amount: string, currency: string): boolean {
  try {
    return toMinorUnits(amount, currency) >= 0;
  } catch {
    return false;
  }
}
