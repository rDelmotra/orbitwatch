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
import { FallbackEarthSurface } from './FallbackEarthSurface';
import { CoordinateBridge } from './CoordinateBridge';
import type { GeospatialModule, FrameState } from './types';

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

  // Scratch vectors rebuilt every frame — no per-frame allocations.
  private readonly _sunDirectionECEF = new THREE.Vector3();
  private readonly _cameraPositionECEF = new THREE.Vector3();

  // Stored for GeospatialContext construction in initModules.
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _scene: THREE.Scene;
  private readonly _maxAnisotropy: number;

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
    this._fallback = new FallbackEarthSurface(this.object, maxAnisotropy, camera);
  }

  /**
   * Fire-and-forget async called by Engine after scene setup.
   * Each Takram module is wrapped in its own try/catch so one failure
   * doesn't prevent the others from initialising.
   *
   * Steps 6-9 populate this._modules; for now it runs in constant time.
   */
  async initModules(): Promise<void> {
    const ctx = {
      renderer: this._renderer,
      camera: this._camera,
      scene: this._scene,
      earthGroup: this.object,
      maxAnisotropy: this._maxAnisotropy,
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
   * Typed as object[] until the postprocessing package is installed in Step 4.
   */
  getPostProcessEffects(): object[] {
    return [];
  }

  /** Called every frame by Engine.ts render loop. */
  update(delta: number, camera: THREE.Camera): void {
    // Engine sets object.rotation.y = GAST externally; read it back for the bridge.
    this._bridge.updateGAST(this.object.rotation.y);
    this._bridge.sunDirToECEF(this.sunDirection, this._sunDirectionECEF);
    this._bridge.cameraToECEFMeters(camera.position, this._cameraPositionECEF);

    const frame: FrameState = {
      date: new Date(),
      delta,
      gastRadians: this.object.rotation.y,
      sunDirectionECI: this.sunDirection,
      sunDirectionECEF: this._sunDirectionECEF,
      cameraPositionECEF: this._cameraPositionECEF,
      camera: this._camera,
    };

    // Fallback always runs (individual meshes are hidden by modules that succeed).
    this._fallback.update(this.sunDirection, camera, delta);

    // Ready modules update every frame; failed modules are skipped.
    for (const mod of this._modules) {
      if (mod.ready && !mod.failed) {
        mod.update(frame);
      }
    }
  }

  dispose(): void {
    this._fallback.dispose();
    for (const mod of this._modules) {
      mod.dispose();
    }
  }
}
