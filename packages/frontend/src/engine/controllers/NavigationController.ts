import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraController, HOME_POSITION, HOME_TARGET } from '../CameraController';
import { getObserverScenePosition } from '../../orbital/coordinates';
import { simClock } from '../SimClock';
import { useStore, type TrackingStyle } from '../../store/useStore';
import type { TrackingSource } from './TrackingSource';

const VISUAL_CAMERA_EYE_HEIGHT_ER = 0.0000025;
const VISUAL_CAMERA_LOOK_AHEAD_ER = 1.6;

interface NavigationCallbacks {
  /** Tell the input layer to drop any in-progress joyride free-look state. */
  onCancelJoyrideLook: () => void;
}

/**
 * Owns the camera state machine (free / flying / following / returning) plus the
 * select / fly-to / joyride / reset / observer-sky behaviours that drive it.
 *
 * Reads per-frame object positions/velocities through a {@link TrackingSource} so it
 * never imports the renderers or worker clients. Registers exactly one store
 * subscription (camera-mode transitions); the per-frame `update()` only reads
 * `useStore.getState()` snapshots.
 */
export class NavigationController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly source: TrackingSource;
  private readonly callbacks: NavigationCallbacks;
  private readonly cameraController: CameraController;

  private arrivalTime = -1; // performance.now() when camera arrived; -1 = none
  private returnEndPos: THREE.Vector3 | null = null;
  private returnEndTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private useHardReset = false;
  private dragExitedFollowingFromInput = false;
  private cameraModeUnsub: (() => void) | null = null;

  private readonly trackingRadialDir = new THREE.Vector3();
  private readonly trackingEndCamPos = new THREE.Vector3();
  private readonly joyrideEntryTarget = new THREE.Vector3();
  private readonly trackingVelocity = new THREE.Vector3();
  private readonly trackingPos = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    source: TrackingSource,
    callbacks: NavigationCallbacks,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.source = source;
    this.callbacks = callbacks;
    this.cameraController = new CameraController(camera);

    // Centralized camera mode transitions
    let prevCameraMode = useStore.getState().cameraMode;
    this.cameraModeUnsub = useStore.subscribe((state) => {
      if (state.cameraMode === prevCameraMode) return;
      prevCameraMode = state.cameraMode;

      // Any transition to 'free': cancel animation, re-enable controls
      if (state.cameraMode === 'free') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = true;
        this.callbacks.onCancelJoyrideLook();
        this.arrivalTime = -1;

        if (this.dragExitedFollowingFromInput) {
          this.dragExitedFollowingFromInput = false;
        } else if (this.returnEndPos) {
          this.controls.target.set(0, 0, 0);
          this.returnEndPos = null;
        }
      }

      // Entering 'returning': disable controls and start return animation
      if (state.cameraMode === 'returning') {
        this.cameraController.cancel();
        this.cameraController.resetJoyrideState();
        this.controls.enabled = false;
        this.callbacks.onCancelJoyrideLook();
        this.arrivalTime = -1;

        this.cameraController.returnToHome(this.controls.target);

        if (this.useHardReset) {
          this.returnEndPos = HOME_POSITION.clone();
          this.returnEndTarget.copy(HOME_TARGET);
          this.useHardReset = false;
        } else {
          const dir = this.camera.position.clone().normalize();
          const currentDistance = this.camera.position.length();
          const targetDist = Math.max(currentDistance, HOME_POSITION.length());
          this.returnEndPos = dir.multiplyScalar(targetDist);
          this.returnEndTarget.set(0, 0, 0);
        }
      }

      if (state.cameraMode === 'flying') {
        this.controls.enabled = false;
      }

      if (state.cameraMode === 'following') {
        this.controls.enabled = false;
      }
    });
  }

  /** performance.now() when the camera last arrived at a target; -1 = none. */
  getArrivalTime(): number {
    return this.arrivalTime;
  }

  /** Forward a joyride free-look delta into the camera animation helper. */
  addJoyrideLookInput(deltaYawRad: number, deltaPitchRad: number): void {
    this.cameraController.addJoyrideLookInput(deltaYawRad, deltaPitchRad);
  }

  /** Input layer reports a drag that should exit follow without snapping the target. */
  notifyDragExitedFollowing(): void {
    this.dragExitedFollowingFromInput = true;
  }

  /** Per-frame camera update. `uT` is the GPU-side interpolation factor for TLE positions. */
  update(uT: number): void {
    const store = useStore.getState();
    const cameraMode = store.cameraMode;
    const trackingStyle = store.trackingStyle;
    const selectedIdx = store.selectedIndex;
    const selectedDso = store.selectedDso;

    if (cameraMode === 'free') {
      // Observer sky camera (visual mode): keep camera pinned to geolocation
      // and facing up, so the view remains correct as Earth rotates.
      if (store.visibilityMode === 'visual' && store.observerLocation) {
        const { observerWorldPos, upDir } = this.getObserverSkyAnchor(store.observerLocation);
        const camPos = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_EYE_HEIGHT_ER);
        const lookTarget = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_LOOK_AHEAD_ER);
        this.camera.position.copy(camPos);
        this.controls.target.copy(lookTarget);
        this.camera.lookAt(lookTarget);
      } else {
        this.controls.update();
      }

    } else if (cameraMode === 'flying' && selectedIdx !== null) {
      // TLE fly-to
      if (this.source.getTleKinematics(selectedIdx, uT, this.trackingPos, this.trackingVelocity)) {
        let endCamPos: THREE.Vector3;
        let endTarget: THREE.Vector3;
        if (trackingStyle === 'joyride') {
          endCamPos = this.trackingPos;
          this.cameraController.getJoyrideEntryTarget(this.trackingPos, this.trackingVelocity, this.joyrideEntryTarget);
          endTarget = this.joyrideEntryTarget;
        } else {
          this.trackingRadialDir.copy(this.trackingPos).normalize();
          this.trackingEndCamPos.copy(this.trackingPos).addScaledVector(
            this.trackingRadialDir,
            this.cameraController.followOffsetDist,
          );
          endCamPos = this.trackingEndCamPos;
          endTarget = this.trackingPos;
        }
        const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
        if (done) {
          store.setCameraMode('following');
          this.arrivalTime = performance.now();
        }
      }

    } else if (cameraMode === 'flying' && selectedDso !== null) {
      // DSO fly-to
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) {
        let endCamPos: THREE.Vector3;
        let endTarget: THREE.Vector3;
        if (trackingStyle === 'joyride') {
          endCamPos = this.trackingPos;
          this.cameraController.getJoyrideEntryTarget(this.trackingPos, this.trackingVelocity, this.joyrideEntryTarget);
          endTarget = this.joyrideEntryTarget;
        } else {
          this.trackingRadialDir.copy(this.trackingPos).normalize();
          this.trackingEndCamPos.copy(this.trackingPos).addScaledVector(
            this.trackingRadialDir,
            this.cameraController.followOffsetDist,
          );
          endCamPos = this.trackingEndCamPos;
          endTarget = this.trackingPos;
        }
        const done = this.cameraController.updateAnim(endCamPos, endTarget, this.controls.target);
        if (done) {
          store.setCameraMode('following');
          this.arrivalTime = performance.now();
        }
      } else {
        // No ephemeris yet — stay in free until data arrives
        store.setCameraMode('free');
      }

    } else if (cameraMode === 'following' && selectedIdx !== null) {
      // TLE follow
      if (this.source.getTleKinematics(selectedIdx, uT, this.trackingPos, this.trackingVelocity)) {
        if (trackingStyle === 'joyride') {
          this.cameraController.updateJoyride(this.trackingPos, this.trackingVelocity, this.controls.target);
        } else {
          this.cameraController.updateFollow(this.trackingPos, this.controls.target);
        }
      }

    } else if (cameraMode === 'following' && selectedDso !== null) {
      // DSO follow
      const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === selectedDso.dsoId);
      if (this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) {
        if (trackingStyle === 'joyride') {
          this.cameraController.updateJoyride(this.trackingPos, this.trackingVelocity, this.controls.target);
        } else {
          this.cameraController.updateFollow(this.trackingPos, this.controls.target);
        }
      }

    } else if (cameraMode === 'returning') {
      const done = this.cameraController.updateAnim(
        this.returnEndPos || HOME_POSITION, this.returnEndTarget, this.controls.target,
      );
      if (done) {
        store.setCameraMode('free');
      }
    }
  }

  selectByIndex(index: number): void {
    const obj = this.source.getTleObject(index);
    if (index < 0 || index >= this.source.getTleCount() || !obj) return;

    const altitudeKm = this.source.getTleAltitudeKm(index);
    const store = useStore.getState();

    const isTracking = store.cameraMode === 'flying' || store.cameraMode === 'following';
    if (isTracking && store.selectedIndex !== null && store.selectedIndex !== index) {
      store.setSelectedSatellite(index, obj, Math.round(altitudeKm));
      const uT = this.source.getInterpolationFactor();
      this.source.getTleKinematics(index, uT, this.trackingPos, this.trackingVelocity);
      if (store.trackingStyle === 'joyride') {
        this.cameraController.resetJoyrideState();
      }
      this.arrivalTime = -1;
      this.cameraController.flyTo(this.trackingPos, this.controls.target);
      store.setCameraMode('flying');
      return;
    }

    if (store.cameraMode !== 'free' && store.selectedIndex !== index) {
      store.setCameraMode('free');
    }

    store.setSelectedSatellite(index, obj, Math.round(altitudeKm));
  }

  selectDsoByIndex(dsoIndex: number): void {
    const store = useStore.getState();
    const dso = store.dsoObjects[dsoIndex];
    if (!dso) return;

    if (store.cameraMode !== 'free') {
      store.setCameraMode('free');
    }

    store.setSelectedDso(dso);
  }

  flyToSatellite(index: number, style: TrackingStyle = 'follow'): void {
    if (index < 0 || index >= this.source.getTleCount() || !this.source.isReady()) return;

    let store = useStore.getState();
    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedIndex === index
      && store.trackingStyle === style) return;

    if (store.selectedIndex !== index) {
      this.selectByIndex(index);
    }

    store = useStore.getState();
    if (store.selectedIndex !== index) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    const uT = this.source.getInterpolationFactor();
    this.source.getTleKinematics(index, uT, this.trackingPos, this.trackingVelocity);

    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(this.trackingPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideSatellite(index: number): void {
    this.flyToSatellite(index, 'joyride');
  }

  flyToDso(dsoId: string, style: TrackingStyle = 'follow'): void {
    let store = useStore.getState();
    const dsoIndex = store.dsoObjects.findIndex((d) => d.dsoId === dsoId);
    if (!this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity)) return;

    if ((store.cameraMode === 'flying' || store.cameraMode === 'following')
      && store.selectedDso?.dsoId === dsoId
      && store.trackingStyle === style) return;

    if (store.selectedDso?.dsoId !== dsoId) {
      store.setSelectedDso(store.dsoObjects[dsoIndex]);
    }

    store = useStore.getState();
    if (store.selectedDso?.dsoId !== dsoId) return;
    if (store.trackingStyle !== style) {
      store.setTrackingStyle(style);
    }

    // Re-read the position after the (possible) selection change above.
    this.source.getDsoKinematics(dsoIndex, this.trackingPos, this.trackingVelocity);
    if (style === 'joyride') {
      this.cameraController.resetJoyrideState();
    }
    this.arrivalTime = -1;
    this.cameraController.flyTo(this.trackingPos, this.controls.target);
    store.setCameraMode('flying');
  }

  joyrideDso(dsoId: string): void {
    this.flyToDso(dsoId, 'joyride');
  }

  resetCamera(): void {
    const store = useStore.getState();
    this.useHardReset = true;
    if (store.cameraMode !== 'returning') {
      store.setCameraMode('returning');
    } else {
      this.returnEndPos = HOME_POSITION.clone();
      this.returnEndTarget.copy(HOME_TARGET);
      this.cameraController.returnToHome(this.controls.target);
      this.useHardReset = false;
    }
  }

  focusCameraOnObserverSky(loc: { lat: number; lon: number; alt: number }): void {
    const { observerWorldPos, upDir } = this.getObserverSkyAnchor(loc);
    const camPos = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_EYE_HEIGHT_ER);
    const lookTarget = observerWorldPos.clone().addScaledVector(upDir, VISUAL_CAMERA_LOOK_AHEAD_ER);

    const store = useStore.getState();
    if (store.cameraMode !== 'free') {
      store.setCameraMode('free');
    }

    this.cameraController.cancel();
    this.arrivalTime = -1;
    this.returnEndPos = null;
    this.controls.enabled = true;
    this.camera.position.copy(camPos);
    this.controls.target.copy(lookTarget);
    this.camera.lookAt(lookTarget);
    this.controls.update();
  }

  private getObserverSkyAnchor(
    loc: { lat: number; lon: number; alt: number },
  ): { observerWorldPos: THREE.Vector3; upDir: THREE.Vector3 } {
    const observerWorldPos = getObserverScenePosition(
      loc.lat,
      loc.lon,
      loc.alt,
      simClock.date(),
    );
    const upDir = observerWorldPos.clone().normalize();
    return { observerWorldPos, upDir };
  }

  dispose(): void {
    this.cameraModeUnsub?.();
    this.cameraModeUnsub = null;
  }
}
