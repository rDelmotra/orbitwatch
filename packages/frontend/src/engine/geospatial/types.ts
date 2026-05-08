import type * as THREE from 'three';

export interface GeospatialModule {
  readonly name: string;
  readonly ready: boolean;
  readonly failed: boolean;
  init(ctx: GeospatialContext): Promise<void>;
  update(frame: FrameState): void;
  dispose(): void;
}

export interface GeospatialContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  earthGroup: THREE.Group;
  maxAnisotropy: number;
}

export interface FrameState {
  date: Date;
  delta: number;
  gastRadians: number;
  sunDirectionECI: THREE.Vector3;
  sunDirectionECEF: THREE.Vector3;
  /** Camera position in ECEF frame, meters */
  cameraPositionECEF: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
}
