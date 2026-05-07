import * as THREE from 'three';
import type { OrbitalRegime } from '../../data/types';
import type { UserBehavior } from '../types';
import type { CameraMode } from '../../store/useStore';

const STATIONARY_THRESHOLD_RAD_PER_SEC = 0.01;

// HOT PATH OPTIMIZATION: pre-allocated scratch vectors — no per-tick allocations.
const _currForward = new THREE.Vector3();
const _diff = new THREE.Vector3();

export class BehaviorTracker {
  private prevForward = new THREE.Vector3(0, 0, -1);
  private stationaryStartMs = 0;
  private wasStationary = false;

  tick(
    camera: THREE.PerspectiveCamera,
    controlsTarget: THREE.Vector3,
    deltaSec: number,
    byRegime: Record<OrbitalRegime, number>,
    cameraMode: CameraMode,
    selectedNoradId: number | null,
    selectedName: string | null,
  ): UserBehavior {
    // Compute current forward direction from camera to controls target
    _diff.subVectors(controlsTarget, camera.position);
    const diffLen = _diff.length();

    if (diffLen > 0.0001) {
      _currForward.copy(_diff).divideScalar(diffLen);
    } else {
      _currForward.copy(this.prevForward);
    }

    // Angular velocity = acos(dot(prev, curr)) / deltaSeconds
    const dot = Math.max(-1, Math.min(1, this.prevForward.dot(_currForward)));
    const angleDelta = Math.acos(dot);
    const angularVelocityRadPerSec = deltaSec > 0 ? angleDelta / deltaSec : 0;

    const now = performance.now();
    let stationaryDurationSec = 0;

    if (angularVelocityRadPerSec < STATIONARY_THRESHOLD_RAD_PER_SEC) {
      if (!this.wasStationary) {
        this.stationaryStartMs = now;
        this.wasStationary = true;
      }
      stationaryDurationSec = (now - this.stationaryStartMs) / 1000;
    } else {
      this.wasStationary = false;
      this.stationaryStartMs = 0;
    }

    // Dominant regime = regime with highest in-view count
    let dominantRegimeInView: OrbitalRegime | null = null;
    let maxCount = 0;
    for (const [regime, count] of Object.entries(byRegime) as [OrbitalRegime, number][]) {
      if (count > maxCount) {
        maxCount = count;
        dominantRegimeInView = regime;
      }
    }
    if (maxCount === 0) dominantRegimeInView = null;

    // Update for next tick
    this.prevForward.copy(_currForward);

    return {
      cameraMode,
      angularVelocityRadPerSec,
      stationaryDurationSec,
      dominantRegimeInView,
      selectedNoradId,
      selectedName,
    };
  }
}
