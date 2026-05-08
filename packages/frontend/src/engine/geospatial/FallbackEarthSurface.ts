/**
 * FallbackEarthSurface — textured Earth sphere + cloud layer + atmosphere rim glow.
 *
 * Extracted verbatim from EarthRenderer.ts. This is the always-available baseline;
 * individual meshes are hidden (mesh.visible = false) as Takram modules take over.
 *
 * Lifecycle: constructor adds all meshes to earthGroup synchronously.
 * No async steps — ready = true immediately.
 */
import * as THREE from 'three';

const ATM_INNER_RADIUS = 1.0;
const ATM_OUTER_RADIUS = 1.12;
const ATM_RAY_STEPS = 24;

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

  float height  = texture2D(uNormalMap, vUv).r;
  float heightX = texture2D(uNormalMap, vUv + dUVdx).r;
  float heightY = texture2D(uNormalMap, vUv + dUVdy).r;
  vec3 bumpNormal = normalize(vec3(
    (height - heightX) * 7.0,
    (height - heightY) * 7.0,
    1.0
  ));
  vec3 N = normalize(TBN * bumpNormal);

  vec3 sunDir  = normalize(uSunDirection);
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  float NdotL  = dot(N, sunDir);
  float geomNdotL = dot(geomN, sunDir);
  float NdotV = max(dot(N, viewDir), 0.0);
  float horizon = pow(1.0 - max(dot(geomN, viewDir), 0.0), 2.3);

  float dayBlend = smoothstep(-0.22, 0.18, geomNdotL);
  float lambert = max(NdotL, 0.0);
  float twilight = smoothstep(-0.18, 0.04, geomNdotL) * (1.0 - smoothstep(0.04, 0.28, geomNdotL));

  vec3 dayColor   = texture2D(uDayMap,   vUv).rgb;
  vec3 nightColor = texture2D(uNightMap, vUv).rgb;
  float specMask = texture2D(uSpecularMap, vUv).r;

  vec3 ambient = dayColor * vec3(0.07, 0.09, 0.13);
  vec3 litDay = dayColor * (0.18 + 0.82 * lambert) + ambient;
  litDay += dayColor * vec3(0.18, 0.08, 0.03) * twilight;

  vec3 limbColor = mix(vec3(1.0, 0.60, 0.24), vec3(0.40, 0.70, 1.0), smoothstep(-0.05, 0.25, geomNdotL));
  litDay += limbColor * horizon * smoothstep(-0.18, 0.30, geomNdotL) * 0.22;

  float cityBlend = 1.0 - smoothstep(-0.14, 0.06, geomNdotL);
  vec3 cityLights = nightColor * cityBlend * (2.0 + 0.5 * horizon);
  vec3 color = mix(cityLights, litDay, dayBlend);

  vec3 halfDir = normalize(sunDir + viewDir);
  float specular = pow(max(dot(N, halfDir), 0.0), mix(34.0, 110.0, specMask));
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 specularColor = mix(vec3(0.30, 0.42, 0.58), vec3(0.95, 0.98, 1.0), fresnel);
  color += specularColor * specular * specMask * lambert * (0.35 + 1.7 * fresnel);

  vec3 hazeColor = mix(vec3(1.0, 0.72, 0.42), vec3(0.56, 0.76, 1.0), smoothstep(-0.06, 0.24, geomNdotL));
  float hazeBase = 0.08 * smoothstep(-0.18, 0.30, geomNdotL);
  float hazeLimb = pow(horizon, 0.85) * smoothstep(-0.12, 0.32, geomNdotL);
  float haze = hazeBase + hazeLimb * 0.34;
  color = mix(color, hazeColor, haze);
  color += hazeColor * (hazeBase * 0.03 + hazeLimb * 0.08);

  color += vec3(0.02, 0.05, 0.10) * dayBlend;

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

  float nightFade = smoothstep(-0.15, 0.10, NdotL);
  float lit = max(NdotL, 0.0);

  vec3 shadowColor = vec3(0.58, 0.63, 0.80);
  vec3 cloudColor  = mix(shadowColor, vec3(1.0), smoothstep(-0.10, 0.25, NdotL));

  float termFrac  = smoothstep(-0.12, 0.0, NdotL) * (1.0 - smoothstep(0.0, 0.32, NdotL));
  cloudColor      = mix(cloudColor, vec3(1.0, 0.70, 0.38), termFrac * 0.65);

  cloudColor *= lit * 0.85 + 0.15;

  gl_FragColor = vec4(cloudColor, cloudAlpha * nightFade);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Raymarched atmosphere
