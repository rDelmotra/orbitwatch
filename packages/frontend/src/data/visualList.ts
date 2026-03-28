const STORAGE_KEY = 'orbitwatch:visualNoradIds';
const VISUAL_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json';

/**
 * Fetches the CelesTrak curated "visual" satellite group and returns their
 * NORAD catalog IDs as a Set.  Caches in localStorage so the filter survives
 * network failures on subsequent visits.
 */
export async function fetchVisualNoradIds(): Promise<Set<number>> {
  try {
    const res = await fetch(VISUAL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { NORAD_CAT_ID: number }[] = await res.json();
    const ids = data.map((d) => d.NORAD_CAT_ID);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* quota */ }
    console.log(`Loaded ${ids.length} visual NORAD IDs from CelesTrak`);
    return new Set(ids);
  } catch {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      const ids: number[] = JSON.parse(cached);
      console.log(`Loaded ${ids.length} visual NORAD IDs from localStorage cache`);
      return new Set(ids);
    }
    console.warn('CelesTrak visual list unavailable and no cache — NORAD gate disabled');
    return new Set();
  }
}
