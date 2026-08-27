import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { OwnedParcel } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Card, ComingSoon, Spinner, Stat } from '../components/ui.js';
import { formatArea, formatMoney, titleCase } from '../lib/format.js';

/** Player dashboard (spec 47). */
export function DashboardPage() {
  const { me } = useAuth();
  const [parcels, setParcels] = useState<OwnedParcel[] | null>(null);

  useEffect(() => {
    api
      .myParcels()
      .then(setParcels)
      .catch(() => setParcels([]));
  }, []);

  const landValue = (parcels ?? []).reduce((sum, p) => sum + Number(p.market_value), 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome back, {me?.profile?.display_name ?? me?.user.username}
        </h1>
        <p className="text-sm text-slate-400">Your position in the world today.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash" value={formatMoney(me?.profile?.balance ?? '0')} />
        <Stat
          label="Land value"
          value={formatMoney(landValue, { compact: true })}
          hint={`${parcels?.length ?? 0} parcels`}
        />
        <Stat
          label="Net worth"
          value={formatMoney(Number(me?.profile?.balance ?? 0) + landValue, { compact: true })}
        />
        <Stat label="Reputation" value={me?.profile?.reputation ?? 0} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Your land"
          className="lg:col-span-2"
          action={
            <Link to="/land" className="text-xs text-accent-400 underline">
              Manage
            </Link>
          }
        >
          {parcels === null ? (
            <Spinner />
          ) : parcels.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">
              You do not own any land yet.{' '}
              <Link to="/map" className="text-accent-400 underline">
                Open the map
              </Link>{' '}
              to buy your first parcel.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                  <th className="pb-2">City</th>
                  <th className="pb-2">Zoning</th>
                  <th className="pb-2">Area</th>
                  <th className="pb-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {parcels.slice(0, 8).map((parcel) => (
                  <tr key={parcel.id}>
                    <td className="py-2">{parcel.city_name ?? '—'}</td>
                    <td className="py-2 text-slate-400">{titleCase(parcel.zoning)}</td>
                    <td className="py-2 text-slate-400">{formatArea(parcel.area_sqm)}</td>
                    <td className="py-2 text-right font-mono">
                      {formatMoney(parcel.market_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Getting started">
          <ol className="space-y-2 text-sm text-slate-300">
            <li>1. Explore the world map.</li>
            <li>2. Buy your first land parcel.</li>
            <li>3. Zone it for its intended use.</li>
            <li className="text-slate-500">4. Found a company — coming soon.</li>
            <li className="text-slate-500">5. Produce and sell goods — coming soon.</li>
          </ol>
        </Card>
      </div>

      <Card title="Markets & economy">
        <ComingSoon feature="Stock markets, banking and the commodity exchange" />
      </Card>
    </div>
  );
}
