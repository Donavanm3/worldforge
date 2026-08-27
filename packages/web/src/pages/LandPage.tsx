import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { MarketListing, OwnedParcel } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Card, Spinner } from '../components/ui.js';
import { formatArea, formatMoney, titleCase } from '../lib/format.js';

export function LandPage() {
  const { refresh } = useAuth();
  const [owned, setOwned] = useState<OwnedParcel[] | null>(null);
  const [market, setMarket] = useState<MarketListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [mine, listings] = await Promise.all([api.myParcels(), api.market()]);
      setOwned(mine);
      setMarket(listings);
    } catch {
      setError('Could not load land data.');
      setOwned([]);
      setMarket([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await Promise.all([load(), refresh()]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">Land</h1>
      {error && <Alert>{error}</Alert>}

      <Card title="Your parcels">
        {owned === null ? (
          <Spinner />
        ) : owned.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">You do not own any land yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                  <th className="pb-2">City</th>
                  <th className="pb-2">Zoning</th>
                  <th className="pb-2">Area</th>
                  <th className="pb-2 text-right">Value</th>
                  <th className="pb-2 text-right">Listing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {owned.map((parcel) => (
                  <tr key={parcel.id}>
                    <td className="py-3">{parcel.city_name ?? '—'}</td>
                    <td className="py-3 text-slate-400">{titleCase(parcel.zoning)}</td>
                    <td className="py-3 text-slate-400">{formatArea(parcel.area_sqm)}</td>
                    <td className="py-3 text-right font-mono">
                      {formatMoney(parcel.market_value)}
                    </td>
                    <td className="py-3">
                      {parcel.for_sale ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="font-mono text-gain">
                            {formatMoney(parcel.sale_price ?? '0')}
                          </span>
                          <Button
                            variant="secondary"
                            loading={busyId === parcel.id}
                            onClick={() => void run(parcel.id, () => api.unlistParcel(parcel.id))}
                          >
                            Unlist
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <input
                            value={priceDrafts[parcel.id] ?? ''}
                            onChange={(e) =>
                              setPriceDrafts((prev) => ({ ...prev, [parcel.id]: e.target.value }))
                            }
                            placeholder={Number(parcel.market_value).toFixed(2)}
                            inputMode="decimal"
                            className="w-28 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-right font-mono text-xs"
                          />
                          <Button
                            variant="secondary"
                            loading={busyId === parcel.id}
                            onClick={() =>
                              void run(parcel.id, () =>
                                api.listParcel(
                                  parcel.id,
                                  priceDrafts[parcel.id]?.trim() ||
                                    Number(parcel.market_value).toFixed(2),
                                ),
                              )
                            }
                          >
                            List
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="On the market">
        {market === null ? (
          <Spinner />
        ) : market.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Nothing is for sale right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-widest text-slate-500">
                  <th className="pb-2">City</th>
                  <th className="pb-2">Zoning</th>
                  <th className="pb-2">Seller</th>
                  <th className="pb-2 text-right">Price</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {market.slice(0, 25).map((listing) => (
                  <tr key={listing.id}>
                    <td className="py-3">{listing.city_name ?? '—'}</td>
                    <td className="py-3 text-slate-400">{titleCase(listing.zoning)}</td>
                    <td className="py-3 text-slate-400">{listing.owner_name ?? 'The world'}</td>
                    <td className="py-3 text-right font-mono text-gain">
                      {formatMoney(listing.sale_price ?? '0')}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        loading={busyId === listing.id}
                        onClick={() => void run(listing.id, () => api.buyParcel(listing.id))}
                      >
                        Buy
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
