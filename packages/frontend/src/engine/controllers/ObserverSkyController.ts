import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getObserverSceneAnchor } from '../../orbital/coordinates';
import { simClock } from '../SimClock';
import type { VisibilityMode } from '../../store/useStore';

type ObserverLoc = { lat: number; lon: number; alt: number };

/** Eye height above the observer's feet, in Earth radii (~16 m). */
const EYE_HEIGHT_ER = 0.0000025;
/** Wider FOV for the immersive dome (Star Walk-style); visual mode keeps default. */
const DOME_FOV_DEG = 90;
const MIN_ELEVATION_RAD = THREE.MathUtils.degToRad(-5);
const MAX_ELEVATION_RAD = THREE.MathUtils.degToRad(89);
/** Initial gaze: facing north (az 0), tilted ~45° up the dome. */
const INITIAL_ELEVATION_RAD = THREE.MathUtils.degToRad(45);

/**
 * Earth's spin axis (celestial north pole) in the Three.js scene frame.
 * TEME +Z = (0,0,1) maps through the `frames.ts` swap `(x,z,-y)` → (0,1,0).
 */
const SCENE_NORTH_POLE = new THREE.Vector3(0, 1, 0);

/**
 * Owns the **observer-anchored alt-azimuth camera** shared by `visual` and `dome`
 * visibility modes — the planetarium rig. Mirrors how {@link CameraController} is a
 * focused camera helper owned by {@link NavigationController}: Nav delegates here.
 *
 * The eye is pinned at the observer's location (re-anchored every frame as the Earth
 * rotates under them); the user's drag only rotates the gaze (azimuth + elevation)
 * across the upper hemisphere, with `camera.up` locked to the local zenith so the
 * horizon stays level. OrbitControls are disabled while active — this rig replaces
 * them — and the original FOV is captured/restored around dome's wider FOV.
 */
export class ObserverSkyController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly originalFov: number;

  private active = false;
  private azimuth = 0; // radians, measured from North toward East
  private elevation = INITIAL_ELEVATION_RAD; // radians, 0 = horizon, +up = zenith

  // Per-frame scratch (no allocation in the rAF path).
  private readonly up = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly gaze = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    this.camera = camera;
    this.controls = controls;
    this.originalFov = camera.fov;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Enter observer-sky: pin the eye, disable orbit, set FOV, seed the gaze. */
  enter(loc: ObserverLoc, mode: VisibilityMode): void {
    this.active = true;
    this.azimuth = 0;
    this.elevation = INITIAL_ELEVATION_RAD;
    this.controls.enabled = false;
    this.setFov(mode === 'dome' ? DOME_FOV_DEG : this.originalFov);
    this.applyToCamera(loc);
  }

  /**
   * Leave observer-sky: restore the default FOV and world-up. Called both when the
   * user leaves dome/visual mode AND when the camera leaves the free view (fly-to /
   * joyride) — so those never inherit the dome lens or the tilted local-zenith up.
   * (Nav re-enables controls via its cameraMode machine.)
   */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.setFov(this.originalFov);
    this.camera.up.set(0, 1, 0);
  }

  /** Rotate the gaze. `dAz`/`dEl` are radian deltas from the input layer. */
  addLookInput(dAz: number, dEl: number): void {
    if (!this.active) return;
    this.azimuth = wrapAngle(this.azimuth + dAz);
    this.elevation = THREE.MathUtils.clamp(
      this.elevation + dEl,
      MIN_ELEVATION_RAD,
      MAX_ELEVATION_RAD,
    );
  }

  /**
   * Per-frame: re-anchor the eye to the (rotating) observer and re-apply the gaze.
   * Re-asserts `controls.enabled = false` so a return-from-fly-to (which flips it
   * back on via the cameraMode sub) can't leave OrbitControls fighting the rig.
   */
  update(loc: ObserverLoc): void {
    if (!this.active) return;
    this.controls.enabled = false;
    this.applyToCamera(loc);
  }

  private applyToCamera(loc: ObserverLoc): void {
    const anchor = getObserverSceneAnchor(loc.lat, loc.lon, loc.alt, simClock.date());
    this.up.copy(anchor.up);

    // Local East-North-Up basis. East ⟂ {spin axis, up}; North completes it.
    this.east.crossVectors(SCENE_NORTH_POLE, this.up);
    if (this.east.lengthSq() < 1e-8) {
      this.east.set(1, 0, 0); // observer at a pole — pick an arbitrary tangent
    }
    this.east.normalize();
    this.north.crossVectors(this.up, this.east).normalize();

    const cosEl = Math.cos(this.elevation);
    const sinEl = Math.sin(this.elevation);
    this.gaze
      .set(0, 0, 0)
      .addScaledVector(this.east, cosEl * Math.sin(this.azimuth))
      .addScaledVector(this.north, cosEl * Math.cos(this.azimuth))
      .addScaledVector(this.up, sinEl);

    this.eye.copy(anchor.position).addScaledVector(this.up, EYE_HEIGHT_ER);
    this.lookTarget.copy(this.eye).add(this.gaze);

    this.camera.up.copy(this.up);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.lookTarget);
  }

  private setFov(fov: number): void {
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = radians % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
