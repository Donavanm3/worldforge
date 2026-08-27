import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client.js';
import type { BetaAccessResponse } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Spinner } from '../components/ui.js';
import { formatUsd, titleCase } from '../lib/format.js';

/** "Beta access required" paywall (spec 74). */
export function BetaAccessPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [access, setAccess] = useState<BetaAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .betaAccess()
      .then((result) => {
        if (result.hasAccess) navigate('/dashboard');
        else setAccess(result);
      })
      .catch(() => setError('Could not load your access status.'));
  }, [navigate]);

  const onCheckout = async () => {
    setError(null);
    setBusy(true);
    try {
      const { checkoutUrl } = await api.startCheckout();
      // Hand off to the payment provider's hosted checkout. Access is granted
      // by the server's webhook, never by returning to the success URL.
      window.location.href = checkoutUrl;
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not start checkout. Try again.',
      );
      setBusy(false);
    }
  };

  if (error && !access) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!access) return <Spinner />;

  const pending = access.latestPayment?.status === 'pending';

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Beta Access Required</h1>
      <p className="mt-3 text-slate-300">You need WorldForge Beta Access to enter the game.</p>

      <div className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}

        {pending && (
          <Alert tone="info">
            A payment is still processing. Access appears automatically once your provider confirms
            it — you may need to refresh.
          </Alert>
        )}

        {access.gameStatus === 'MAINTENANCE' ? (
          <Alert>WorldForge is under maintenance. Please check back shortly.</Alert>
        ) : (
          <Button onClick={onCheckout} loading={busy} className="w-full">
            Get Beta Access — {formatUsd(access.betaPrice)}
          </Button>
        )}

        {access.latestPayment && (
          <div className="rounded-lg border border-ink-600 bg-ink-800 p-4 text-sm">
            <div className="text-xs uppercase tracking-widest text-slate-400">Last payment</div>
            <div className="mt-2 flex justify-between">
              <span className="text-slate-300">{titleCase(access.latestPayment.status)}</span>
              <span className="font-mono">{formatUsd(access.latestPayment.amount)}</span>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-500">
          This is a one-time fee for beta access. It is not in-game currency and has no in-game
          value.
        </p>

        <button
          onClick={() => void logout().then(() => navigate('/beta'))}
          className="text-sm text-slate-400 underline hover:text-slate-200"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * Return page after the provider redirect. It deliberately does not grant
 * anything — it just polls the server, which is the only authority (spec 67).
 */
export function BetaSuccessPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [message, setMessage] = useState('Confirming your payment…');

  useEffect(() => {
    let attempts = 0;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const access = await api.betaAccess();
        if (access.hasAccess) {
          await refresh();
          navigate('/dashboard');
          return;
        }
      } catch {
        /* keep polling */
      }

      if (attempts >= 10) {
        setMessage(
          'Your payment has not been confirmed yet. It can take a moment — this page will not grant access on its own, so please check back shortly.',
        );
        return;
      }
      setTimeout(() => void poll(), 2000);
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [navigate, refresh]);

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold">Thank you</h1>
      <p className="mt-4 text-slate-300">{message}</p>
    </div>
  );
}
