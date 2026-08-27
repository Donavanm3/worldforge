import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { GameSettings, PaymentsDashboard } from '../api/types.js';
import { Alert, Button, Card, Spinner, Stat } from '../components/ui.js';
import { formatDate, formatUsd, titleCase } from '../lib/format.js';

const STATUSES: GameSettings['gameStatus'][] = [
  'BETA',
  'RELEASED',
  'MAINTENANCE',
  'REGISTRATION_CLOSED',
];

/** Admin panel (spec 53, 70, 77). */
export function AdminPage() {
  const [settings, setSettings] = useState<GameSettings | null>(null);
  const [payments, setPayments] = useState<PaymentsDashboard | null>(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [current, dashboard] = await Promise.all([api.adminSettings(), api.adminPayments()]);
      setSettings(current);
      setPrice(current.betaPrice);
      setPayments(dashboard);
    } catch {
      setError('Could not load admin data.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (changes: Partial<GameSettings>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.updateAdminSettings(changes);
      setSettings(updated);
      setPrice(updated.betaPrice);
      setNotice('Settings saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  };

  if (!settings || !payments) {
    return error ? (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <Alert>{error}</Alert>
      </div>
    ) : (
      <Spinner />
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Admin</h1>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Beta purchases" value={payments.stats.totalPurchases} />
        <Stat label="Revenue" value={formatUsd(payments.stats.totalRevenue)} />
        <Stat label="Pending" value={payments.stats.pending} />
        <Stat label="Failed / refunded" value={payments.stats.failed + payments.stats.refunded} />
      </div>

      <Card title="Game status">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <Button
              key={status}
              variant={settings.gameStatus === status ? 'primary' : 'secondary'}
              loading={busy}
              onClick={() => void patch({ gameStatus: status })}
            >
              {titleCase(status)}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Switching to Released with payment disabled opens the game to everyone. Existing players
          keep their accounts, land and badges either way — no data is ever wiped by this control.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Beta access">
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
                Beta price (USD)
              </span>
              <div className="flex gap-2">
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  className="w-32 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-right font-mono"
                />
                <Button loading={busy} onClick={() => void patch({ betaPrice: price })}>
                  Save
                </Button>
              </div>
            </label>

            <div className="flex items-center justify-between border-t border-ink-700 pt-4">
              <div>
                <div className="text-sm">Payment required</div>
                <div className="text-xs text-slate-500">
                  Turn off for a free release. Existing beta testers are unaffected.
                </div>
              </div>
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => void patch({ betaPaymentRequired: !settings.betaPaymentRequired })}
              >
                {settings.betaPaymentRequired ? 'On' : 'Off'}
              </Button>
            </div>

            <div className="flex items-center justify-between border-t border-ink-700 pt-4">
              <div>
                <div className="text-sm">Registration open</div>
                <div className="text-xs text-slate-500">Stops new sign-ups when off.</div>
              </div>
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => void patch({ registrationEnabled: !settings.registrationEnabled })}
              >
                {settings.registrationEnabled ? 'On' : 'Off'}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Recent payments">
          {payments.payments.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No payments yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                  <th className="pb-2">Player</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Date</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {payments.payments.slice(0, 15).map((payment) => (
                  <tr key={payment.id}>
                    <td className="py-2">{payment.username}</td>
                    <td className="py-2 text-slate-400">{titleCase(payment.status)}</td>
                    <td className="py-2 text-slate-400">{formatDate(payment.created_at)}</td>
                    <td className="py-2 text-right font-mono">{formatUsd(payment.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
