import type * as THREE from 'three';
import type { EnrichedTLEObject, TLEInput } from './types';
import { fetchTleCatalog } from './tle-client';
import { GPUPicker } from '../engine/GPUPicker';
import type { SatelliteRenderer } from '../engine/SatelliteRenderer';
import { useStore } from '../store/useStore';

export interface BootstrapCatalogDeps {
  apiUrl: string;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  satelliteRenderer: SatelliteRenderer;
}

export interface BootstrapCatalogResult {
  catalogData: EnrichedTLEObject[];
  tles: TLEInput[];
  gpuPicker: GPUPicker;
}

/**
 * One-time catalog bootstrap: fetch the TLE catalog, seed the store with it,
 * prime the satellite renderer geometry, and build the GPU picker over it.
 *
 * This is deliberately a thin function — NOT a manager. It runs once during
 * Engine init and hands back the data + picker for the Engine to wire up.
 * Per-tick propagation, subscriptions, and command/trigger registration stay
 * in the Engine (and migrate to layers later); none of that belongs here.
 */
export async function bootstrapCatalog(
  deps: BootstrapCatalogDeps,
): Promise<BootstrapCatalogResult> {
  const { catalogData, tles, categoryCounts, regimeCounts } = await fetchTleCatalog(deps.apiUrl);

  const store = useStore.getState();
  store.setCatalogInfo({
    objectCount: catalogData.length,
    categoryCounts,
    regimeCounts,
  });
  store.setCatalogData(catalogData);

  // GPU picker reads the satellite geometry, so the renderer must be primed first.
  deps.satelliteRenderer.initFromCatalog(catalogData);

  const gpuPicker = new GPUPicker(
    deps.renderer,
    deps.camera,
    deps.satelliteRenderer,
    catalogData.length,
  );

  return { catalogData, tles, gpuPicker };
}
