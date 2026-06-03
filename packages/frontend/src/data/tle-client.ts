import type { TLEInput, EnrichedTLEObject, ObjectCategory, OrbitalRegime } from './types';
import {
  fetchVisualList,
  type VisualListResolvedResult,
} from './visualList';

// ── TLE Catalog Fetch ─────────────────────────────────────────────────────

export interface TleCatalogResult {
  catalogData: EnrichedTLEObject[];
  tles: TLEInput[];
  categoryCounts: Record<ObjectCategory, number>;
  regimeCounts: Record<OrbitalRegime, number>;
}

/**
 * Pure data fetch — no store side effects. Returns catalog data for
 * Engine to distribute to modules and write to store.
 */
export async function fetchTleCatalog(apiUrl: string): Promise<TleCatalogResult> {
  const res = await fetch(`${apiUrl}/api/tle/all`);
  if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);

  const response = await res.json();
  const catalogData: EnrichedTLEObject[] = response.data;
  const tles: TLEInput[] = catalogData.map((d) => ({
    noradId: d.noradId,
    line1: d.line1,
    line2: d.line2,
  }));

  const categoryCounts: Record<ObjectCategory, number> = {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  };
  const regimeCounts: Record<OrbitalRegime, number> = {
    LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
  };
  for (const obj of catalogData) {
    categoryCounts[obj.category] = (categoryCounts[obj.category] ?? 0) + 1;
    regimeCounts[obj.regime] = (regimeCounts[obj.regime] ?? 0) + 1;
  }

  return { catalogData, tles, categoryCounts, regimeCounts };
}

// ── Visual List Poller ────────────────────────────────────────────────────

const VISUAL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class VisualListPoller {
  private readonly apiUrl: string;
  private readonly onResult: (result: VisualListResolvedResult) => void;

  private _visualNoradIds: Set<number> = new Set();
  private etag: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    apiUrl: string,
    onResult: (result: VisualListResolvedResult) => void,
  ) {
    this.apiUrl = apiUrl;
    this.onResult = onResult;
  }

  get visualNoradIds(): Set<number> {
    return this._visualNoradIds;
  }

  start(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
    }

    this.interval = setInterval(() => {
      void this.refresh();
    }, VISUAL_REFRESH_INTERVAL_MS);

    // Fire initial refresh non-blocking
    void this.refresh();
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      const result = await fetchVisualList({
        apiBase: this.apiUrl,
        etag: this.etag,
      });

      if (result.kind === 'not_modified') return;

      this.etag = result.etag ?? this.etag;
      this._visualNoradIds = result.ids;
      this.onResult(result);
    } catch (err) {
      console.warn('Visual list refresh error:', err);
      const fallback: VisualListResolvedResult = {
        kind: 'resolved',
        ids: new Set(),
        status: 'unavailable',
        source: null,
        stale: false,
        version: null,
        etag: this.etag,
        message: 'Visual list refresh failed unexpectedly.',
      };
      this._visualNoradIds = fallback.ids;
      this.onResult(fallback);
    } finally {
      this.inFlight = false;
    }
  }
}
