export const PACKAGE_NAME = '@wf/api';

export { buildServer, type BuildServerOptions } from './server.js';
export {
  login,
  logout,
  refresh,
  register,
  revokeAllSessions,
  type AuthResult,
  type AuthTokens,
} from './auth/service.js';
export { hashPassword, verifyPassword } from './auth/password.js';
export {
  generateRefreshToken,
  hashRefreshToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from './auth/tokens.js';
export {
  requireAuth,
  requireRole,
  requireWorldAccess,
  type AuthenticatedUser,
} from './auth/guards.js';
export {
  canRegister,
  hasWorldAccess,
  loadGameSettings,
  setGameSetting,
  type GameSettings,
} from './settings.js';
export {
  PaymentProviderError,
  WebhookVerificationError,
  type CheckoutParams,
  type CheckoutSession,
  type ParsedPaymentEvent,
  type PaymentEventType,
  type PaymentProvider,
} from './payments/provider.js';
export {
  StripePaymentProvider,
  parseSignatureHeader,
  parseStripeEvent,
  verifyStripeSignature,
} from './payments/stripe.js';
export {
  createBetaCheckout,
  getPaymentStats,
  grantBetaAccessManually,
  listRecentPayments,
  processPaymentEvent,
  type WebhookOutcome,
} from './payments/service.js';