// ─────────────────────────────────────────────────────────────────────────────
const ATM_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos  = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const ATM_FRAG = /* glsl */ `
uniform vec3  uSunDirection;
uniform vec3  uCameraPos;
uniform float uInnerRadius;
uniform float uOuterRadius;
uniform float uStrength;

varying vec3 vWorldPos;

vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float sq = sqrt(disc);
  return vec2(-b - sq, -b + sq);
}

void main() {
  vec3 rayOrigin = uCameraPos;
  vec3 rayDir    = normalize(vWorldPos - uCameraPos);
  vec3 sunDir    = normalize(uSunDirection);

  vec2 outerHit = raySphere(rayOrigin, rayDir, uOuterRadius);
  if (outerHit.y < 0.0) discard;

  vec2 innerHit = raySphere(rayOrigin, rayDir, uInnerRadius);
  bool hitsGround = innerHit.x > 0.0;

  float tStart = max(0.0, outerHit.x);
  float tEnd   = outerHit.y;
  if (hitsGround) {
    tEnd = innerHit.x;
  }
  if (tStart >= tEnd) discard;

  const int STEPS = ${ATM_RAY_STEPS};
  float stepSize  = (tEnd - tStart) / float(STEPS);
  float thickness = uOuterRadius - uInnerRadius;

  vec3  weightedColor = vec3(0.0);
  float totalDensity  = 0.0;

  for (int i = 0; i < STEPS; i++) {
    float t = tStart + (float(i) + 0.5) * stepSize;
    vec3  samplePos = rayOrigin + rayDir * t;
    float altitude  = length(samplePos);

    float h = clamp((altitude - uInnerRadius) / thickness, 0.0, 1.0);
    float density = exp(-h * 3.8);

    vec3 sampleDir = samplePos / altitude;
    float sunAngle = dot(sampleDir, sunDir);

    vec3 dayColor      = vec3(0.25, 0.55, 1.00);
    vec3 twilightColor = vec3(0.80, 0.30, 0.06);
    vec3 nightColor    = vec3(0.03, 0.04, 0.14);

    vec3 color;
    if (sunAngle > 0.15) {
      color = dayColor;
    } else if (sunAngle > -0.15) {
      float tw = (sunAngle + 0.15) / 0.30;
      color = mix(twilightColor, dayColor, tw);
    } else {
      float tw = smoothstep(-0.5, -0.15, sunAngle);
      color = mix(nightColor, twilightColor, tw);
    }

    float dayFactor = smoothstep(-0.40, 0.10, sunAngle);
    float localWeight = density * mix(0.06, 0.55, dayFactor);

    weightedColor += color * localWeight;
    totalDensity  += density;
  }

  float tau = totalDensity * stepSize;
  float scatter = 1.0 - exp(-tau * uStrength);

  vec3 avgColor = (totalDensity > 0.001)
    ? weightedColor / totalDensity
    : vec3(0.0);

  vec3 luminance = avgColor * scatter;

  if (hitsGround) {
    vec3 hitPos = rayOrigin + rayDir * innerHit.x;
    vec3 hitNormal = normalize(hitPos);
    float viewDot = abs(dot(hitNormal, rayDir));
    float limbFade = pow(1.0 - viewDot, 3.0);
    luminance *= limbFade;
  }

  gl_FragColor = vec4(luminance, scatter);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────
function makePixel(r: number, g: number, b: number, a = 255): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// FallbackEarthSurface
// ─────────────────────────────────────────────────────────────────────────────
export class FallbackEarthSurface {
  private readonly _earthMesh: THREE.Mesh;
  private readonly _cloudMesh: THREE.Mesh;
  private readonly _atmosphereMesh: THREE.Mesh;

  private readonly _earthMat: THREE.ShaderMaterial;
  private readonly _cloudMat: THREE.ShaderMaterial;
  private readonly _atmosphereMat: THREE.ShaderMaterial;

  /** Scratch vector for atmosphere camera-position uniform. */
  private readonly _atmosphereCameraPos = new THREE.Vector3();

  constructor(earthGroup: THREE.Group, maxAnisotropy: number, camera: THREE.Camera) {
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
    this._atmosphereCameraPos.copy(initCamPos);

    // ── Earth surface ─────────────────────────────────────────────────────────
    this._earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDayMap:      { value: makePixel(80, 120, 180) },
        uNightMap:    { value: makePixel(0, 0, 0) },
        uNormalMap:   { value: makePixel(128, 128, 255) },
        uSpecularMap: { value: makePixel(0, 0, 0) },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uCameraPos:   { value: initCamPos.clone() },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    });

    load('/textures/earth-diffuse-8k.jpg', THREE.SRGBColorSpace,
      (t) => { this._earthMat.uniforms.uDayMap.value = t; });
    load('/textures/earth-night-4k.jpg', THREE.SRGBColorSpace,
      (t) => { this._earthMat.uniforms.uNightMap.value = t; });
    load('/textures/earth-bump-4k.jpg', THREE.LinearSRGBColorSpace,
      (t) => { this._earthMat.uniforms.uNormalMap.value = t; });
    load('/textures/earth-specular-4k.jpg', THREE.LinearSRGBColorSpace,
      (t) => { this._earthMat.uniforms.uSpecularMap.value = t; });

    this._earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 128, 64), this._earthMat);
    earthGroup.add(this._earthMesh);

    // ── Cloud layer ───────────────────────────────────────────────────────────
    this._cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uCloudMap:    { value: makePixel(255, 255, 255, 0) },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });

    load('/textures/earth-clouds-4k.png', THREE.LinearSRGBColorSpace,
      (t) => { this._cloudMat.uniforms.uCloudMap.value = t; });

    this._cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.004, 64, 32), this._cloudMat);
    earthGroup.add(this._cloudMesh);

    // ── Atmosphere — single raymarched shell ──────────────────────────────────
    const ATM_GEOM_RADIUS = 1.25;
    this._atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uCameraPos:    { value: this._atmosphereCameraPos },
        uInnerRadius:  { value: ATM_INNER_RADIUS },
        uOuterRadius:  { value: ATM_OUTER_RADIUS },
        uStrength:     { value: 3.2 },
      },
      vertexShader: ATM_VERT,
      fragmentShader: ATM_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    this._atmosphereMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ATM_GEOM_RADIUS, 64, 32),
      this._atmosphereMat,
    );
    earthGroup.add(this._atmosphereMesh);
  }

  /** Sync uniforms and drift the cloud mesh. Called every frame by EarthGroupManager. */
  update(sunDirection: THREE.Vector3, camera: THREE.Camera, delta: number): void {
    this._earthMat.uniforms.uSunDirection.value.copy(sunDirection);
    this._earthMat.uniforms.uCameraPos.value.copy(camera.position);

    this._cloudMat.uniforms.uSunDirection.value.copy(sunDirection);

    // Atmosphere uses a shared-reference Vector3 for camera pos (mutated in place),
    // but sun direction is a separate Vector3 that must be copied explicitly.
    this._atmosphereMat.uniforms.uSunDirection.value.copy(sunDirection);
    this._atmosphereCameraPos.copy(camera.position);

    this._cloudMesh.rotation.y += 0.0001 * delta;
  }

  /** Hide the Earth surface sphere (called when TileEarthSurface is live). */
  hideSurface(): void { this._earthMesh.visible = false; }

  /** Hide the cloud mesh (called when CloudsModule is live). */
  hideClouds(): void { this._cloudMesh.visible = false; }

  /** Hide the atmosphere shell (called when AtmosphereModule is live). */
  hideAtmosphere(): void { this._atmosphereMesh.visible = false; }

  dispose(): void {
    this._earthMesh.geometry.dispose();
    this._earthMat.dispose();
    this._cloudMesh.geometry.dispose();
    this._cloudMat.dispose();
    this._atmosphereMesh.geometry.dispose();
    this._atmosphereMat.dispose();
  }
}
