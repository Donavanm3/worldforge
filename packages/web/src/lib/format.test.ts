import { describe, expect, it } from 'vitest';
import { formatArea, formatDate, formatMoney, formatUsd, titleCase } from './format.js';

describe('formatMoney', () => {
  it('formats exact decimal strings from the API', () => {
    expect(formatMoney('10000.0000')).toBe('¤10,000.00');
    expect(formatMoney('3.5')).toBe('¤3.50');
    expect(formatMoney('0')).toBe('¤0.00');
  });

  it('compacts large values when asked', () => {
    expect(formatMoney('2500000', { compact: true })).toBe('¤2.50M');
    expect(formatMoney('45000', { compact: true })).toBe('¤45.0K');
    // Below the threshold it stays exact.
    expect(formatMoney('9999', { compact: true })).toBe('¤9,999.00');
  });

  it('degrades gracefully on malformed input', () => {
    expect(formatMoney('not-a-number')).toBe('¤0.00');
    expect(formatMoney('')).toBe('¤0.00');
  });

  it('handles negatives', () => {
    expect(formatMoney('-250.5')).toBe('¤-250.50');
  });
});

describe('formatUsd', () => {
  it('formats the beta price', () => {
    expect(formatUsd('3.00')).toBe('$3.00');
    expect(formatUsd('5')).toBe('$5.00');
  });

  it('degrades gracefully', () => {
    expect(formatUsd('free')).toBe('$0.00');
  });
});

describe('formatArea', () => {
  it('picks a sensible unit', () => {
    expect(formatArea('850')).toBe('850 m²');
    expect(formatArea('50000')).toBe('5.00 ha');
    expect(formatArea('2500000')).toBe('2.50 km²');
  });

  it('degrades gracefully', () => {
    expect(formatArea('nonsense')).toBe('—');
  });
});

describe('formatDate', () => {
  it('renders a placeholder for missing or invalid dates', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('formats a real timestamp', () => {
    expect(formatDate('2026-08-27T12:00:00.000Z')).not.toBe('—');
  });
});

describe('titleCase', () => {
  it('humanises enum values', () => {
    expect(titleCase('residential')).toBe('Residential');
    expect(titleCase('beta_access_granted')).toBe('Beta Access Granted');
    expect(titleCase('REGISTRATION_CLOSED')).toBe('Registration Closed');
  });

  it('handles empty input', () => {
    expect(titleCase('')).toBe('');
  });
});
