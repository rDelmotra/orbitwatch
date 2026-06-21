import * as THREE from 'three';
import { getObserverSceneAnchor } from '../../../orbital/coordinates';
import { useStore, isDomeView } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Sky sphere radius — inside the far plane (1000); the camera is always at its centre. */
const SKY_RADIUS = 50;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

/**
 * Analytic ground‑level sky: colour by view elevation (horizon→zenith fade) with a
 * day/night blend driven by the sun's elevation, a warm twilight lobe toward the sun
 * azimuth near the horizon, and a fade to near‑black below the horizon (implied ground).
 * `cameraPosition` is auto‑injected by three for ShaderMaterial.
 */
const SKY_FRAG = /* glsl */ `
uniform vec3 uUp;      // observer zenith, scene frame
uniform vec3 uSunDir;  // sun unit vector, scene frame

varying vec3 vWorldPos;

void main() {
  vec3 viewDir = normalize(vWorldPos - cameraPosition);
  vec3 sunDir  = normalize(uSunDir);

  float elev    = dot(viewDir, uUp);   // 1 = zenith, 0 = horizon, <0 = below
  float sunElev = dot(sunDir, uUp);    // sine of the sun's elevation

  // Night → day across civil twilight.
  float dayness = smoothstep(-0.18, 0.10, sunElev);

  vec3 zenithDay    = vec3(0.18, 0.42, 0.82);
  vec3 horizonDay   = vec3(0.62, 0.76, 0.92);
  vec3 zenithNight  = vec3(0.012, 0.020, 0.055);
  vec3 horizonNight = vec3(0.040, 0.060, 0.130);

  vec3 zenithColor  = mix(zenithNight, zenithDay, dayness);
  vec3 horizonColor = mix(horizonNight, horizonDay, dayness);

  float g = smoothstep(0.0, 0.55, max(elev, 0.0));
  vec3 color = mix(horizonColor, zenithColor, g);

  // Warm twilight glow toward the sun, strongest near the horizon while the sun
  // sits just below/above it. Gated to CIVIL twilight + golden hour: sunElev is
  // sin(sun altitude), so the band rides ~ -7° (sin -0.12) up through the horizon
  // and fades out by ~ +7° (sin +0.12). Past civil twilight the night sky is dim
  // blue, not orange — this is what keeps the glow honest after the sun has set.
  float towardSun        = max(dot(viewDir, sunDir), 0.0);
  float twilightWindow   = smoothstep(-0.12, -0.02, sunElev) * (1.0 - smoothstep(0.02, 0.12, sunElev));
  float horizonProximity = 1.0 - smoothstep(0.0, 0.32, abs(elev));
  float glow = pow(towardSun, 3.0) * twilightWindow * horizonProximity;
  color += vec3(1.0, 0.46, 0.20) * glow * 0.6;

  // Below the horizon: fade to near‑black (implied ground; there is no floor object).
  float belowFade = smoothstep(0.0, -0.25, elev);
  color = mix(color, vec3(0.004), belowFade);

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * The dome planetarium sky — a camera‑centred gradient sky shown **only in dome mode**,
 * replacing the from‑space Earth/atmosphere backdrop (which the {@link EarthLayer} hides
 * in dome mode). Drawn first (`renderOrder = -1000`, depth test off) so stars, satellites
 * and the compass render on top. Non‑critical; owns + disposes its own GL.
 *
 * Why a dedicated sky: in dome mode the camera sits ~16 m above the surface, *inside* the
 * from‑space atmosphere shell, where its raymarch (built for camera‑outside viewing) plus
 * the 63 km near plane produce a black gap + uneven limb band. This analytic sky has no
 * such regime problems.
 */
export class DomeSkyLayer implements Layer {
  readonly name = 'dome-sky';
  readonly critical = false;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private readonly up = new THREE.Vector3(0, 1, 0); // per-frame scratch (no alloc)

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide, // camera is inside the sphere
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1000;   // background: drawn before everything
    this.mesh.frustumCulled = false; // always centred on the camera
    this.mesh.visible = false;
    ctx.scene.add(this.mesh);
  }

  update(frame: FrameContext): void {
    if (!this.mesh || !this.material || !this.camera) return;

    // Show only while actually standing in the dome view; joyride/fly-to out of dome
    // (cameraMode !== 'free') hides the sky so the normal space view is unobstructed.
    const dome = isDomeView(useStore.getState());
    this.mesh.visible = dome;
    if (!dome) return;

    // Skybox: keep the dome centred on the eye so it never clips or approaches.
    this.mesh.position.copy(this.camera.position);

    const loc = useStore.getState().observerLocation;
    if (loc) {
      this.up.copy(getObserverSceneAnchor(loc.lat, loc.lon, loc.alt, frame.date).up);
    } else {
      this.up.set(0, 1, 0);
    }
    this.material.uniforms.uUp.value.copy(this.up);
    this.material.uniforms.uSunDir.value.copy(frame.sunDirectionECI);
  }

  dispose(): void {
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.scene = null;
    this.camera = null;
  }
}
