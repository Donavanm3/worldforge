import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ApiError, api } from '../api/client.js';
import type { CitySummary, ParcelCollection, ParcelProperties } from '../api/types.js';
import { useAuth } from '../auth/AuthContext.js';
import { Alert, Button } from '../components/ui.js';
import { BuildDialog } from '../components/BuildDialog.js';
import { formatArea, formatMoney, titleCase } from '../lib/format.js';

const SOURCE_ID = 'parcels';
const EMPTY: ParcelCollection = { type: 'FeatureCollection', features: [], truncated: false };

/**
 * Raster basemap from OpenStreetMap tiles.
 *
 * Self-hosted deployments can point this at their own tile server; nothing
 * here depends on a proprietary map provider or an API key.
 */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [selected, setSelected] = useState<ParcelProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cities, setCities] = useState<CitySummary[]>([]);
  const [building, setBuilding] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const { me, refresh } = useAuth();

  const loadParcels = useCallback(async () => {
    const instance = map.current;
    if (!instance) return;

    const bounds = instance.getBounds();
    try {
      const collection = await api.parcelsInViewport({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
      setTruncated(collection.truncated);
      setError(null);
      // An empty viewport this far in means the world has not cut this patch
      // of the planet into parcels yet — offer to do it rather than showing
      // the player a blank map with no explanation.
      setEmpty(collection.features.length === 0 && instance.getZoom() >= 15);
      (instance.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
        collection as never,
      );
    } catch (caught) {
      // A too-large viewport is expected while zoomed out, not a failure.
      if (caught instanceof ApiError && caught.status === 400) {
        setTruncated(false);
        setError('Zoom in to load land parcels.');
        (instance.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
          EMPTY as never,
        );
      } else {
        setError('Could not load parcels.');
      }
    }
  }, []);

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      // Manhattan. The jump-to control moves the player anywhere else;
      // starting zoomed out shows an empty ocean of unseeded land.
      center: [-74.006, 40.7128],
      zoom: 14,
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl(), 'top-right');

    instance.on('load', () => {
      instance.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY as never });

      instance.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          // Green = for sale, blue = owned, grey = unavailable.
          // A null ownerId stringifies to "", which is how the expression
          // language tests for absence — it has no null literal.
          'fill-color': [
            'case',
            ['get', 'forSale'],
            '#34d399',
            ['!=', ['to-string', ['get', 'ownerId']], ''],
            '#38bdf8',
            '#64748b',
          ],
          'fill-opacity': 0.45,
        },
      });

      instance.addLayer({
        id: 'parcel-outline',
        type: 'line',
        source: SOURCE_ID,
        paint: { 'line-color': '#0f172a', 'line-width': 1 },
      });

      instance.on('click', 'parcel-fill', (event) => {
        const feature = event.features?.[0];
        if (feature) setSelected(feature.properties as unknown as ParcelProperties);
      });
      instance.on('mouseenter', 'parcel-fill', () => {
        instance.getCanvas().style.cursor = 'pointer';
      });
      instance.on('mouseleave', 'parcel-fill', () => {
        instance.getCanvas().style.cursor = '';
      });

      void loadParcels();
    });

    instance.on('moveend', () => void loadParcels());

    return () => {
      instance.remove();
      map.current = null;
    };
  }, [loadParcels]);

  // The city list is small and never changes between deploys, so it is fetched
  // once rather than kept in sync with the viewport.
  useEffect(() => {
    api
      .cities()
      .then(setCities)
      .catch(() => setCities([]));
  }, []);

  const flyTo = useCallback((city: CitySummary) => {
    map.current?.flyTo({ center: [city.lng, city.lat], zoom: 15, speed: 2.2 });
  }, []);

  const claimArea = async () => {
    const instance = map.current;
    if (!instance) return;
    setClaiming(true);
    setError(null);
    try {
      const bounds = instance.getBounds();
      const result = await api.generateLand({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
      if (result.parcelsCreated === 0) {
        setError('No streets here to divide — try somewhere built up.');
      }
      await loadParcels();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not survey this area.');
    } finally {
      setClaiming(false);
    }
  };

  const onBuy = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.buyParcel(selected.id);
      await refresh();
      await loadParcels();
      setSelected(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Purchase failed.');
    } finally {
      setBusy(false);
    }
  };

  const affordable =
    selected?.salePrice != null && Number(me?.profile?.balance ?? 0) >= Number(selected.salePrice);

  return (
    <div className="relative h-full">
      <div ref={container} className="h-full w-full" />

      <div className="pointer-events-none absolute left-4 top-4 space-y-2">
        {error && (
          <div className="pointer-events-auto max-w-xs">
            <Alert tone={error.startsWith('Zoom') ? 'info' : 'error'}>{error}</Alert>
          </div>
        )}
        {empty && !claiming && (
          <div className="pointer-events-auto max-w-xs rounded-md border border-ink-600 bg-ink-800/95 p-3">
            <p className="mb-2 text-xs text-slate-300">
              No land has been surveyed here yet. Survey it and the streets below become buyable
              parcels.
            </p>
            <Button className="w-full px-2 py-1 text-xs" onClick={claimArea}>
              Survey this area
            </Button>
          </div>
        )}
        {claiming && (
          <div className="pointer-events-auto max-w-xs">
            <Alert tone="info">Surveying the streets here — this takes a few seconds.</Alert>
          </div>
        )}
        {truncated && (
          <div className="pointer-events-auto max-w-xs">
            <Alert tone="info">Showing the first 500 parcels — zoom in for the full picture.</Alert>
          </div>
        )}
        {cities.length > 0 && (
          <div className="pointer-events-auto rounded-md border border-ink-600 bg-ink-800/95 p-3">
            <label
              htmlFor="city-jump"
              className="mb-1 block text-xs font-semibold uppercase tracking-widest text-slate-400"
            >
              Jump to city
            </label>
            <select
              id="city-jump"
              defaultValue=""
              onChange={(event) => {
                const city = cities.find((c) => c.id === event.target.value);
                if (city) flyTo(city);
              }}
              className="w-56 rounded border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm"
            >
              <option value="" disabled>
                Select a city…
              </option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.name}, {city.countryCode} — {city.forSaleCount} for sale
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="pointer-events-auto rounded-md border border-ink-600 bg-ink-800/95 p-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-widest text-slate-400">Legend</div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm bg-gain/70" /> For sale
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm bg-accent-400/70" /> Owned
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm bg-slate-500/70" /> Not for sale
          </div>
        </div>
      </div>

      {selected && (
        <aside className="absolute right-4 top-4 w-80 rounded-lg border border-ink-600 bg-ink-800/95 p-5 shadow-xl">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold">{selected.cityName ?? 'Unincorporated land'}</h2>
              <p className="text-xs text-slate-400">{titleCase(selected.zoning)}</p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-slate-400 hover:text-slate-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-400">Area</dt>
              <dd className="font-mono">{formatArea(selected.areaSqm)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Market value</dt>
              <dd className="font-mono">{formatMoney(selected.marketValue)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Owner</dt>
              <dd>{selected.ownerName ?? 'Unowned'}</dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
            {[
              ['Power', selected.hasPower],
              ['Water', selected.hasWater],
              ['Internet', selected.hasInternet],
              ['Road', selected.hasRoad],
            ].map(([label, present]) => (
              <span
                key={String(label)}
                className={`rounded px-2 py-0.5 ${
                  present ? 'bg-gain/20 text-gain' : 'bg-ink-700 text-slate-500 line-through'
                }`}
              >
                {String(label)}
              </span>
            ))}
          </div>

          {selected.forSale && selected.salePrice ? (
            <div className="mt-5">
              <div className="mb-2 flex justify-between text-sm">
                <span className="text-slate-400">Price</span>
                <span className="font-mono text-gain">{formatMoney(selected.salePrice)}</span>
              </div>
              <Button onClick={onBuy} loading={busy} disabled={!affordable} className="w-full">
                {affordable ? 'Buy parcel' : 'Insufficient funds'}
              </Button>
            </div>
          ) : (
            <p className="mt-5 text-sm text-slate-500">This parcel is not for sale.</p>
          )}

          {/* Building is the point of owning land, so the entry point lives
              here on the parcel rather than behind a separate page. */}
          {selected.ownerId === me?.user?.id && (
            <div className="mt-3">
              <Button variant="secondary" className="w-full" onClick={() => setBuilding(true)}>
                Build here
              </Button>
            </div>
          )}
        </aside>
      )}

      {building && selected && (
        <BuildDialog
          parcelId={selected.id}
          parcelAreaSqm={Number(selected.areaSqm)}
          onClose={() => setBuilding(false)}
          onBuilt={() => {
            setBuilding(false);
            setSelected(null);
            void loadParcels();
          }}
        />
      )}
    </div>
  );
}
