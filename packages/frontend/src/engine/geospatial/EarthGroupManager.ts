/**
 * EarthGroupManager — drop-in replacement for EarthRenderer.
 *
 * Exposes the same public interface Engine.ts already uses:
 *   - readonly object: THREE.Group     (add to scene once; GAST set via object.rotation.y)
 *   - readonly sunDirection: THREE.Vector3  (Engine writes every frame via .copy())
 *   - update(delta, camera)
 *   - dispose()
 *
 * Internally it owns:
 *   - FallbackEarthSurface  — always present, hides meshes as Takram modules come online
 *   - CoordinateBridge      — ECI ↔ ECEF conversion for post-processing effects
 *   - GeospatialModule[]    — Takram modules (populated in later steps via initModules)
 *
 * Engine.ts calls initModules() as a fire-and-forget async; the app renders with
 * fallback visuals while modules init, swapping to Takram visuals on success.
 */
import * as THREE from 'three';
import type { Effect } from 'postprocessing';
import {
  PrecomputedTexturesLoader,
  DEFAULT_PRECOMPUTED_TEXTURES_URL,
  type PrecomputedTextures,
} from '@takram/three-atmosphere';
import { FallbackEarthSurface } from './FallbackEarthSurface';
import { CoordinateBridge } from './CoordinateBridge';
import { AtmosphereModule } from './AtmosphereModule';
import { CloudsModule } from './CloudsModule';
import { TileEarthSurface } from './TileEarthSurface';
import type { GeospatialModule, FrameState } from './types';
import { simClock } from '../SimClock';

/**
 * Takram atmosphere (Bruneton aerial-perspective post-process). It reconstructs world positions
 * from the depth buffer; its `sky` pass repaints every pixel that has NO geometry depth. That was
 * eating the space overlays (satellites/DSO) because they rendered with `depthWrite:false` — so
 * those renderers now write depth (see SatelliteRenderer/DsoRenderer), marking them as geometry the
 * sky pass leaves alone. With that fixed the atmosphere is on: it applies aerial-perspective haze to
 * the tile surface (softens the day side toward the limb) and adds the blue limb + sky + sun disk —
 * the core astronaut-POV realism. Set false to fall back to the bare tiles + fallback shells.
 */
const ENABLE_TAKRAM_ATMOSPHERE = true;

/**
 * Takram volumetric clouds (raymarched, depth-reading post-process). Driven by live GIBS coverage
 * (Step 5B) over procedural shape; renders BEFORE the atmosphere so aerial-perspective composites
 * over the clouds. Shares the Bruneton LUTs loaded once below. Failsafe: any failure leaves the
 * fallback cloud shell visible. Set false to disable.
 *
 * Dedicated-DepthPass attempt (RenderPipeline) did NOT resolve it: the glBlitFramebuffer depth error
 * persists, the clouds still don't render, and the DepthPass scene re-render tanks mid-range FPS to
 * ~25. The CloudsEffect raymarch runs (costs GPU) but produces no visible output — a deeper Takram
 * "from space" setup issue beyond the blit. Parked again pending a decision: debug volumetric
 * interactively, or pivot to the live 2D cloud shell. The DepthPass auto-disables when this is false,
 * so the perf cost + error both go away.
 */
const ENABLE_TAKRAM_CLOUDS = false;

export class EarthGroupManager {
  /** The scene object — identical role to old EarthRenderer.object. */
  readonly object: THREE.Group;

  /**
   * Engine writes here every frame via `sunDirection.copy(getSunDirection(now))`.
   * EarthGroupManager propagates it to the fallback and to Takram modules.
   */
  readonly sunDirection: THREE.Vector3 = new THREE.Vector3(1, 0, 0);

  private readonly _fallback: FallbackEarthSurface;
  private readonly _bridge: CoordinateBridge;
  private readonly _modules: GeospatialModule[] = [];
  /** Modules whose update() threw — permanently skipped so one fault can't kill the render loop. */
  private readonly _erroredModules = new Set<GeospatialModule>();

  // Scratch vectors rebuilt every frame — no per-frame allocations.
  private readonly _sunDirectionECEF = new THREE.Vector3();
  private readonly _moonDirectionECEF = new THREE.Vector3();
  private readonly _cameraPositionECEF = new THREE.Vector3();

  // Stored for GeospatialContext construction in initModules.
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _scene: THREE.Scene;
  private readonly _maxAnisotropy: number;

  /** Bruneton LUTs loaded once and shared by atmosphere + clouds. Manager owns disposal. */
  private _atmosphereTextures: PrecomputedTextures | null = null;

