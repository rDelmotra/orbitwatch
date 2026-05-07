import * as THREE from 'three';
import { isEclipsedFromComponents } from '../../orbital/lighting';
import type { EnrichedTLEObject } from '../../data/types';
import type { NotableObjectState, NotableTransition } from '../types';

interface HeroEntry {
  noradId: number;
  catalogIndex: number;
  obj: EnrichedTLEObject;
}

// Canonical list of notable objects. Any not found in the catalog are silently skipped.
const NOTABLE_NORAD_IDS: number[] = [
  25544, // ISS
  20580, // Hubble Space Telescope
  48274, // CSS Tiangong
  5,     // Vanguard 1 (oldest satellite in orbit)
  33591, // NOAA 19
  41866, // GOES-16
  51850, // GOES-18
  49260, // Landsat 9
  29486, // GPS IIR-M 1
  34454, // COSMOS 2251 DEB (notable debris field)
  33774, // Iridium 33 DEB (notable debris field)
  27386, // Envisat
  37775, // ASTRA 1N (GEO)
  36516, // SES-1 (GEO)
  44713, // Starlink-24 (representative bright Starlink)
  45623, // NOAA 20
];

// HOT PATH OPTIMIZATION: pre-allocated scratch for distance calculation.
// Do not remove — avoids per-notable Vector3 allocations.
const _scratchPos = new THREE.Vector3();

export class NotableTracker {
  private readonly heroes: HeroEntry[];
  private prevFrustumMap = new Map<number, boolean>(); // noradId → inFrustum
  private prevEclipseMap = new Map<number, boolean>(); // noradId → eclipsed

  constructor(catalogData: EnrichedTLEObject[]) {
    this.heroes = [];
    for (const noradId of NOTABLE_NORAD_IDS) {
      const catalogIndex = catalogData.findIndex((d) => d.noradId === noradId);
      if (catalogIndex !== -1) {
        this.heroes.push({ noradId, catalogIndex, obj: catalogData[catalogIndex] });
      }
    }
  }

  tick(
    currPosAttr: THREE.BufferAttribute,
    sunDir: THREE.Vector3,
    cameraPos: THREE.Vector3,
    inFrustumSet: Set<number>,
    inPeripheralSet: Set<number>,
  ): { states: NotableObjectState[]; transitions: NotableTransition[] } {
    const states: NotableObjectState[] = [];
    const transitions: NotableTransition[] = [];

    const posArr = currPosAttr.array as Float32Array;

    for (const hero of this.heroes) {
      const i3 = hero.catalogIndex * 3;
      const x = posArr[i3];
      const y = posArr[i3 + 1];
      const z = posArr[i3 + 2];

      // Skip if position is zero (not yet propagated)
      if (x === 0 && y === 0 && z === 0) continue;

      const mag = Math.sqrt(x * x + y * y + z * z);
      const altitudeKm = (mag - 1.0) * 6371;

      // HOT PATH OPTIMIZATION: reuse _scratchPos, no per-notable allocation
      _scratchPos.set(x, y, z);
      const distanceFromCameraEr = _scratchPos.distanceTo(cameraPos);

      const inFrustum = inFrustumSet.has(hero.catalogIndex);
      const inPeripheral = !inFrustum && inPeripheralSet.has(hero.catalogIndex);
      const eclipsed = isEclipsedFromComponents(x, y, z, sunDir.x, sunDir.y, sunDir.z);

      // Detect transitions vs previous tick
      const prevFrustum = this.prevFrustumMap.get(hero.noradId);
      const prevEclipse = this.prevEclipseMap.get(hero.noradId);

      if (prevFrustum !== undefined) {
        if (!prevFrustum && inFrustum) {
          transitions.push({ noradId: hero.noradId, name: hero.obj.name, kind: 'entered_view' });
        } else if (prevFrustum && !inFrustum) {
          transitions.push({ noradId: hero.noradId, name: hero.obj.name, kind: 'exited_view' });
        }
      }
      if (prevEclipse !== undefined) {
        if (!prevEclipse && eclipsed) {
          transitions.push({ noradId: hero.noradId, name: hero.obj.name, kind: 'entered_eclipse' });
        } else if (prevEclipse && !eclipsed) {
          transitions.push({ noradId: hero.noradId, name: hero.obj.name, kind: 'exited_eclipse' });
        }
      }

      // Update maps for next tick (~20 entries each, trivial cost)
      this.prevFrustumMap.set(hero.noradId, inFrustum);
      this.prevEclipseMap.set(hero.noradId, eclipsed);

      states.push({
        noradId: hero.noradId,
        name: hero.obj.name,
        catalogIndex: hero.catalogIndex,
        altitudeKm,
        distanceFromCameraEr,
        inFrustum,
        inPeripheral,
        eclipsed,
        regime: hero.obj.regime,
        category: hero.obj.category,
      });
    }

    return { states, transitions };
  }
}
