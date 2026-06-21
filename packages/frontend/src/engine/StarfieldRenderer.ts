import * as THREE from 'three';

const STAR_COUNT = 5000;
const STAR_RADIUS = 500;

const STAR_VERT = /* glsl */ `
attribute vec3 color;        // per-star colour (not auto-injected for ShaderMaterial)
uniform float uSize;
uniform vec3  uClipNormal;   // points on the negative side of this plane fade out
varying vec3  vColor;
varying float vSide;         // signed projection of the star direction onto uClipNormal

void main() {
  vColor = color;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vSide = dot(normalize(worldPos.xyz - cameraPosition), uClipNormal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  gl_PointSize = uSize;
}
`;

const STAR_FRAG = /* glsl */ `
uniform float uClipEnabled;  // 1 = fade points below the clip plane, 0 = full sphere
varying vec3  vColor;
varying float vSide;

void main() {
  float a = 1.0;
  if (uClipEnabled > 0.5) {
    // Fade out points below the clip plane (vSide < 0).
    a = smoothstep(-0.06, 0.02, vSide);
    if (a <= 0.001) discard;
  }
  gl_FragColor = vec4(vColor, a);
}
`;

/**
 * Background starfield (5000 stars). A generic backdrop primitive — it knows nothing
 * about app modes; callers may optionally enable a generic horizon clip (fade points
 * below a plane) via {@link setHorizonClip}. The *policy* of when/why to clip lives in
 * the owning layer.
 */
export class StarfieldRenderer {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);

    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);

      const x = STAR_RADIUS * Math.sin(phi) * Math.cos(theta);
      const y = STAR_RADIUS * Math.sin(phi) * Math.sin(theta);
      const z = STAR_RADIUS * Math.cos(phi);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const brightness = 0.3 + Math.random() * 0.7;
      colors[i * 3] = brightness;
      colors[i * 3 + 1] = brightness;
      colors[i * 3 + 2] = brightness;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: 0.5 },
        uClipNormal: { value: new THREE.Vector3(0, 1, 0) },
        uClipEnabled: { value: 0 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
    });

    this.object = new THREE.Points(geo, this.material);
  }

  /**
   * Generic horizon clip: when `enabled`, points whose direction projects negative
   * onto `planeNormal` fade out. `enabled=false` renders the full sphere unchanged.
   * (The dome layer uses this with the observer zenith to hide sub-horizon stars.)
   */
  setHorizonClip(planeNormal: THREE.Vector3, enabled: boolean): void {
    this.material.uniforms.uClipNormal.value.copy(planeNormal);
    this.material.uniforms.uClipEnabled.value = enabled ? 1 : 0;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