  constructor(
    maxAnisotropy: number,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
  ) {
    this.object = new THREE.Group();
    this._renderer = renderer;
    this._camera = camera;
    this._scene = scene;
    this._maxAnisotropy = maxAnisotropy;

    this._bridge = new CoordinateBridge();
    this._fallback = new FallbackEarthSurface(this.object, maxAnisotropy, camera, renderer);

    // Streaming imagery surface (replaces the fallback sphere when tiles load).
    this._modules.push(new TileEarthSurface());
    // Clouds BEFORE atmosphere: the EffectPass runs effects in module order, and Takram requires the
    // clouds pass to come before aerial-perspective so the atmosphere composites over the clouds.
    if (ENABLE_TAKRAM_CLOUDS) {
      this._modules.push(new CloudsModule());
    }
    // The atmosphere consumes the sun direction the CoordinateBridge derives from the SAME scene
    // sun + GAST that lights the Earth — so the atmosphere and surface terminators stay locked
    // together. (We intentionally do NOT use astronomy-engine's ECEF sun here: its frame is
    // rotated relative to our scene convention, which caused a 90° double-terminator.)
    if (ENABLE_TAKRAM_ATMOSPHERE) {
      this._modules.push(new AtmosphereModule());
    }
  }

  /**
   * Fire-and-forget async called by Engine after scene setup.
   * Each Takram module is wrapped in its own try/catch so one failure
   * doesn't prevent the others from initialising.
   *
   * Steps 6-9 populate this._modules; for now it runs in constant time.
   */
  async initModules(postProcessingAvailable: boolean): Promise<void> {
    // Load the Bruneton precomputed LUTs ONCE here, shared by the atmosphere and clouds modules
    // (both need them). On failure both modules skip via the null guard and the fallback shells
    // remain — it never blocks the surface/tiles.
    if (ENABLE_TAKRAM_ATMOSPHERE || ENABLE_TAKRAM_CLOUDS) {
      try {
        const loader = new PrecomputedTexturesLoader();
        loader.setType(this._renderer);
        this._atmosphereTextures = await new Promise<PrecomputedTextures>((resolve, reject) => {
          loader.load(DEFAULT_PRECOMPUTED_TEXTURES_URL, resolve, undefined, reject);
        });
      } catch (err) {
        console.warn('[geospatial] atmosphere LUT load failed; atmosphere + clouds disabled:', err);
        this._atmosphereTextures = null;
      }
    }

    const ctx = {
      renderer: this._renderer,
      camera: this._camera,
      scene: this._scene,
      earthGroup: this.object,
      maxAnisotropy: this._maxAnisotropy,
      fallback: this._fallback,
      postProcessingAvailable,
      atmosphereTextures: this._atmosphereTextures,
    };

    for (const mod of this._modules) {
      try {
        await mod.init(ctx);
      } catch (err) {
        console.warn(`[geospatial] ${mod.name} init failed:`, err);
      }
    }
  }

  /**
   * Returns post-processing effects from ready modules for RenderPipeline.
   * Populated by Takram modules (atmosphere, clouds) as they come online in later steps.
   */
  getPostProcessEffects(): Effect[] {
    const effects: Effect[] = [];
    for (const mod of this._modules) {
      if (mod.ready && !mod.failed && !this._erroredModules.has(mod) && mod.getEffects) {
        effects.push(...mod.getEffects());
      }
    }
    return effects;
  }

  /** Called every frame by Engine.ts render loop. */
  update(delta: number, camera: THREE.Camera): void {
    // Engine sets object.rotation.y = GAST externally; read it back for the bridge.
    this._bridge.updateGAST(this.object.rotation.y);
    this._bridge.sunDirToECEF(this.sunDirection, this._sunDirectionECEF);
    this._bridge.cameraToECEFMeters(camera.position, this._cameraPositionECEF);

    const frame: FrameState = {
      date: simClock.date(),
      delta,
      gastRadians: this.object.rotation.y,
      sunDirectionECI: this.sunDirection,
      sunDirectionECEF: this._sunDirectionECEF,
      moonDirectionECEF: this._moonDirectionECEF,
      cameraPositionECEF: this._cameraPositionECEF,
      camera: this._camera,
    };

    // Fallback always runs (individual meshes are hidden by modules that succeed).
    this._fallback.update(this.sunDirection, camera, delta);

    // Ready modules update every frame; failed/errored modules are skipped. A throw here must not
    // propagate — otherwise it would abort Engine.loop before the satellites/post render.
    for (const mod of this._modules) {
      if (mod.ready && !mod.failed && !this._erroredModules.has(mod)) {
        try {
          mod.update(frame);
        } catch (err) {
          this._erroredModules.add(mod);
          console.warn(`[geospatial] ${mod.name} update threw; disabling module:`, err);
        }
      }
    }
  }

  dispose(): void {
    this._fallback.dispose();
    for (const mod of this._modules) {
      mod.dispose();
    }
    // Manager owns the shared LUTs (atmosphere + clouds only consumed them).
    this._atmosphereTextures?.transmittanceTexture.dispose();
    this._atmosphereTextures?.scatteringTexture.dispose();
    this._atmosphereTextures?.irradianceTexture.dispose();
    this._atmosphereTextures?.singleMieScatteringTexture?.dispose();
    this._atmosphereTextures?.higherOrderScatteringTexture?.dispose();
    this._atmosphereTextures = null;
  }
}
