import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { BuildingQuote } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button, Field } from './ui.js';
import { formatMoney } from '../lib/format.js';

const TYPES = [
  { value: 'residential', label: 'Residential — flats on every floor' },
  { value: 'office', label: 'Office — workspace throughout' },
  { value: 'retail', label: 'Retail — shops' },
  { value: 'industrial', label: 'Industrial — workshop, storage above' },
  { value: 'mixed_use', label: 'Mixed use — shops at street level, flats above' },
  { value: 'civic', label: 'Civic' },
];

/** A building may cover at most 70% of its plot; the server enforces this too. */
const MAX_COVERAGE = 0.7;

export function BuildDialog({
  parcelId,
  parcelAreaSqm,
  onClose,
  onBuilt,
}: {
  parcelId: string;
  parcelAreaSqm: number;
  onClose: () => void;
  onBuilt: () => void;
}) {
  const { me, refresh } = useAuth();
  const maxFootprint = Math.floor(parcelAreaSqm * MAX_COVERAGE);

  const [name, setName] = useState('');
  const [type, setType] = useState('mixed_use');
  const [floors, setFloors] = useState(4);
  const [footprint, setFootprint] = useState(Math.max(1, Math.floor(maxFootprint * 0.8)));
  const [quote, setQuote] = useState<BuildingQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-quote whenever the brief changes, so the price is never stale relative
  // to the form the player is looking at.
  useEffect(() => {
    let cancelled = false;
    setQuote(null);

    const timer = setTimeout(async () => {
      try {
        const result = await api.quoteBuilding(parcelId, {
          footprintSqm: footprint,
          floors,
          type,
        });
        if (!cancelled) {
          setQuote(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Could not price that building.');
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [parcelId, footprint, floors, type]);

  const balance = Number(me?.profile?.balance ?? 0);
  const affordable = quote !== null && balance >= Number(quote.constructionCost);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startBuild(parcelId, { name, footprintSqm: footprint, floors, type });
      await refresh();
      onBuilt();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Construction could not start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-4">
      <div className="w-full max-w-md rounded-lg border border-ink-600 bg-ink-800 p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="font-semibold">Build here</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <Field
            label="Building name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Harbour House"
            maxLength={80}
          />

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">
              Type
            </span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm"
            >
              {TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 flex justify-between text-xs uppercase tracking-widest text-slate-400">
              <span>Floors</span>
              <span className="font-mono text-slate-300">{floors}</span>
            </span>
            <input
              type="range"
              min={1}
              max={60}
              value={floors}
              onChange={(event) => setFloors(Number(event.target.value))}
              className="w-full"
            />
          </label>

          <label className="block">
            <span className="mb-1 flex justify-between text-xs uppercase tracking-widest text-slate-400">
              <span>Footprint</span>
              <span className="font-mono text-slate-300">
                {footprint} m² of {maxFootprint} m² allowed
              </span>
            </span>
            <input
              type="range"
              min={1}
              max={Math.max(1, maxFootprint)}
              value={footprint}
              onChange={(event) => setFootprint(Number(event.target.value))}
              className="w-full"
            />
          </label>
        </div>

        <div className="mt-4 rounded-md border border-ink-600 bg-ink-900/60 p-3 text-sm">
          {quote ? (
            <dl className="space-y-1">
              <div className="flex justify-between">
                <dt className="text-slate-400">Cost</dt>
                <dd className={`font-mono ${affordable ? '' : 'text-loss'}`}>
                  {formatMoney(quote.constructionCost)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Units created</dt>
                <dd className="font-mono">{quote.unitCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Build time</dt>
                <dd className="font-mono">{quote.buildMinutes} min</dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-slate-400">Pricing…</p>
          )}
        </div>

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button
            className="flex-1"
            loading={busy}
            disabled={!quote || !affordable || name.trim().length < 2}
            onClick={submit}
          >
            {quote && !affordable ? 'Not enough funds' : 'Start construction'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
