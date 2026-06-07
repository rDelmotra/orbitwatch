/**
 * CloudsModule — Takram volumetric (raymarched) clouds, rendered as a screen-space post-process
 * (`CloudsEffect`) in the same EffectPass as the atmosphere, BEFORE the aerial-perspective effect so
 * the atmosphere composites over the clouds. This is the second big astronaut-POV realism lever.
 *
 * Depth: `CloudsEffect` needs the scene depth to composite clouds against the surface/satellites.
 * pmndrs propagates the pass depth texture to every effect in a pass when ANY effect in that pass
 * declares the DEPTH attribute — the co-located `AtmosphereModule` (AerialPerspectiveEffect) does,
 * so clouds get depth for free. (If the atmosphere is ever disabled, revisit explicit depth wiring.)
 *
 * Coordinate/scale bridge: identical to AtmosphereModule — per frame we set
 *   worldToECEFMatrix = Scale(bottomRadius) · RotY(-GAST)
 * mapping our radius-1 ECI scene onto Bruneton ECEF metres, and the sun from `frame.sunDirectionECEF`
 * (the same source that lights the surface, so cloud lighting and the terminator stay aligned).
 *
 * Step 5A stands the effect up with PROCEDURAL coverage (`LocalWeather`); Step 5B swaps in a live
 * GIBS cloud-fraction texture for `localWeatherTexture`. Shape/detail/turbulence are procedural; the
 * STBN (blue-noise) texture is loaded from the Takram-hosted asset.
 *
 * Failsafe: needs the shared Bruneton LUTs (`ctx.atmosphereTextures`); if absent or anything throws,
 * the module stays not-ready and the fallback cloud shell remains. Ownership: the effect is disposed
 * by the RenderPipeline's EffectPass; this module owns the noise/STBN textures it creates, and the
 * LUTs are owned by EarthGroupManager.
 */
import * as THREE from 'three';
import {
  CloudsEffect,
  CloudShape,
  CloudShapeDetail,
  Turbulence,
  LocalWeather,
} from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import { STBNLoader, DEFAULT_STBN_URL } from '@takram/three-geospatial';
import type { Effect } from 'postprocessing';
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

// ── Perf / look tuning (see Takram perf table — start conservative, raise once validated) ──────────
/** 'low' | 'medium' | 'high' | 'ultra'. Medium disables light shafts + turbulence for cost. */
const CLOUDS_QUALITY_PRESET = 'medium' as const;
/** Render clouds at this fraction of canvas res, upscaled (TAA). 0.5 ≈ 4× fewer rays. */
const CLOUDS_RESOLUTION_SCALE = 0.5;
/** Global coverage multiplier (with live data this scales the GIBS coverage). */
const CLOUDS_COVERAGE = 0.3;

export class CloudsModule implements GeospatialModule {
  readonly name = 'clouds';

  private _ready = false;
  private _failed = false;
  private _effect: CloudsEffect | null = null;

  // Owned procedural/noise textures (disposed here).
  private _shape: CloudShape | null = null;
  private _shapeDetail: CloudShapeDetail | null = null;
  private _turbulence: Turbulence | null = null;
  private _localWeather: LocalWeather | null = null;
  private _stbn: THREE.Data3DTexture | null = null;

  private _scale = 1;
  private readonly _worldToECEF = new THREE.Matrix4();
  private readonly _rot = new THREE.Matrix4();

  get ready(): boolean {
    return this._ready;
  }

  get failed(): boolean {
    return this._failed;
  }

  async init(ctx: GeospatialContext): Promise<void> {
    try {
      const textures = ctx.atmosphereTextures;
      if (!textures) {
        // Shared LUTs unavailable (manager already warned) — stay on the fallback cloud shell.
        this._failed = true;
        return;
      }

      const atmosphere = AtmosphereParameters.DEFAULT;
      this._scale = atmosphere.bottomRadius;

      // Blue-noise (STBN) for temporal ray-march dithering — hosted asset, like the LUTs.
      const stbnLoader = new STBNLoader();
      this._stbn = await new Promise<THREE.Data3DTexture>((resolve, reject) => {
        stbnLoader.load(DEFAULT_STBN_URL, resolve, undefined, reject);
      });

      const effect = new CloudsEffect(ctx.camera, undefined, atmosphere);

      // Procedural noise (the effect renders these internally; coverage swapped for live data in 5B).
      this._shape = new CloudShape();
      this._shapeDetail = new CloudShapeDetail();
      this._turbulence = new Turbulence();
      this._localWeather = new LocalWeather();
      effect.shapeTexture = this._shape;
      effect.shapeDetailTexture = this._shapeDetail;
      effect.turbulenceTexture = this._turbulence;
      effect.localWeatherTexture = this._localWeather;
      effect.stbnTexture = this._stbn;

      // Share the Bruneton LUTs the atmosphere already loaded.
      effect.irradianceTexture = textures.irradianceTexture;
      effect.scatteringTexture = textures.scatteringTexture;
      effect.transmittanceTexture = textures.transmittanceTexture;
      if (textures.singleMieScatteringTexture) {
        effect.singleMieScatteringTexture = textures.singleMieScatteringTexture;
      }

      // Spherical ellipsoid at the same radius as the atmosphere/surface → altitude correction is a
      // no-op (we feed an exact world→ECEF matrix each frame).
      effect.correctAltitude = false;
      effect.qualityPreset = CLOUDS_QUALITY_PRESET;
      effect.resolutionScale = CLOUDS_RESOLUTION_SCALE;
      effect.temporalUpscale = true;
      effect.lightShafts = false;
      effect.coverage = CLOUDS_COVERAGE;

      this._effect = effect;

      if (ctx.postProcessingAvailable) {
        ctx.fallback.hideClouds();
      }
      this._ready = true;
    } catch (err) {
      this._failed = true;
      console.warn('[geospatial] clouds init failed; keeping fallback cloud shell:', err);
    }
  }

  update(frame: FrameState): void {
    if (!this._effect) return;

    // world(ECI, ER) → ECEF(metres):  M = Scale(s) · RotY(-GAST)  (same as the atmosphere).
    const s = this._scale;
    this._worldToECEF
      .makeScale(s, s, s)
      .multiply(this._rot.makeRotationY(-frame.gastRadians));
    this._effect.worldToECEFMatrix.copy(this._worldToECEF);
    this._effect.sunDirection.copy(frame.sunDirectionECEF);
  }

  getEffects(): Effect[] {
    return this._effect ? [this._effect] : [];
  }

  dispose(): void {
    // The effect is disposed by the RenderPipeline's EffectPass; the LUTs by EarthGroupManager.
    // We own the procedural/STBN textures created here.
    this._shape?.dispose();
    this._shapeDetail?.dispose();
    this._turbulence?.dispose();
    this._localWeather?.dispose();
    this._stbn?.dispose();
    this._shape = null;
    this._shapeDetail = null;
    this._turbulence = null;
    this._localWeather = null;
    this._stbn = null;
    this._effect = null;
  }
}
