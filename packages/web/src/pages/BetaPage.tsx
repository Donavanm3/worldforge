import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { BetaStatus } from '../api/types.js';
import { Alert, Spinner } from '../components/ui.js';
import { formatUsd } from '../lib/format.js';

const INCLUDED = [
  'A persistent world map with buyable virtual land',
  'Company creation and a player-driven economy',
  'Markets, banking and a stock exchange',
  'Player governments, elections and law',
];

const UPCOMING = [
  'Production chains and logistics',
  'Cities, power and water infrastructure',
  'Internet, AI and data-centre industries',
  'International trade and diplomacy',
];

/** Public landing page (spec 73). */
export function BetaPage() {
  const [status, setStatus] = useState<BetaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .betaStatus()
      .then(setStatus)
      .catch(() => setError('Could not reach the WorldForge server.'));
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-5xl font-bold tracking-tight">
        WORLD<span className="text-accent-400">FORGE</span>
      </h1>

      {error && (
        <div className="mt-6">
          <Alert>{error}</Alert>
        </div>
      )}

      {!status && !error && <Spinner />}

      {status && (
        <>
          <p className="mt-3 text-xl text-slate-300">
            A persistent multiplayer simulation of civilization, economy and power.
          </p>

          {status.gameStatus === 'BETA' && status.betaPaymentRequired && (
            <div className="mt-8 rounded-lg border border-accent-500/40 bg-accent-500/10 p-6">
              <div className="text-xs font-semibold uppercase tracking-widest text-accent-400">
                Paid Beta
              </div>
              <p className="mt-2 text-slate-300">
                WorldForge is currently in paid beta. Get access for {formatUsd(status.betaPrice)}{' '}
                and help shape the world before the official release.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  to="/register"
                  className="rounded-md bg-accent-500 px-5 py-2.5 font-semibold text-ink-900 hover:bg-accent-400"
                >
                  Get Beta Access — {formatUsd(status.betaPrice)}
                </Link>
                <Link
                  to="/login"
                  className="rounded-md border border-ink-500 bg-ink-700 px-5 py-2.5 hover:bg-ink-600"
                >
                  Sign in
                </Link>
              </div>
              {!status.registrationEnabled && (
                <p className="mt-3 text-sm text-loss">Registration is currently closed.</p>
              )}
              {!status.paymentsConfigured && (
                <p className="mt-3 text-sm text-loss">
                  Payments are not configured on this server yet.
                </p>
              )}
            </div>
          )}

          {(status.gameStatus === 'RELEASED' || !status.betaPaymentRequired) && (
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/register"
                className="rounded-md bg-accent-500 px-5 py-2.5 font-semibold text-ink-900 hover:bg-accent-400"
              >
                Create account
              </Link>
              <Link
                to="/login"
                className="rounded-md border border-ink-500 bg-ink-700 px-5 py-2.5 hover:bg-ink-600"
              >
                Sign in
              </Link>
            </div>
          )}

          {status.gameStatus === 'MAINTENANCE' && (
            <div className="mt-8">
              <Alert>WorldForge is under maintenance. Please check back shortly.</Alert>
            </div>
          )}

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                In the beta today
              </h2>
              <ul className="mt-3 space-y-2 text-slate-300">
                {INCLUDED.map((item) => (
                  <li key={item}>— {item}</li>
                ))}
              </ul>
            </section>
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Planned
              </h2>
              <ul className="mt-3 space-y-2 text-slate-400">
                {UPCOMING.map((item) => (
                  <li key={item}>— {item}</li>
                ))}
              </ul>
            </section>
          </div>

          <section className="mt-12 rounded-lg border border-ink-600 bg-ink-800 p-5 text-sm text-slate-400">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              Important beta information
            </h2>
            <ul className="mt-3 space-y-1.5">
              <li>— The game is still under active development, and bugs are expected.</li>
              <li>— Features may change or be removed before release.</li>
              <li>— Progress may be reset during development.</li>
              <li>— In-game currency has no real-world monetary value.</li>
              <li>— Land parcels are a game representation; you are not buying real property.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
