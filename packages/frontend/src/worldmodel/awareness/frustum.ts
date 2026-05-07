import * as THREE from 'three';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '../../data/types';
import type { FrustumContents, FrustumGroup, FrustumResult } from '../types';

// HOT PATH OPTIMIZATION: module-level pre-allocated primitives reused every tick.
// Do not "clean up" into per-object allocations — this avoids 75K+ Vector3 allocs/sec.
const _scratchVec = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _widerFrustum = new THREE.Frustum();
const _widerProjMatrix = new THREE.Matrix4();
const _viewProjMatrix = new THREE.Matrix4();

export function queryFrustum(
  camera: THREE.PerspectiveCamera,
  currPosAttr: THREE.BufferAttribute,
  currSizeAttr: THREE.BufferAttribute,
  objectCount: number,
  catalogData: EnrichedTLEObject[],
): FrustumResult {
  // Build primary frustum from camera
  _viewProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_viewProjMatrix);

  // Build wider frustum (~90 deg FOV) for peripheral detection.
  // makeFrustum is not in r165 — use makePerspective instead.
  const near = camera.near;
  const far = camera.far;
  const widerFovRad = 90 * Math.PI / 180;
  _widerProjMatrix.makePerspective(-1, 1, 1, -1, near, far); // placeholder; see below
  // Three.js r165: makePerspective(left, right, top, bottom, near, far)
  const widerTop = near * Math.tan(widerFovRad / 2);
  const widerRight = widerTop * camera.aspect;
  _widerProjMatrix.makePerspective(-widerRight, widerRight, widerTop, -widerTop, near, far);
  _widerProjMatrix.multiply(camera.matrixWorldInverse);
  _widerFrustum.setFromProjectionMatrix(_widerProjMatrix);

  // Per-regime and per-category accumulators
  const byRegime: Record<OrbitalRegime, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };
  const byCategory: Record<ObjectCategory, number> = {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  };
  // regime+category cross-product counts — single pass, no second iteration
  const groupMap = new Map<string, FrustumGroup>();

  const inFrustumSet = new Set<number>();
  const inPeripheralSet = new Set<number>();

  const posArr = currPosAttr.array as Float32Array;
  const sizeArr = currSizeAttr.array as Float32Array;
  const count = Math.min(objectCount, catalogData.length);

  for (let i = 0; i < count; i++) {
    // Skip filtered/hidden objects — size=0 set by SatelliteRenderer
    if (sizeArr[i] <= 0) continue;

    const i3 = i * 3;
    // HOT PATH OPTIMIZATION: reuse _scratchVec — no per-object allocation
    _scratchVec.set(posArr[i3], posArr[i3 + 1], posArr[i3 + 2]);

    if (_frustum.containsPoint(_scratchVec)) {
      inFrustumSet.add(i);
      const obj = catalogData[i];
      byRegime[obj.regime]++;
      byCategory[obj.category]++;
      // Accumulate cross-product in a single pass
      const key = `${obj.regime}/${obj.category}`;
      const existing = groupMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        groupMap.set(key, { regime: obj.regime, category: obj.category, count: 1 });
      }
    } else if (_widerFrustum.containsPoint(_scratchVec)) {
      inPeripheralSet.add(i);
    }
  }

  // Sort cross-product groups, take top 5
  const topGroups = Array.from(groupMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const contents: FrustumContents = {
    inViewCount: inFrustumSet.size,
    peripheralCount: inPeripheralSet.size,
    byRegime,
    byCategory,
    topGroups,
  };

  return { contents, inFrustumSet, inPeripheralSet };
}
