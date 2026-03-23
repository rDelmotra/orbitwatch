import * as THREE from 'three';
import vertexShader from '../shaders/catalog.vert.glsl?raw';
import fragmentShader from '../shaders/catalog.frag.glsl?raw';
import { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '../data/types';

const MAX_OBJECTS = 100_000;

const CATEGORY_COLORS: Record<string, [number, number, number]> = {
  active_satellite:   [0.298, 0.686, 0.314],
  inactive_satellite: [0.620, 0.620, 0.620],
  rocket_body:        [1.000, 0.757, 0.027],
  debris:             [0.957, 0.263, 0.212],
  unknown:            [0.459, 0.459, 0.459],
};

export class SatelliteRenderer {
  readonly mesh: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly prevPosAttr: THREE.BufferAttribute;
  private readonly currPosAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly pickIdAttr: THREE.BufferAttribute;
  private readonly multipliers: Float32Array;
  private readonly filterMask: Uint8Array;

  constructor(scene: THREE.Scene) {
    const prevPositions = new Float32Array(MAX_OBJECTS * 3);
    const currPositions = new Float32Array(MAX_OBJECTS * 3);
    const sizes = new Float32Array(MAX_OBJECTS); // all 0.0 — hidden until real data
    const colors = new Float32Array(MAX_OBJECTS * 3);
    const pickIds = new Float32Array(MAX_OBJECTS * 3); // 0,0,0 = background until initFromCatalog
    this.multipliers = new Float32Array(MAX_OBJECTS).fill(1.0);
    this.filterMask = new Uint8Array(MAX_OBJECTS).fill(1);

    this.geometry = new THREE.BufferGeometry();
    this.prevPosAttr = new THREE.BufferAttribute(prevPositions, 3);
    this.currPosAttr = new THREE.BufferAttribute(currPositions, 3);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.pickIdAttr = new THREE.BufferAttribute(pickIds, 3);

    this.geometry.setAttribute('previousPosition', this.prevPosAttr);
    this.geometry.setAttribute('currentPosition', this.currPosAttr);
    this.geometry.setAttribute('position', this.currPosAttr); // Three.js requires 'position' for bounding sphere
    this.geometry.setAttribute('size', this.sizeAttr);
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
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  updatePositions(eciPositions: Float32Array, validFlags: Uint8Array, count: number): void {
    const prevArr = this.prevPosAttr.array as Float32Array;
    const currArr = this.currPosAttr.array as Float32Array;
    const sizeArr = this.sizeAttr.array as Float32Array;

    // Copy current → previous (in-place, no reallocation)
    prevArr.set(currArr);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // ECI (TEME) → Three.js axis swap:
      //   X stays X, ECI Z → Three.js Y, ECI Y → Three.js -Z
      currArr[i3] = eciPositions[i3];
      currArr[i3 + 1] = eciPositions[i3 + 2];
      currArr[i3 + 2] = -eciPositions[i3 + 1];

      sizeArr[i] = (validFlags[i] === 0 || this.filterMask[i] === 0) ? 0.0 : this.multipliers[i];
    }

    this.prevPosAttr.needsUpdate = true;
    this.currPosAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
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
    const sizeArr = this.sizeAttr.array as Float32Array;
    sizeArr[index] = multiplier; // update immediately if not waiting for next propagate
    this.sizeAttr.needsUpdate = true;
  }

  initFromCatalog(objects: EnrichedTLEObject[]): void {
    const colorArr = this.colorAttr.array as Float32Array;
    const pickArr = this.pickIdAttr.array as Float32Array;

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
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

  applyFilters(
    catalogData: EnrichedTLEObject[],
    categoryFilters: Record<ObjectCategory, boolean>,
    regimeFilters: Record<OrbitalRegime, boolean>,
  ): { categoryCounts: Record<ObjectCategory, number>; regimeCounts: Record<OrbitalRegime, number> } {
    const sizeArr = this.sizeAttr.array as Float32Array;
    const catCounts: Record<ObjectCategory, number> = {
      active_satellite: 0, inactive_satellite: 0, rocket_body: 0, debris: 0, unknown: 0,
    };
    const regCounts: Record<OrbitalRegime, number> = {
      LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0,
    };

    for (let i = 0; i < catalogData.length; i++) {
      const obj = catalogData[i];
      const visible = categoryFilters[obj.category] && regimeFilters[obj.regime];
      this.filterMask[i] = visible ? 1 : 0;
      sizeArr[i] = visible ? this.multipliers[i] : 0.0;
      if (visible) {
        catCounts[obj.category]++;
        regCounts[obj.regime]++;
      }
    }

    this.sizeAttr.needsUpdate = true;
    return { categoryCounts: catCounts, regimeCounts: regCounts };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
