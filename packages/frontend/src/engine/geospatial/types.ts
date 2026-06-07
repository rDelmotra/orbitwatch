import type * as THREE from 'three';
import type { Effect } from 'postprocessing';
import type { PrecomputedTextures } from '@takram/three-atmosphere';

export interface GeospatialModule {
  readonly name: string;
  readonly ready: boolean;
  readonly failed: boolean;
  init(ctx: GeospatialContext): Promise<void>;
  update(frame: FrameState): void;
  dispose(): void;
  /**
   * Post-processing effects this module contributes to the RenderPipeline. Collected by
   * EarthGroupManager only while the module is ready. Ownership of returned effects passes to
   * the pipeline's EffectPass (it disposes them); modules keep ownership of their input textures.
   */
  getEffects?(): Effect[];
}

/** Subset of FallbackEarthSurface a module uses to hand off a layer once it takes over. */
export interface FallbackControls {
  hideSurface(): void;
  hideClouds(): void;
  hideAtmosphere(): void;
}

export interface GeospatialContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  earthGroup: THREE.Group;
  maxAnisotropy: number;
  /** Lets a module hide the matching fallback mesh when it successfully takes over. */
  fallback: FallbackControls;
  /**
   * True when the post-processing pipeline (EffectComposer) is active. Modules that render via
   * a post-process effect must only hide their fallback when this is true — otherwise the effect
   * would have nowhere to render and the layer would vanish.
   */
  postProcessingAvailable: boolean;
  /**
   * Bruneton precomputed scattering LUTs, loaded ONCE by EarthGroupManager and shared by the
   * atmosphere and clouds modules (both need them). `null` if the load failed → those modules skip
   * and the fallback shells remain. The manager owns these textures and disposes them.
   */
  atmosphereTextures: PrecomputedTextures | null;
}

export interface FrameState {
  date: Date;
  delta: number;
  gastRadians: number;
  sunDirectionECI: THREE.Vector3;
  sunDirectionECEF: THREE.Vector3;
  /** Moon direction in ECEF frame, unit vector. Currently unused (zero) — reserved for a future
   *  moonlit-clouds pass; populate from the scene frame (not astronomy-engine) to stay aligned. */
  moonDirectionECEF: THREE.Vector3;
  /** Camera position in ECEF frame, meters */
  cameraPositionECEF: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
}
