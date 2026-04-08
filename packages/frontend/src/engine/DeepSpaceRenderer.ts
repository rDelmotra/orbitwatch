import * as THREE from 'three';
import type { DeepSpaceObject, HorizonsEphemerisPoint } from '../data/types';
import { interpolateEphemeris } from '../orbital/hermite';

// ── Shaders ──────────────────────────────────────────────────────────────────

const VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform int   uSelectedIndex;
  attribute float aIndex;
  varying float vSelected;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    bool sel = (int(aIndex + 0.5) == uSelectedIndex);
    vSelected = sel ? 1.0 : 0.0;

    float pulse    = 1.0 + 0.25 * sin(uTime * 1.8);
    float baseSize = sel ? 14.0 : 9.0;
    float dist     = max(-mvPosition.z, 0.1);
    float size     = baseSize * pulse * uPixelRatio * (5.0 / dist);
    gl_PointSize   = clamp(size, 4.0, 48.0);
  }
`;

const FRAG = `
  varying float vSelected;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    float core  = 1.0 - smoothstep(0.00, 0.18, d);
    float halo  = 1.0 - smoothstep(0.10, 0.50, d);
    float alpha = core * 0.95 + halo * 0.45;

    // Deep-space purple (#E040FB) unselected, cyan (#00E5FF) selected
    vec3 color = mix(
      vec3(0.878, 0.251, 0.984),
      vec3(0.000, 0.898, 1.000),
      vSelected
    );
    gl_FragColor = vec4(color, alpha);
  }
`;

// ── DeepSpaceRenderer ─────────────────────────────────────────────────────────

export class DeepSpaceRenderer {
  private scene: THREE.Scene;
  private objects: DeepSpaceObject[] = [];
  private positions: Float32Array = new Float32Array(0);
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Points;
  private currentPositions: THREE.Vector3[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.geometry = new THREE.BufferGeometry();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:          { value: 0 },
        uPixelRatio:    { value: window.devicePixelRatio },
        uSelectedIndex: { value: -1 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  initFromCatalog(objects: DeepSpaceObject[]): void {
    this.objects = objects;
    const n = objects.length;

    this.positions = new Float32Array(n * 3); // all zeros until first update
    this.currentPositions = Array.from({ length: n }, () => new THREE.Vector3());

    const indexAttr = new Float32Array(n);
    for (let i = 0; i < n; i++) indexAttr[i] = i;

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aIndex',   new THREE.BufferAttribute(indexAttr, 1));
  }

  /**
   * Called every frame. Hermite-interpolates each DSO's position and updates
   * the GPU buffer.
   *
   * @param timestampMs  Current wall-clock time (Unix ms), used for interpolation.
   * @param ephemeris    Ephemeris map keyed by horizonsId.
   * @param elapsed      Total seconds since engine start (used for pulse animation).
   */
  update(
    timestampMs: number,
    ephemeris: Record<string, HorizonsEphemerisPoint[]>,
    elapsed: number,
  ): void {
    this.material.uniforms.uTime.value = elapsed;

    for (let i = 0; i < this.objects.length; i++) {
      const obj = this.objects[i];
      const pts = ephemeris[obj.horizonsId];
      if (!pts || pts.length === 0) continue;

      const pos = interpolateEphemeris(pts, timestampMs);
      if (!pos) continue;

      this.positions[i * 3]     = pos.x;
      this.positions[i * 3 + 1] = pos.y;
      this.positions[i * 3 + 2] = pos.z;
      this.currentPositions[i].set(pos.x, pos.y, pos.z);
    }

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (posAttr) posAttr.needsUpdate = true;
  }

  /**
   * Returns the current world-space position of the DSO (in scene units / Earth radii).
   * Returns null if the index is out of range or ephemeris hasn't been received yet.
   */
  getPosition(index: number): THREE.Vector3 | null {
    if (index < 0 || index >= this.currentPositions.length) return null;
    if (this.currentPositions[index].lengthSq() === 0) return null;
    return this.currentPositions[index].clone();
  }

  setSelectedIndex(index: number): void {
    this.material.uniforms.uSelectedIndex.value = index;
  }

  clearSelection(): void {
    this.material.uniforms.uSelectedIndex.value = -1;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
