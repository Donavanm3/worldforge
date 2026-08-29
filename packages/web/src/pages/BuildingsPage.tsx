import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { BuildingDetail, BuildingSummary } from '../api/types.js';
import { BuildingInspector } from '../components/BuildingInspector.js';
import { Alert, Button, Card, Spinner } from '../components/ui.js';
import { formatDate, formatMoney, titleCase } from '../lib/format.js';

export function BuildingsPage() {
  const [mine, setMine] = useState<BuildingSummary[]>([]);
  const [market, setMarket] = useState<BuildingSummary[]>([]);
  const [deeds, setDeeds] = useState<BuildingSummary[]>([]);
  const [selected, setSelected] = useState<BuildingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ownBuildings, forSale, deeds] = await Promise.all([
        api.myBuildings(),
        api.buildingMarket(),
        api.deedMarket(),
      ]);
      setMine(ownBuildings);
      setMarket(forSale);
      setDeeds(deeds);
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

      <Card title="Buildings for sale">
        {deeds.length === 0 ? (
          <p className="text-sm text-slate-400">No deeds are on the market.</p>
        ) : (
          <ul className="divide-y divide-ink-600">
            {deeds.map((building) => (
              <li key={building.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">
                    {building.name}{' '}
                    <span className="font-mono text-sm text-gain">
                      {formatMoney(building.salePrice ?? '0')}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {titleCase(building.type)} · {building.floors} floors · {building.unitCount}{' '}
                    rooms · {building.footTraffic.toFixed(1)}x traffic
                    {building.cityName ? ` · ${building.cityName}` : ''}
                  </div>
                  <div className="text-xs text-slate-500">
                    {building.npcOwnerName ?? building.ownerName ?? 'unknown'}
                    {building.npcOwnerName && ' (NPC landlord)'}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => open(building.id)}>
                  Inspect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Rooms for sale">
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
        <BuildingInspector
          building={selected}
          onClose={() => setSelected(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}
