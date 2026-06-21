import * as THREE from 'three';
import { getObserverECEFPosition } from '../../../orbital/coordinates';
import { useStore } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

type ObserverLoc = { lat: number; lon: number; alt: number };

/** Tangent-plane radius of the ground disc / horizon ring, in Earth radii. */
const GROUND_RADIUS_ER = 0.2;
/** Cardinal-label ring radius + how far they hover above the horizon plane. */
const LABEL_RADIUS_ER = GROUND_RADIUS_ER;
const LABEL_LIFT_ER = 0.01;
const LABEL_SCALE_ER = 0.0175;

const LOCAL_UP = new THREE.Vector3(0, 1, 0);
/**
 * Earth's spin axis (celestial north pole) in the Earth-group / ECEF-scene frame:
 * ECEF +Z = (0,0,1) maps through the `frames.ts` swap `(x,z,-y)` → (0,1,0). The
 * horizon parents to the rotating Earth group, so the cardinal directions are
 * computed in this (GAST-free) frame and ride the group's rotation.
 */
const SPIN_AXIS = new THREE.Vector3(0, 1, 0);

const CARDINAL_NORTH = '#ff6b4a'; // North stands out (warm) for instant orientation
const CARDINAL_OTHER = '#8fe3ff'; // E / S / W — bright cyan
const CARDINAL_MINOR = '#6aa6c2'; // NE / SE / SW / NW — dimmer + smaller intercardinals

/**
 * 8-point compass ring (every 45°), angle measured from North toward East. Denser
 * than just N/E/S/W so the horizon always shows a marker or two within the (narrow)
 * dome FOV — the spacing then reads as a natural rotating ring rather than two lone
 * letters tapering. `major` = cardinal (bigger/brighter); intercardinals are minor.
 */
const MARKERS: { letter: string; angleDeg: number; major: boolean }[] = [
  { letter: 'N', angleDeg: 0, major: true },
  { letter: 'NE', angleDeg: 45, major: false },
  { letter: 'E', angleDeg: 90, major: true },
  { letter: 'SE', angleDeg: 135, major: false },
  { letter: 'S', angleDeg: 180, major: true },
  { letter: 'SW', angleDeg: 225, major: false },
  { letter: 'W', angleDeg: 270, major: true },
  { letter: 'NW', angleDeg: 315, major: false },
];

/**
 * The sky-dome ground reference — a translucent ground disc + bright horizon ring +
 * N/E/S/W cardinal labels, pinned at the observer, giving the planetarium view a
 * "standing on the Earth, facing a direction" frame. Visible **only in dome mode**.
 * Modeled on {@link ObserverMarkerLayer}: parents to the rotating Earth group (so it
 * tracks geography via GAST), builds lazily, and disposes its own GL. Non-critical.
 *
 * Structure: an identity-transformed container holds (a) a `surface` sub-group (disc
 * + ring, oriented +Y → local up) and (b) eight billboard letter sprites placed at the
 * true ENU 8-point compass directions (see {@link MARKERS}). Sits at the observer's
 * surface point (no lift) so it coincides with the dome camera's eye plane.
 */
export class HorizonLayer implements Layer {
  readonly name = 'horizon';
  readonly critical = false;

  private parent: THREE.Object3D | null = null;
  private group: THREE.Group | null = null;
  private surface: THREE.Group | null = null;
  /** N, E, S, W sprites — placed each setLocation along the ENU cardinals. */
  private labels: THREE.Sprite[] = [];

  init(_ctx: LayerContext): void {
    // No scene-root object: parents to the Earth group (via setParent), built lazily.
  }

  /** Engine wires the rotating Earth group as the parent (cross-layer). */
  setParent(group: THREE.Object3D | null): void {
    this.parent = group;
  }

