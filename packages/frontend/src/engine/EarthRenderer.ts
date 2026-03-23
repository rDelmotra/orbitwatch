/**
 * EarthRenderer — textured Earth sphere + cloud layer + atmosphere rim glow.
 *
 * COORDINATE CONVENTION (critical for satellite alignment):
 *   The scene is in the ECI (inertial) frame.  Earth mesh rotates by
 *   GAST each frame so its texture aligns with real geography.
 *
 *   Satellites are in ECI (TEME) coordinates — placed in the scene via:
 *     mesh.position.set(eci.x, eci.z, -eci.y)
 *   (Three.js is Y-up; ECI/TEME is Z-up toward the North Pole.)
 *
 * All GLSL is inlined as template literals — no .glsl imports.
 */
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Earth surface shaders
// ─────────────────────────────────────────────────────────────────────────────
const EARTH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const EARTH_FRAG = /* glsl */ `
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;
uniform sampler2D uNormalMap;
uniform sampler2D uSpecularMap;
uniform vec3 uSunDirection;
uniform vec3 uCameraPos;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  // ── Normal mapping via screen-space derivatives (no tangent attribute needed) ──
  vec3 normalSample = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
  normalSample.xy *= 0.85;

  vec3 geomN = normalize(vNormal);
  vec3 dPdx  = dFdx(vWorldPos);
  vec3 dPdy  = dFdy(vWorldPos);
  vec2 dUVdx = dFdx(vUv);
  vec2 dUVdy = dFdy(vUv);
  float det  = dUVdx.x * dUVdy.y - dUVdx.y * dUVdy.x;
  vec3 T = (dUVdy.y * dPdx - dUVdx.y * dPdy) / det;
  T = normalize(T - dot(T, geomN) * geomN);
  vec3 B = cross(geomN, T);
  mat3 TBN = mat3(T, B, geomN);
  vec3 N = normalize(TBN * normalSample);

  vec3 sunDir  = normalize(uSunDirection);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float NdotL  = dot(N, sunDir);

  // ── Soft terminator ───────────────────────────────────────────────────────
  // Wide smoothstep avoids the harsh lighting cliff
  float dayBlend = smoothstep(-0.20, 0.15, NdotL);

  vec3 dayColor   = texture2D(uDayMap,   vUv).rgb;
  vec3 nightColor = texture2D(uNightMap, vUv).rgb;

  // City lights visible in dark zone only; fade before terminator so they
  // don't bleed into the lit hemisphere
  float cityBoost = mix(2.5, 0.0, smoothstep(-0.18, 0.02, NdotL));
  vec3 color = mix(nightColor * cityBoost, dayColor, dayBlend);

  // ── Fresnel-driven ocean specular ─────────────────────────────────────────
  // F0 = 0.02 (water at normal incidence); glances off more at shallow angles
  float specMask = texture2D(uSpecularMap, vUv).r;
  float cosV     = max(dot(N, viewDir), 0.0);
  float F0       = 0.02;
  float fresnel  = F0 + (1.0 - F0) * pow(1.0 - cosV, 5.0);
  color += fresnel * specMask * max(NdotL, 0.0) * vec3(0.85, 0.92, 1.0);

  // ── Subtle blue sky-scatter ambient on day side ───────────────────────────
  color += vec3(0.01, 0.025, 0.05) * dayBlend;

  gl_FragColor = vec4(color, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Cloud shaders
// ─────────────────────────────────────────────────────────────────────────────
const CLOUD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;

void main() {
  vUv = uv;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uCloudMap;
uniform vec3 uSunDirection;

varying vec2 vUv;
varying vec3 vNormal;

void main() {
  float cloudAlpha = texture2D(uCloudMap, vUv).r;

  vec3  sunDir = normalize(uSunDirection);
  vec3  N      = normalize(vNormal);
  float NdotL  = dot(N, sunDir);

  // Fade clouds as they pass into shadow
  float nightFade = smoothstep(-0.15, 0.10, NdotL);

  float lit = max(NdotL, 0.0);

  // Base colour: white in full daylight, cool blue-grey in shadow
  vec3 shadowColor = vec3(0.58, 0.63, 0.80);
  vec3 cloudColor  = mix(shadowColor, vec3(1.0), smoothstep(-0.10, 0.25, NdotL));

  // Warm sunset tint near the terminator (peaks at NdotL ≈ 0.05)
  float termFrac  = smoothstep(-0.12, 0.0, NdotL) * (1.0 - smoothstep(0.0, 0.32, NdotL));
  cloudColor      = mix(cloudColor, vec3(1.0, 0.70, 0.38), termFrac * 0.65);

  // Diffuse brightness — keep a small fill so unlit clouds aren't black
  cloudColor *= lit * 0.85 + 0.15;

  gl_FragColor = vec4(cloudColor, cloudAlpha * nightFade);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Atmosphere shaders
// ─────────────────────────────────────────────────────────────────────────────
const ATM_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos  = worldPos.xyz;
  vNormal    = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const ATM_FRAG = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uCameraPos;

varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vec3 N       = normalize(vNormal);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 sunDir  = normalize(uSunDirection);

  // Rim falloff — bright at limb, transparent toward centre
  float rim = pow(1.0 - abs(dot(N, viewDir)), 3.5);

  // Sun angle at this shell position
  float sunAngle = dot(normalize(vWorldPos), sunDir);

  // Colour: deep indigo (night) → warm orange (twilight) → blue-white (day)
  vec3 dayColor      = vec3(0.22, 0.50, 1.00);
  vec3 twilightColor = vec3(0.75, 0.28, 0.06);
  vec3 nightColor    = vec3(0.03, 0.04, 0.14);

  vec3 atmColor;
  if (sunAngle > 0.15) {
    atmColor = dayColor;
  } else if (sunAngle > -0.15) {
    float t  = (sunAngle + 0.15) / 0.30;
    atmColor = mix(twilightColor, dayColor, t);
  } else {
    float t  = smoothstep(- 0.5, 1.0, sunAngle);
    atmColor = mix(nightColor, twilightColor, t);
  }

  // Sunward limb is much brighter; night limb is nearly invisible
  float dayFactor    = smoothstep(-0.50, 0.00, sunAngle);
  float rimStrength  = mix(0.10, 0.72, dayFactor);

  gl_FragColor = vec4(atmColor, rim * rimStrength);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makePixel(r: number, g: number, b: number, a = 255): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// EarthRenderer
// ─────────────────────────────────────────────────────────────────────────────
export class EarthRenderer {
  readonly object: THREE.Group;

  /** Written by Engine every frame via .copy(); update() propagates to uniforms. */
  readonly sunDirection: THREE.Vector3 = new THREE.Vector3(1, 0, 0);

  private readonly cloudMesh: THREE.Mesh;
  private readonly earthMat: THREE.ShaderMaterial;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly atmMat: THREE.ShaderMaterial;

  constructor(
    maxAnisotropy: number,
    _renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
  ) {
    this.object = new THREE.Group();

    const loader = new THREE.TextureLoader();

    const load = (
      path: string,
      colorSpace: THREE.ColorSpace,
      onLoad: (t: THREE.Texture) => void,
    ): void => {
      loader.load(path, (tex) => {
        tex.colorSpace = colorSpace;
        tex.anisotropy = maxAnisotropy;
        tex.needsUpdate = true;
        onLoad(tex);
      });
    };

    const initCamPos = camera.position.clone();

    // ── Earth surface ───────────────────────────────────────────────────────
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDayMap: { value: makePixel(80, 120, 180) },
        uNightMap: { value: makePixel(0, 0, 0) },
        uNormalMap: { value: makePixel(128, 128, 255) }, // flat normal
        uSpecularMap: { value: makePixel(0, 0, 0) },       // no specular until loaded
        uSunDirection: { value: this.sunDirection.clone() },
        uCameraPos: { value: initCamPos.clone() },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    });

    load('/textures/earth-diffuse-8k.jpg', THREE.SRGBColorSpace,
      (t) => { this.earthMat.uniforms.uDayMap.value = t; });
    load('/textures/earth-night-4k.jpg', THREE.SRGBColorSpace,
      (t) => { this.earthMat.uniforms.uNightMap.value = t; });
    load('/textures/earth-bump-4k.jpg', THREE.LinearSRGBColorSpace,
      (t) => { this.earthMat.uniforms.uNormalMap.value = t; });
    load('/textures/earth-specular-4k.jpg', THREE.LinearSRGBColorSpace,
      (t) => { this.earthMat.uniforms.uSpecularMap.value = t; });

    const earthGeo = new THREE.SphereGeometry(1.0, 128, 64);
    this.object.add(new THREE.Mesh(earthGeo, this.earthMat));

    // ── Cloud layer ─────────────────────────────────────────────────────────
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudMap: { value: makePixel(255, 255, 255, 0) },
        uSunDirection: { value: this.sunDirection.clone() },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });

    load('/textures/earth-clouds-4k.png', THREE.LinearSRGBColorSpace,
      (t) => { this.cloudMat.uniforms.uCloudMap.value = t; });

    const cloudGeo = new THREE.SphereGeometry(1.004, 64, 32);
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.cloudMat);
    this.object.add(this.cloudMesh);

    // ── Atmosphere shell — BackSide, additive blending ──────────────────────
    this.atmMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: this.sunDirection.clone() },
        uCameraPos: { value: initCamPos.clone() },
      },
      vertexShader: ATM_VERT,
      fragmentShader: ATM_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const atmGeo = new THREE.SphereGeometry(1.025, 64, 32);
    this.object.add(new THREE.Mesh(atmGeo, this.atmMat));
  }

  /**
   * Called every frame.
   * Pushes uCameraPos to all shaderss that need it, and propagates the
   * sunDirection (already written by Engine) to all shader uniforms.
   * Also slowly rotates the cloud mesh.
   */
  update(delta: number, camera: THREE.Camera): void {
    const camPos = camera.position;

    this.earthMat.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.earthMat.uniforms.uCameraPos.value.copy(camPos);

    this.cloudMat.uniforms.uSunDirection.value.copy(this.sunDirection);

    this.atmMat.uniforms.uSunDirection.value.copy(this.sunDirection);
    this.atmMat.uniforms.uCameraPos.value.copy(camPos);

    this.cloudMesh.rotation.y += 0.0001 * delta;
  }

  dispose(): void {
    this.object.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}
