/**
 * AtmosphereModule — Bruneton precomputed atmospheric scattering (Takram), rendered as a
 * screen-space post-process (AerialPerspectiveEffect) that adds the atmosphere limb, sky,
 * aerial-perspective haze and the sun/moon disks. This is the single biggest realism lever for
 * the ISS / astronaut-POV look.
 *
 * Coordinate/scale bridge (the crux):
 *   Our scene is ECI, Y-up, 1 unit = 1 Earth radius. Takram works in ECEF metres. The effect
 *   reconstructs world positions from depth and transforms them with `worldToECEFMatrix`, so we
 *   feed it  M = Scale(s) · RotY(-GAST)  where:
 *     - RotY(-GAST) rotates ECI → ECEF (same convention as CoordinateBridge), and
 *     - s = atmosphere.bottomRadius (metres), so our radius-1 Earth sphere maps EXACTLY onto the
 *       Bruneton atmosphere ground (avoids a gap/overlap between surface and atmosphere base).
 *   The ellipsoid is made spherical at the same radius, so altitude correction is a no-op.
 *
 * Failsafe: the shared Bruneton LUTs are fetched over the network by EarthGroupManager; if they're
 * unavailable (or effect creation fails) the module stays not-ready and the fallback raymarched
 * atmosphere remains visible.
 *
 * Ownership: the AerialPerspectiveEffect is owned by the RenderPipeline's EffectPass (disposed
 * there). The LUT textures are owned by EarthGroupManager (shared with the clouds module) — this
 * module only consumes them via `ctx.atmosphereTextures`.
 */
import * as THREE from 'three';
import {
  AerialPerspectiveEffect,
  AtmosphereParameters,
} from '@takram/three-atmosphere';
import { Ellipsoid } from '@takram/three-geospatial';
import type { Effect } from 'postprocessing';
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class AtmosphereModule implements GeospatialModule {
  readonly name = 'atmosphere';

  private _ready = false;
  private _failed = false;
  private _effect: AerialPerspectiveEffect | null = null;

  /** Metres-per-Earth-radius used for this module: the Bruneton ground radius. */
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
        // LUTs failed to load (EarthGroupManager already warned) — stay on the fallback atmosphere.
        this._failed = true;
        return;
      }

      const atmosphere = AtmosphereParameters.DEFAULT;
      // Map scene radius 1.0 onto the atmosphere's ground radius so the surface and atmosphere
      // base coincide. (Bruneton default ≈ 6,360,000 m; our ER is 6,371,000 m — the ~0.17%
      // difference in satellite altitudes is negligible for scattering.)
      this._scale = atmosphere.bottomRadius;

      const r = this._scale;
      this._effect = new AerialPerspectiveEffect(ctx.camera, {
        ...textures,
        ellipsoid: new Ellipsoid(r, r, r),
        correctAltitude: false,
        // MERGE strategy: the fallback Earth shader keeps owning the surface (its day/night +
        // sunset rim that the user prefers). Takram contributes ONLY the sky + limb glow + sun
        // disk behind/around the Earth. So:
        //   ground:false  — do NOT re-light/haze the surface (avoids a second, doubled night side)
        //   sky:true      — render the atmosphere limb and sky against space
        //   moon:false    — skip the moon disk (its ECEF frame would be misplaced like the sun was)
        sky: true,
        sun: true,
        moon: false,
        ground: false,
      });

      // Takram atmosphere now owns the look — retire the fallback raymarched shell, but only if
      // there's a pipeline to actually render the effect into.
      if (ctx.postProcessingAvailable) {
        ctx.fallback.hideAtmosphere();
      }
      this._ready = true;
    } catch (err) {
      this._failed = true;
      console.warn('[geospatial] atmosphere init failed; keeping fallback atmosphere:', err);
    }
  }

  update(frame: FrameState): void {
    if (!this._effect) return;

    // world(ECI, ER) → ECEF(metres):  M = Scale(s) · RotY(-GAST)
    const s = this._scale;
    this._worldToECEF
      .makeScale(s, s, s)
      .multiply(this._rot.makeRotationY(-frame.gastRadians));
    this._effect.worldToECEFMatrix.copy(this._worldToECEF);

    // Sun comes from the CoordinateBridge (scene sun rotated by our GAST) — the SAME source that
    // lights the fallback Earth, so the atmosphere limb and the surface terminator stay aligned.
    this._effect.sunDirection.copy(frame.sunDirectionECEF);
  }

  getEffects(): Effect[] {
    return this._effect ? [this._effect] : [];
  }

  dispose(): void {
    // The effect itself is disposed by the RenderPipeline's EffectPass; the LUTs are owned and
    // disposed by EarthGroupManager (shared with the clouds module), so nothing to release here.
    this._effect = null;
  }
}
