import { describe, expect, it } from 'vitest';
import { canRegister, hasWorldAccess, type GameSettings } from './settings.js';

const base: GameSettings = {
  gameStatus: 'BETA',
  betaPrice: '3.00',
  betaPaymentRequired: true,
  registrationEnabled: true,
  startingBalance: '10000',
};

describe('hasWorldAccess', () => {
  it('always admits a player who already holds beta access', () => {
    for (const gameStatus of ['BETA', 'RELEASED', 'REGISTRATION_CLOSED'] as const) {
      expect(hasWorldAccess({ ...base, gameStatus }, true)).toBe(true);
    }
  });

  it('turns away an unpaid player during paid beta', () => {
    expect(hasWorldAccess(base, false)).toBe(false);
  });

  it('admits an unpaid player once payment is no longer required', () => {
    expect(hasWorldAccess({ ...base, betaPaymentRequired: false }, false)).toBe(true);
  });

  it('admits everyone on a free release but not a paid one', () => {
    const released = { ...base, gameStatus: 'RELEASED' } as const;
    expect(hasWorldAccess({ ...released, betaPaymentRequired: false }, false)).toBe(true);
    expect(hasWorldAccess({ ...released, betaPaymentRequired: true }, false)).toBe(false);
  });

  it('locks out even paying players during maintenance', () => {
    // Maintenance is the one status that overrides an existing grant.
    expect(hasWorldAccess({ ...base, gameStatus: 'MAINTENANCE' }, false)).toBe(false);
  });

  it('lets existing players in when registration is closed', () => {
    const closed = { ...base, gameStatus: 'REGISTRATION_CLOSED' } as const;
    expect(hasWorldAccess(closed, true)).toBe(true);
    expect(hasWorldAccess(closed, false)).toBe(false);
  });
});

describe('canRegister', () => {
  it('allows registration during beta and release', () => {
    expect(canRegister(base)).toBe(true);
    expect(canRegister({ ...base, gameStatus: 'RELEASED' })).toBe(true);
  });

  it('blocks registration when disabled or closed', () => {
    expect(canRegister({ ...base, registrationEnabled: false })).toBe(false);
    expect(canRegister({ ...base, gameStatus: 'REGISTRATION_CLOSED' })).toBe(false);
    expect(canRegister({ ...base, gameStatus: 'MAINTENANCE' })).toBe(false);
  });
});
