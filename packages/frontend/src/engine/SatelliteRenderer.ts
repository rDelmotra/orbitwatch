import * as THREE from 'three';
import vertexShader from '../shaders/catalog.vert.glsl?raw';
import fragmentShader from '../shaders/catalog.frag.glsl?raw';
import { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '../data/types';
import { isEclipsed, isObserverInDark, getPhaseMultiplier } from '../orbital/lighting';
import type { VisibilityMode } from '../store/useStore';

const MAX_OBJECTS = 100_000;

const CATEGORY_COLORS: Record<string, [number, number, number]> = {
  active_satellite:   [0.298, 0.686, 0.314],
  inactive_satellite: [0.620, 0.620, 0.620],
  rocket_body:        [1.000, 0.757, 0.027],
  debris:             [0.957, 0.263, 0.212],
  unknown:            [0.459, 0.459, 0.459],
  deep_space:         [0.000, 0.737, 0.831],
};

export class SatelliteRenderer {
  readonly mesh: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly prevPosAttr: THREE.BufferAttribute;
  private readonly currPosAttr: THREE.BufferAttribute;
  private readonly prevSizeAttr: THREE.BufferAttribute;
  private readonly currSizeAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute; // Alias for currSizeAttr for picking
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly pickIdAttr: THREE.BufferAttribute;
  private readonly multipliers: Float32Array;
  private readonly filterMask: Uint8Array;
  private readonly validFlags: Uint8Array;

  constructor(scene: THREE.Scene) {
    const prevPositions = new Float32Array(MAX_OBJECTS * 3);
    const currPositions = new Float32Array(MAX_OBJECTS * 3);
    const prevSizes = new Float32Array(MAX_OBJECTS);
    const currSizes = new Float32Array(MAX_OBJECTS);
    const colors = new Float32Array(MAX_OBJECTS * 3);
    const pickIds = new Float32Array(MAX_OBJECTS * 3); // 0,0,0 = background until initFromCatalog
    this.multipliers = new Float32Array(MAX_OBJECTS).fill(1.0);
    this.filterMask = new Uint8Array(MAX_OBJECTS).fill(1);
    this.validFlags = new Uint8Array(MAX_OBJECTS).fill(0);

    this.geometry = new THREE.BufferGeometry();
    this.prevPosAttr = new THREE.BufferAttribute(prevPositions, 3);
    this.currPosAttr = new THREE.BufferAttribute(currPositions, 3);
    this.prevSizeAttr = new THREE.BufferAttribute(prevSizes, 1);
    this.currSizeAttr = new THREE.BufferAttribute(currSizes, 1);
    this.sizeAttr = this.currSizeAttr;
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.pickIdAttr = new THREE.BufferAttribute(pickIds, 3);

    this.geometry.setAttribute('previousPosition', this.prevPosAttr);
    this.geometry.setAttribute('currentPosition', this.currPosAttr);
    this.geometry.setAttribute('position', this.currPosAttr); // Three.js requires 'position' for bounding sphere
    this.geometry.setAttribute('previousSize', this.prevSizeAttr);
    this.geometry.setAttribute('currentSize', this.currSizeAttr);
    this.geometry.setAttribute('size', this.sizeAttr); // For CPU picking compatibility
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setAttribute('pickId', this.pickIdAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPixelRatio: { value: 1.0 },
        uCameraDistance: { value: 5.0 },
        uBaseColor: { value: new THREE.Vector3(1, 1, 1) },
        uT: { value: 0.0 },
        uSelectedIndex: { value: -1.0 },
        uTimeSinceArrival: { value: -1.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  updatePositions(
    eciPositions: Float32Array,
    validFlags: Uint8Array,
    count: number,
    observerPos: THREE.Vector3 | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    catalogData: EnrichedTLEObject[],
    categoryFilters: Record<ObjectCategory, boolean>,
    regimeFilters: Record<OrbitalRegime, boolean>,
    visualNoradIds: Set<number>
  ): { categoryCounts: Record<ObjectCategory, number>; regimeCounts: Record<OrbitalRegime, number> } {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;

    // Copy current → previous (in-place, no reallocation)
    prevArr.set(currArr);
    this.validFlags.set(validFlags);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // ECI (TEME) → Three.js axis swap:
      //   X stays X, ECI Z → Three.js Y, ECI Y → Three.js -Z
      currArr[i3] = eciPositions[i3];
      currArr[i3 + 1] = eciPositions[i3 + 2];
      currArr[i3 + 2] = -eciPositions[i3 + 1];
    }

    this.prevPosAttr.needsUpdate = true;
    this.currPosAttr.needsUpdate = true;
    
    return this.applyVisibilityAndFilters(count, observerPos, sunDir, visibilityMode, catalogData, categoryFilters, regimeFilters, visualNoradIds);
  }

  setSatelliteColor(index: number, r: number, g: number, b: number): void {
    const colorArr = this.colorAttr.array as Float32Array;
    colorArr[index * 3] = r;
    colorArr[index * 3 + 1] = g;
    colorArr[index * 3 + 2] = b;
    this.colorAttr.needsUpdate = true;
  }

  setSatelliteSize(index: number, multiplier: number): void {
    this.multipliers[index] = multiplier;
    const currSizeArr = this.currSizeAttr.array as Float32Array;
    currSizeArr[index] = multiplier; // update immediately if not waiting for next propagate
    this.currSizeAttr.needsUpdate = true;
  }

  initFromCatalog(objects: EnrichedTLEObject[]): void {
    const colorArr = this.colorAttr.array as Float32Array;
    const pickArr = this.pickIdAttr.array as Float32Array;

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      let rcsMult = 1.0;
      if (obj.rcsSize === 'LARGE') rcsMult = 1.2;
      else if (obj.rcsSize === 'SMALL') rcsMult = 0.6;
      this.multipliers[i] = rcsMult;

      const [r, g, b] = CATEGORY_COLORS[obj.category] ?? CATEGORY_COLORS.unknown;
      colorArr[i * 3]     = r;
      colorArr[i * 3 + 1] = g;
      colorArr[i * 3 + 2] = b;

      const encoded = i + 1; // reserve 0 for background
      pickArr[i * 3]     = ((encoded >> 16) & 0xFF) / 255;
      pickArr[i * 3 + 1] = ((encoded >> 8)  & 0xFF) / 255;
      pickArr[i * 3 + 2] = ( encoded        & 0xFF) / 255;
    }

    this.colorAttr.needsUpdate = true;
    this.pickIdAttr.needsUpdate = true;
  }

  updateUniforms(cameraDistance: number, pixelRatio: number): void {
    this.material.uniforms.uCameraDistance.value = cameraDistance;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  updateSelectedUniforms(selectedIndex: number, timeSinceArrival: number): void {
    this.material.uniforms.uSelectedIndex.value = selectedIndex;
    this.material.uniforms.uTimeSinceArrival.value = timeSinceArrival;
  }

  /** Returns the GPU-equivalent interpolated world position for a single object. */
  getInterpolatedPosition(index: number, t: number): THREE.Vector3 {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;
    const i3 = index * 3;
    return new THREE.Vector3(
      prevArr[i3]     + (currArr[i3]     - prevArr[i3])     * t,
      prevArr[i3 + 1] + (currArr[i3 + 1] - prevArr[i3 + 1]) * t,
      prevArr[i3 + 2] + (currArr[i3 + 2] - prevArr[i3 + 2]) * t,
    );
  }

  private applyVisibilityAndFilters(
    count: number,
    observerPos: THREE.Vector3 | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    catalogData: EnrichedTLEObject[],
    categoryFilters: Record<ObjectCategory, boolean>,
    regimeFilters: Record<OrbitalRegime, boolean>,
    visualNoradIds: Set<number>
  ): { categoryCounts: Record<ObjectCategory, number>; regimeCounts: Record<OrbitalRegime, number> } {
    const prevSizeArr = this.prevSizeAttr.array as Float32Array;
    const currSizeArr = this.currSizeAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;

    prevSizeArr.set(currSizeArr);

    const catCounts: Record<ObjectCategory, number> = {
      active_satellite: 0, inactive_satellite: 0, rocket_body: 0, debris: 0, unknown: 0, deep_space: 0,
    };
    const regCounts: Record<OrbitalRegime, number> = {
      LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
    };

    const obsInDark = observerPos ? isObserverInDark(observerPos, sunDir) : false;
    const satPos = new THREE.Vector3();
    const hasVisualList = visualNoradIds.size > 0;

    for (let i = 0; i < count; i++) {
      const obj = catalogData[i];
      const isVisibleBase = this.validFlags[i] === 1 && categoryFilters[obj.category] && regimeFilters[obj.regime];
      this.filterMask[i] = isVisibleBase ? 1 : 0;

      let finalMult = 0.0;

      if (isVisibleBase) {
        finalMult = this.multipliers[i];

        // Naked-eye NORAD gate: early exit before any vector math.
        // If the visual list failed to load (empty set), skip this gate gracefully.
        if (visibilityMode === 'visual' && hasVisualList && !visualNoradIds.has(obj.noradId)) {
          finalMult = 0.0;
        } else if (visibilityMode !== 'all' && observerPos) {
          const i3 = i * 3;
          satPos.set(currArr[i3], currArr[i3 + 1], currArr[i3 + 2]);

          const V = satPos.clone().sub(observerPos);
          const vDist = V.length();
          const zenith = observerPos.clone().normalize();
          const sinElev = V.dot(zenith) / vDist;

          if (sinElev < 0.1736) { // Below 10 degrees elevation
            finalMult = 0.0;
          } else {
            if (visibilityMode === 'visual') {
              // Hard 2000 km range cutoff — eliminates MEO/GEO/HEO clutter
              const distKm = vDist * 6371;
              if (distKm > 2000) {
                finalMult = 0.0;
              } else if (!obsInDark || isEclipsed(satPos, sunDir)) {
                finalMult = 0.0;
              } else {
                finalMult *= getPhaseMultiplier(satPos, observerPos, sunDir) * 1.5;
              }
            } else {
              // Radio pass: RCS multiplier already in finalMult; apply range + mode scalar
              const distKm = vDist * 6371;
              const rangeScale = Math.max(0.3, Math.min(1.0, 2000 / distKm));
              finalMult *= rangeScale * 0.6;
            }

            // Fading cone: gradual falloff from 45° to 10° elevation
            if (finalMult > 0.0 && sinElev < 0.707) {
              finalMult *= Math.max(0.4, (sinElev - 0.1736) / (0.707 - 0.1736));
            }
          }
        }

        currSizeArr[i] = finalMult;
        if (finalMult > 0.0) {
          catCounts[obj.category]++;
          regCounts[obj.regime]++;
        }
      } else {
        currSizeArr[i] = 0.0;
      }
    }

    this.prevSizeAttr.needsUpdate = true;
    this.currSizeAttr.needsUpdate = true;
    return { categoryCounts: catCounts, regimeCounts: regCounts };
  }

  applyFilters(
    catalogData: EnrichedTLEObject[],
    categoryFilters: Record<ObjectCategory, boolean>,
    regimeFilters: Record<OrbitalRegime, boolean>,
    observerPos: THREE.Vector3 | null,
    sunDir: THREE.Vector3,
    visibilityMode: VisibilityMode,
    visualNoradIds: Set<number>
  ): { categoryCounts: Record<ObjectCategory, number>; regimeCounts: Record<OrbitalRegime, number> } {
    return this.applyVisibilityAndFilters(catalogData.length, observerPos, sunDir, visibilityMode, catalogData, categoryFilters, regimeFilters, visualNoradIds);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
