const STORAGE_KEY = 'orbitwatch:visualNoradIds:v2';
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface VisualListApiResponse {
  ids: unknown[];
}

interface VisualNoradCacheEnvelope {
  cachedAt: string;
  ids: number[];
}

function toNoradId(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNoradIds(values: unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const parsed = toNoradId(value);
    if (parsed !== null) ids.add(parsed);
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function writeCachedVisualNoradIds(ids: number[]): void {
  try {
    const payload: VisualNoradCacheEnvelope = {
      cachedAt: new Date().toISOString(),
      ids,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to persist visual NORAD cache:', err);
  }
}

function readCachedVisualNoradIds(): Set<number> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;

    // Backward compatibility with the old cache shape (number[] only).
    if (Array.isArray(parsed)) {
      const legacyIds = normalizeNoradIds(parsed);
      if (legacyIds.length === 0) return null;
      writeCachedVisualNoradIds(legacyIds);
      return new Set(legacyIds);
    }

    if (!parsed || typeof parsed !== 'object') return null;

    const envelope = parsed as Partial<VisualNoradCacheEnvelope>;
    if (!Array.isArray(envelope.ids) || typeof envelope.cachedAt !== 'string') return null;

    const cachedAtMs = Date.parse(envelope.cachedAt);
    if (!Number.isFinite(cachedAtMs) || Date.now() - cachedAtMs > CACHE_MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    const ids = normalizeNoradIds(envelope.ids);
    return ids.length > 0 ? new Set(ids) : null;
  } catch (err) {
    console.warn('Failed to read visual NORAD cache:', err);
    return null;
  }
}

function parseVisualListResponse(payload: unknown): number[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Visual endpoint returned invalid payload');
  }

  const maybeIds = (payload as Partial<VisualListApiResponse>).ids;
  if (!Array.isArray(maybeIds)) {
    throw new Error('Visual endpoint payload missing ids[]');
  }

  const ids = normalizeNoradIds(maybeIds);
  if (ids.length === 0) {
    throw new Error('Visual endpoint returned no NORAD IDs');
  }

  return ids;
}

/**
 * Fetches the backend-proxied CelesTrak "visual" list and returns NORAD IDs.
 * The request is fail-open: cached localStorage data is used on any fetch error.
 */
export async function fetchVisualNoradIds(apiBase = import.meta.env.VITE_API_URL ?? ''): Promise<Set<number>> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${apiBase}/api/tle/visual`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = (await res.json()) as unknown;
    const ids = parseVisualListResponse(payload);
    writeCachedVisualNoradIds(ids);
    console.log(`Loaded ${ids.length} visual NORAD IDs from backend`);
    return new Set(ids);
  } catch (err) {
    const cached = readCachedVisualNoradIds();
    if (cached) {
      console.log(`Loaded ${cached.size} visual NORAD IDs from localStorage cache`);
      return cached;
    }

    console.warn('Visual NORAD list unavailable and no cache — NORAD gate disabled', err);
    return new Set();
  } finally {
    window.clearTimeout(timeoutId);
  }
}