  /** Build / reposition / remove the horizon for the given observer location. */
  setLocation(loc: ObserverLoc | null): void {
    if (!this.parent) return;

    if (!loc) {
      this.remove();
      return;
    }

    if (!this.group) {
      this.build();
      this.group!.visible = useStore.getState().visibilityMode === 'dome';
      this.parent.add(this.group!);
    }

    // surfaceOffset = 0: sit at the surface, level with the dome camera's eye.
    const p = getObserverECEFPosition(loc.lat, loc.lon, loc.alt, 0);
    const up = p.clone().normalize();

    // Local East-North-Up basis (Earth-group frame). East ⟂ {spin axis, up}.
    const east = new THREE.Vector3().crossVectors(SPIN_AXIS, up);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0); // observer at a pole
    east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east).normalize();

    // Disc + ring: at the surface, +Y aligned to the local normal.
    this.surface!.position.copy(p);
    this.surface!.quaternion.setFromUnitVectors(LOCAL_UP, up);

    // Compass labels at the true 8-point directions, hovering just above the plane.
    // dir(θ) = north·cosθ + east·sinθ (θ from North toward East). No allocation.
    for (let i = 0; i < MARKERS.length; i++) {
      const a = THREE.MathUtils.degToRad(MARKERS[i].angleDeg);
      this.labels[i].position.copy(p)
        .addScaledVector(north, Math.cos(a) * LABEL_RADIUS_ER)
        .addScaledVector(east, Math.sin(a) * LABEL_RADIUS_ER)
        .addScaledVector(up, LABEL_LIFT_ER);
    }
  }

  update(_frame: FrameContext): void {
    // Static under the rotating Earth group; only its visibility tracks the mode.
    if (this.group) {
      this.group.visible = useStore.getState().visibilityMode === 'dome';
    }
  }

  dispose(): void {
    this.remove();
    this.parent = null;
  }

  private build(): void {
    const group = new THREE.Group();

    const surface = new THREE.Group();

    // Ground disc — dark + translucent so the lower hemisphere reads as ground.
    const discGeo = new THREE.CircleGeometry(GROUND_RADIUS_ER, 96);
    discGeo.rotateX(-Math.PI / 2); // lie flat in the tangent plane (normal → +Y)
    const discMat = new THREE.MeshBasicMaterial({
      color: 0x05070b,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.renderOrder = 0;
    surface.add(disc);

    // Horizon ring — a bright rim marking the horizon line.
    const ringGeo = new THREE.RingGeometry(GROUND_RADIUS_ER * 0.985, GROUND_RADIUS_ER, 96);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 1;
    surface.add(ring);

    group.add(surface);

    const labels = MARKERS.map((m) => {
      const color = m.letter === 'N' ? CARDINAL_NORTH : m.major ? CARDINAL_OTHER : CARDINAL_MINOR;
      return makeLabelSprite(m.letter, color, m.major);
    });
    for (const sprite of labels) group.add(sprite);

    this.group = group;
    this.surface = surface;
    this.labels = labels;
  }

  private remove(): void {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Sprite) {
        const mat = child.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.group = null;
    this.surface = null;
    this.labels = [];
  }
}

/**
 * A camera-facing letter label backed by a canvas texture. `major` cardinals render
 * bigger/brighter; intercardinals (2-char) get a wider canvas so they don't clip, and
 * the sprite's x-scale tracks the canvas aspect so the glyphs aren't squashed.
 */
function makeLabelSprite(letter: string, color: string, major: boolean): THREE.Sprite {
  const h = 64;
  const w = letter.length > 1 ? 112 : 64; // widen for "NE"/"SE"/… so they fit
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.font = `bold ${major ? 44 : 32}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillText(letter, w / 2, h / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: major ? 1 : 0.72, // intercardinals recede
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const scale = major ? LABEL_SCALE_ER : LABEL_SCALE_ER * 0.66;
  sprite.scale.set(scale * (w / h), scale, 1);
  sprite.renderOrder = 2;
  return sprite;
}
