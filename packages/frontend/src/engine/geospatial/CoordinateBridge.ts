import * as THREE from 'three';
import { ER_TO_METERS } from './constants';

/**
 * Converts between the ECI scene frame and ECEF frame each render tick.
 *
 * Scene convention: ECI, Y-up, 1 unit = 1 Earth radius.
 * ECEF: co-rotates with Earth; obtained by applying inverse GAST rotation.
 * Positions handed to Takram APIs must be in ECEF meters.
 */
export class CoordinateBridge {
  private readonly _gastMatrix = new THREE.Matrix4();
  private readonly _inverseGastMatrix = new THREE.Matrix4();

  /** Call once per frame before cameraToECEFMeters / sunDirToECEF. */
  updateGAST(radians: number): void {
    this._gastMatrix.makeRotationY(radians);
    this._inverseGastMatrix.copy(this._gastMatrix).invert();
  }

  /**
   * Converts camera world position (ECI, earth radii) to ECEF meters.
   * Writes result into `out` and returns it.
   */
  cameraToECEFMeters(worldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(worldPos)
      .applyMatrix4(this._inverseGastMatrix)
      .multiplyScalar(ER_TO_METERS);
  }

  /**
   * Rotates an ECI unit sun direction into ECEF.
   * Writes result into `out` and returns it (still unit length).
   */
  sunDirToECEF(eciSunDir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(eciSunDir).applyMatrix4(this._inverseGastMatrix).normalize();
  }
}
