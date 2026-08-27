import type { Db, GameStatus } from '@wf/db';

export interface GameSettings {
  gameStatus: GameStatus;
  betaPrice: string;
  betaPaymentRequired: boolean;
  registrationEnabled: boolean;
  startingBalance: string;
}

const DEFAULTS: GameSettings = {
  gameStatus: 'BETA',
  betaPrice: '3.00',
  betaPaymentRequired: true,
  registrationEnabled: true,
  startingBalance: '10000',
};

const GAME_STATUSES: readonly GameStatus[] = [
  'BETA',
  'RELEASED',
  'MAINTENANCE',
  'REGISTRATION_CLOSED',
];

function parseStatus(value: string | undefined): GameStatus {
  return GAME_STATUSES.includes(value as GameStatus) ? (value as GameStatus) : DEFAULTS.gameStatus;
}

/**
 * Reads the runtime-tunable settings (spec 70). Nothing downstream may hard-code
 * the beta price or game status — they are admin-editable at runtime.
 */
export async function loadGameSettings(db: Db): Promise<GameSettings> {
  const rows = await db.selectFrom('game_settings').select(['key', 'value']).execute();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    gameStatus: parseStatus(map.get('GAME_STATUS')),
    betaPrice: map.get('BETA_PRICE') ?? DEFAULTS.betaPrice,
    betaPaymentRequired: (map.get('BETA_PAYMENT_REQUIRED') ?? 'true') === 'true',
    registrationEnabled: (map.get('REGISTRATION_ENABLED') ?? 'true') === 'true',
    startingBalance: map.get('STARTING_BALANCE') ?? DEFAULTS.startingBalance,
  };
}

export async function setGameSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insertInto('game_settings')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: new Date() }))
    .execute();
}

/**
 * Whether a player may enter the game world.
 *
 * Access is granted when the account already holds beta access (paid or
 * admin-granted), or when the current game status does not require payment.
 * Pure so the policy can be tested without a database.
 */
export function hasWorldAccess(settings: GameSettings, betaAccess: boolean): boolean {
  if (betaAccess) return true;

  switch (settings.gameStatus) {
    case 'BETA':
      return !settings.betaPaymentRequired;
    case 'RELEASED':
      // A paid release keeps charging new players; a free release does not.
      return !settings.betaPaymentRequired;
    case 'REGISTRATION_CLOSED':
      // Existing players keep playing; they just hold beta_access already.
      return false;
    case 'MAINTENANCE':
      return false;
  }
}

/** Whether new accounts may be created right now. */
export function canRegister(settings: GameSettings): boolean {
  if (!settings.registrationEnabled) return false;
  return settings.gameStatus === 'BETA' || settings.gameStatus === 'RELEASED';
}
