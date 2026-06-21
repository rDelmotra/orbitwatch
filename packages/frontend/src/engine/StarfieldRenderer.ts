import * as THREE from 'three';

const STAR_COUNT = 5000;
const STAR_RADIUS = 500;

const STAR_VERT = /* glsl */ `
attribute vec3 color;        // per-star colour (not auto-injected for ShaderMaterial)
uniform float uSize;
uniform vec3  uUp;           // observer zenith (scene frame), for the dome horizon fade
varying vec3  vColor;
varying float vElev;         // star elevation above the observer horizon (sin)

void main() {
  vColor = color;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vElev = dot(normalize(worldPos.xyz - cameraPosition), uUp);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  gl_PointSize = uSize;
}
`;

const STAR_FRAG = /* glsl */ `
uniform float uDomeActive;   // 1 while standing in the dome view, else 0
varying vec3  vColor;
varying float vElev;

void main() {
  float a = 1.0;
  if (uDomeActive > 0.5) {
    // Stars below the observer's horizon are under the sea — fade them out so the
    // water reads as opaque instead of showing stars "through" it.
    a = smoothstep(-0.06, 0.02, vElev);
    if (a <= 0.001) discard;
  }
  gl_FragColor = vec4(vColor, a);
}
`;

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
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uDomeActive: { value: 0 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
    });

    this.object = new THREE.Points(geo, this.material);
  }

  /**
   * Dome mode: fade out stars below the observer's horizon (they sit under the sea).
   * `active=false` (any non-dome view) renders the full sphere of stars unchanged.
   */
  setDomeOcclusion(up: THREE.Vector3, active: boolean): void {
    this.material.uniforms.uUp.value.copy(up);
    this.material.uniforms.uDomeActive.value = active ? 1 : 0;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
