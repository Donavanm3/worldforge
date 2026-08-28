import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { BuildingDetail, BuildingSummary, UnitSummary } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Card, Spinner } from '../components/ui.js';
import { formatArea, formatDate, formatMoney, titleCase } from '../lib/format.js';

/** Colour a unit by who holds it, matching the map's ownership legend. */
function unitTone(unit: UnitSummary, meId: string | undefined): string {
  if (unit.forSale) return 'border-gain/60 bg-gain/10';
  if (unit.ownerId === meId) return 'border-accent-400/60 bg-accent-400/10';
  if (unit.ownerId) return 'border-ink-500 bg-ink-700/60';
  return 'border-ink-600 bg-ink-800';
}

function FloorPlan({ building, onChanged }: { building: BuildingDetail; onChanged: () => void }) {
  const { me, refresh } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (unitId: string, action: () => Promise<unknown>) => {
    setBusy(unitId);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const sell = async (unit: UnitSummary) => {
    const price = window.prompt(`Sale price for unit ${unit.label}?`, unit.marketValue);
    if (!price) return;
    await act(unit.id, () => api.listUnit(unit.id, price));
  };

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}

      {/* Top floor first: a floor plan reads the way the building stands. */}
      {[...building.floorPlan].reverse().map((floor) => (
        <div key={floor.level} className="rounded-md border border-ink-600 bg-ink-900/60 p-3">
          <div className="mb-2 flex items-baseline justify-between text-xs">
            <span className="font-semibold uppercase tracking-widest text-slate-400">
              {floor.level === 0 ? 'Ground floor' : `Floor ${floor.level}`}
            </span>
            <span className="text-slate-500">
              {titleCase(floor.use)} · {formatArea(floor.floorAreaSqm)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {floor.units.map((unit) => {
              const mine = unit.ownerId === me?.user?.id;
              return (
                <div
                  key={unit.id}
                  className={`rounded border p-2 text-xs ${unitTone(unit, me?.user?.id)}`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono font-semibold">{unit.label}</span>
                    <span className="text-slate-400">{formatArea(unit.areaSqm)}</span>
                  </div>
                  <div className="mt-1 text-slate-400">
                    {unit.forSale ? (
                      <span className="text-gain">{formatMoney(unit.salePrice ?? '0')}</span>
                    ) : (
                      <span>{formatMoney(unit.marketValue)}</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-500">
                    {unit.ownerName ?? 'Unsold'}
                  </div>

                  {building.status === 'complete' && (
                    <div className="mt-2">
                      {unit.forSale && !mine && (
                        <Button
                          className="w-full px-2 py-1 text-[11px]"
                          loading={busy === unit.id}
                          onClick={() => act(unit.id, () => api.buyUnit(unit.id))}
                        >
                          Buy
                        </Button>
                      )}
                      {mine && !unit.forSale && (
                        <Button
                          variant="secondary"
                          className="w-full px-2 py-1 text-[11px]"
                          loading={busy === unit.id}
                          onClick={() => sell(unit)}
                        >
                          Sell
                        </Button>
                      )}
                      {mine && unit.forSale && (
                        <Button
                          variant="secondary"
                          className="w-full px-2 py-1 text-[11px]"
                          loading={busy === unit.id}
                          onClick={() => act(unit.id, () => api.unlistUnit(unit.id))}
                        >
                          Unlist
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function BuildingsPage() {
  const [mine, setMine] = useState<BuildingSummary[]>([]);
  const [market, setMarket] = useState<BuildingSummary[]>([]);
  const [selected, setSelected] = useState<BuildingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ownBuildings, forSale] = await Promise.all([api.myBuildings(), api.buildingMarket()]);
      setMine(ownBuildings);
      setMarket(forSale);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load buildings.');
    } finally {
      setLoading(false);
    }
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      setSelected(await api.building(id));
    } catch {
      setError('Could not open that building.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload the open building too, so a purchase updates the floor plan in place.
  const refreshAll = useCallback(() => {
    void load();
    if (selected) void open(selected.id);
  }, [load, open, selected]);

  if (loading) return <Spinner label="Loading buildings…" />;

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Card title="Your buildings">
        {mine.length === 0 ? (
          <p className="text-sm text-slate-400">
            You have not built anything yet. Buy a parcel on the map, then use{' '}
            <span className="text-slate-200">Build here</span> to start construction.
          </p>
        ) : (
          <ul className="divide-y divide-ink-600">
            {mine.map((building) => (
              <li key={building.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{building.name}</div>
                  <div className="text-xs text-slate-400">
                    {titleCase(building.type)} · {building.floors} floors · {building.unitCount}{' '}
                    units
                    {building.cityName ? ` · ${building.cityName}` : ''}
                  </div>
                  {building.status === 'under_construction' && (
                    <div className="text-xs text-slate-500">
                      Under construction — ready {formatDate(building.completesAt)}
                    </div>
                  )}
                </div>
                <Button variant="secondary" onClick={() => open(building.id)}>
                  Floor plan
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Units for sale">
        {market.length === 0 ? (
          <p className="text-sm text-slate-400">Nobody is selling units right now.</p>
        ) : (
          <ul className="divide-y divide-ink-600">
            {market.map((building) => (
              <li key={building.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{building.name}</div>
                  <div className="text-xs text-slate-400">
                    {building.unitsForSale} of {building.unitCount} units listed
                    {building.cityName ? ` · ${building.cityName}` : ''} · owner{' '}
                    {building.ownerName ?? 'unknown'}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => open(building.id)}>
                  View
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && (
        <Card
          title={selected.name}
          action={
            <button
              onClick={() => setSelected(null)}
              className="text-sm text-slate-400 hover:text-slate-200"
            >
              Close
            </button>
          }
        >
          <p className="mb-3 text-xs text-slate-400">
            {titleCase(selected.type)} · {selected.floors} floors ·{' '}
            {formatArea(selected.footprintSqm)} footprint ·{' '}
            {selected.status === 'complete' ? 'Complete' : 'Under construction'}
          </p>
          <FloorPlan building={selected} onChanged={refreshAll} />
        </Card>
      )}
    </div>
  );
}
