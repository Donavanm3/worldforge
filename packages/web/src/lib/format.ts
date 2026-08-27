/**
 * Display formatting for values that arrive from the API as exact decimal
 * strings. Parsing to a number is acceptable here because the result is only
 * ever rendered — never sent back, never used in arithmetic that moves money.
 */

const CURRENCY_SYMBOL = '¤'; // Generic currency sign for the in-game unit.

export function formatMoney(amount: string | number, options: { compact?: boolean } = {}): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return `${CURRENCY_SYMBOL}0.00`;

  if (options.compact && Math.abs(value) >= 1_000_000) {
    return `${CURRENCY_SYMBOL}${(value / 1_000_000).toFixed(2)}M`;
  }
  if (options.compact && Math.abs(value) >= 10_000) {
    return `${CURRENCY_SYMBOL}${(value / 1_000).toFixed(1)}K`;
  }

  return `${CURRENCY_SYMBOL}${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** USD formatting for the real-money beta price. */
export function formatUsd(amount: string | number): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(2)}`;
}

export function formatArea(squareMetres: string | number): string {
  const value = typeof squareMetres === 'number' ? squareMetres : Number(squareMetres);
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} km²`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} ha`;
  return `${Math.round(value).toLocaleString('en-US')} m²`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
