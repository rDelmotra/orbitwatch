import type { EnrichedTLEObject } from './types';

// ============================================================
// TLE catalog revisit cache (IndexedDB)
//
// Stores the last-downloaded catalog on the user's disk so warm loads can skip
// the ~13.8 MB /api/tle/all download. Anonymous, per-browser, no cookies/login.
//
// This cache is deliberately decoupled from the backend's version/cron/Space-Track
// pipeline: the *decision* to use it is a pure client-side TTL on a local
// timestamp (see fetchTleCatalog). The stored `version` is only an opaque label
// used for an opportunistic, read-only background refresh — nothing here can
// influence backend fetching.
//
// Every operation degrades gracefully (private mode, disabled storage, quota
// errors) by resolving to null / no-op, so the caller always falls back to a
// normal network fetch.
// ============================================================

const DB_NAME = 'orbitwatch';
const DB_VERSION = 1;
const STORE = 'tle-catalog';
const KEY = 'catalog';

export interface CatalogCacheRecord {
  /** Backend version stamp this catalog was fetched at (opaque to the client). */
  version: string;
  /** Client wall-clock ms when stored — the TTL freshness key. */
  fetchedAt: number;
  catalogData: EnrichedTLEObject[];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Read the cached catalog record, or null if absent/unavailable. */
export async function readCatalogCache(): Promise<CatalogCacheRecord | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as CatalogCacheRecord | undefined) ?? null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Write the catalog record (overwrites). Never throws — best-effort. */
export async function writeCatalogCache(record: CatalogCacheRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
