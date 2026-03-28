import * as THREE from 'three';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export const HOME_POSITION = new THREE.Vector3(0, 1.5, 3.5);
export const HOME_TARGET = new THREE.Vector3(0, 0, 0);

interface AnimState {
  startTime: number;
  duration: number;
  startCamPos: THREE.Vector3;
  startTarget: THREE.Vector3;
}

/**
 * Handles cinematic camera animations (fly-to-satellite, return-to-home)
 * and continuous satellite tracking (follow mode).
 *
 * Does NOT own or modify OrbitControls — the Engine manages controls.enabled
 * and decides when to call controls.update().
 */
export class CameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private anim: AnimState | null = null;

  /** Radial offset distance for follow mode. Computed by flyTo(). */
  followOffsetDist = 0.15;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Start a fly-to-satellite animation (2 s). */
  flyTo(satPos: THREE.Vector3, currentTarget: THREE.Vector3): void {
    const altitude = satPos.length() - 1.0;
    this.followOffsetDist = Math.min(Math.max(altitude * 0.3 + 0.05, 0.06), 2.0);
    this.anim = {
      startTime: performance.now(),
      duration: 2000,
      startCamPos: this.camera.position.clone(),
      startTarget: currentTarget.clone(),
    };
  }

  /** Start a smooth return-to-home animation (1.5 s). */
  returnToHome(currentTarget: THREE.Vector3): void {
    this.anim = {
      startTime: performance.now(),
      duration: 1500,
      startCamPos: this.camera.position.clone(),
      startTarget: currentTarget.clone(),
    };
  }

  /**
   * Advance the current animation one frame.
   * Sets camera.position, writes the interpolated look-at target to `outTarget`,
   * and calls camera.lookAt.
   * @returns true when the animation has finished.
   */
  updateAnim(endCamPos: THREE.Vector3, endTarget: THREE.Vector3, outTarget: THREE.Vector3): boolean {
    if (!this.anim) return true;

    const t = Math.min((performance.now() - this.anim.startTime) / this.anim.duration, 1.0);
    const ease = easeInOutCubic(t);

    this.camera.position.lerpVectors(this.anim.startCamPos, endCamPos, ease);
    outTarget.lerpVectors(this.anim.startTarget, endTarget, ease);
    this.camera.lookAt(outTarget);

    if (t >= 1.0) {
      this.anim = null;
      return true;
    }
    return false;
  }

  /**
   * Follow a satellite. Camera stays radially above (away from Earth center).
   * Writes the satellite position to `outTarget` for OrbitControls sync.
   */
  updateFollow(satPos: THREE.Vector3, outTarget: THREE.Vector3): void {
    const radialDir = satPos.clone().normalize();
    this.camera.position.copy(satPos).add(radialDir.multiplyScalar(this.followOffsetDist));
    outTarget.copy(satPos);
    this.camera.lookAt(satPos);
  }

  /** Cancel any active animation. */
  cancel(): void {
    this.anim = null;
  }
}
