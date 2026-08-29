import { useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { BuildingDetail, UnitSummary } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button } from './ui.js';
import { formatArea, formatMoney, titleCase } from '../lib/format.js';

/**
 * The building inspector: one floor at a time, with a pager.
 *
 * A tower is read floor by floor, not as one long list — so the panel shows a
 * single floor and steps between them, and the deed sits above the rooms
 * because owning the building and owning a room in it are different things.
 */

function UnitCard({
  unit,
  mine,
  tradeable,
  busy,
  onBuy,
  onSell,
  onUnlist,
}: {
  unit: UnitSummary;
  mine: boolean;
  tradeable: boolean;
  busy: boolean;
  onBuy: () => void;
  onSell: () => void;
  onUnlist: () => void;
}) {
  const tone = unit.forSale
    ? 'border-gain/60 bg-gain/10'
    : mine
      ? 'border-accent-400/60 bg-accent-400/10'
      : 'border-ink-600 bg-ink-800';

  return (
    <div className={`rounded border p-2 text-xs ${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono font-semibold">{unit.label}</span>
        <span className="text-slate-400">{formatArea(unit.areaSqm)}</span>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className={unit.forSale ? 'text-gain' : 'text-slate-300'}>
          {formatMoney(unit.forSale ? (unit.salePrice ?? '0') : unit.marketValue)}
        </span>
        <span className="text-[10px] text-slate-500">{formatMoney(unit.revenuePerTick)}/tick</span>
      </div>

      <div className="mt-0.5 truncate text-[10px] text-slate-500">
        {mine ? 'Yours' : (unit.ownerName ?? 'Vacant')}
      </div>

      {tradeable && (
        <div className="mt-2">
          {unit.forSale && !mine && (
            <Button className="w-full px-2 py-1 text-[11px]" loading={busy} onClick={onBuy}>
              Buy room
            </Button>
          )}
          {mine && !unit.forSale && (
            <Button
              variant="secondary"
              className="w-full px-2 py-1 text-[11px]"
              loading={busy}
              onClick={onSell}
            >
              Sell
            </Button>
          )}
          {mine && unit.forSale && (
            <Button
              variant="secondary"
              className="w-full px-2 py-1 text-[11px]"
              loading={busy}
              onClick={onUnlist}
            >
              Unlist
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function BuildingInspector({
  building,
  onClose,
  onChanged,
}: {
  building: BuildingDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { me, refresh } = useAuth();
  const [floorIndex, setFloorIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const meId = me?.user?.id;
  const ownsDeed = building.ownerId === meId;
  const complete = building.status === 'complete';
  const balance = Number(me?.profile?.balance ?? 0);

  const floors = building.floorPlan;
  const floor = floors[Math.min(floorIndex, floors.length - 1)];
  const myRooms = floors.flatMap((f) => f.units).filter((unit) => unit.ownerId === meId).length;

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
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

  const sellUnit = (unit: UnitSummary) => {
    const price = window.prompt(`Sale price for room ${unit.label}?`, unit.marketValue);
    if (price) void act(unit.id, () => api.listUnit(unit.id, price));
  };

  const sellDeed = () => {
    const price = window.prompt('Sale price for the whole building?', building.appraisedValue);
    if (price) void act('deed', () => api.listDeed(building.id, price));
  };

  const deedAffordable = building.salePrice !== null && balance >= Number(building.salePrice);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto rounded-lg border border-ink-600 bg-ink-800 p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{building.name}</h2>
          <p className="text-xs text-slate-400">
            {titleCase(building.type)} · {building.floors} floors ·{' '}
            {formatArea(building.footprintSqm)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-200"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <dl className="mt-4 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-400">Appraised value</dt>
          <dd className="font-mono">{formatMoney(building.appraisedValue)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Foot traffic</dt>
          <dd className="font-mono">{building.footTraffic.toFixed(1)}x</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Rooms</dt>
          <dd className="font-mono">
            {building.unitCount} · {building.unitsForSale} for sale
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-slate-400">
        Owned by{' '}
        <span className="text-slate-200">
          {building.npcOwnerName ?? building.ownerName ?? 'unknown'}
        </span>
        {building.npcOwnerName && ' (NPC landlord)'}
      </p>

      {/* The rule that makes deeds and rooms worth explaining at all. */}
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        {myRooms > 0 && `You own ${myRooms} room${myRooms === 1 ? '' : 's'} in here. `}
        Rooms and the building are separate: your rooms stay yours whoever holds the deed, and
        buying the deed adds the unsold rooms plus a cut of everything earned inside.
      </p>

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mt-4">
        {!complete ? (
          <div className="rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-center text-sm text-slate-400">
            Under construction
          </div>
        ) : ownsDeed ? (
          building.forSale ? (
            <Button
              variant="secondary"
              className="w-full"
              loading={busy === 'deed'}
              onClick={() => act('deed', () => api.unlistDeed(building.id))}
            >
              Cancel sale ({formatMoney(building.salePrice ?? '0')})
            </Button>
          ) : (
            <Button variant="secondary" className="w-full" onClick={sellDeed}>
              Sell the building
            </Button>
          )
        ) : building.forSale ? (
          <Button
            className="w-full"
            disabled={!deedAffordable}
            loading={busy === 'deed'}
            onClick={() => act('deed', () => api.buyDeed(building.id))}
          >
            {deedAffordable
              ? `Buy the building — ${formatMoney(building.salePrice ?? '0')}`
              : 'Not enough cash'}
          </Button>
        ) : (
          <div className="rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-center text-sm text-slate-500">
            The deed is not for sale
          </div>
        )}
      </div>

      {floor && (
        <>
          <div className="mt-5 flex items-center justify-between border-t border-ink-600 pt-3">
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              {floor.level === 0 ? 'Ground floor' : `Floor ${floor.level}`}
            </span>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono text-slate-500">
                {floorIndex + 1}/{floors.length}
              </span>
              <button
                onClick={() => setFloorIndex((index) => Math.max(0, index - 1))}
                disabled={floorIndex === 0}
                className="rounded border border-ink-600 px-2 py-0.5 disabled:opacity-40"
                aria-label="Floor down"
              >
                ▼
              </button>
              <button
                onClick={() => setFloorIndex((index) => Math.min(floors.length - 1, index + 1))}
                disabled={floorIndex >= floors.length - 1}
                className="rounded border border-ink-600 px-2 py-0.5 disabled:opacity-40"
                aria-label="Floor up"
              >
                ▲
              </button>
            </div>
          </div>

          <p className="mt-1 text-[11px] text-slate-500">
            {titleCase(floor.use)} · {formatArea(floor.floorAreaSqm)} · {floor.units.length} rooms
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {floor.units.map((unit) => (
              <UnitCard
                key={unit.id}
                unit={unit}
                mine={unit.ownerId === meId}
                tradeable={complete}
                busy={busy === unit.id}
                onBuy={() => act(unit.id, () => api.buyUnit(unit.id))}
                onSell={() => sellUnit(unit)}
                onUnlist={() => act(unit.id, () => api.unlistUnit(unit.id))}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
