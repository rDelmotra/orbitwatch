import * as THREE from 'three';
import { getObserverECEFPosition } from '../../../orbital/coordinates';
import { useStore } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

type ObserverLoc = { lat: number; lon: number; alt: number };

/** Tangent-plane radius of the ground disc / horizon ring, in Earth radii. */
const GROUND_RADIUS_ER = 0.2;
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

/**
 * The sky-dome ground reference — a translucent ground disc + bright horizon ring
 * pinned at the observer, giving the planetarium view a "standing on the Earth"
 * frame. Visible **only in dome mode**. Modeled on {@link ObserverMarkerLayer}:
 * parents to the rotating Earth group (so it tracks geography via GAST), builds
 * lazily when a location is set, and disposes its own GL. Non-critical.
 *
 * Sits at the observer's surface point (no lift offset) so it coincides with the
 * dome camera's eye plane. Cardinal-direction labels are deferred to Phase 2.
 */
export class HorizonLayer implements Layer {
  readonly name = 'horizon';
  readonly critical = false;

  private parent: THREE.Object3D | null = null;
  private group: THREE.Group | null = null;

  init(_ctx: LayerContext): void {
    // No scene-root object: parents to the Earth group (via setParent), built
    // lazily in setLocation().
  }

  /** Engine wires the rotating Earth group as the parent (cross-layer). */
  setParent(group: THREE.Object3D | null): void {
    this.parent = group;
  }

  /** Build / reposition / remove the horizon for the given observer location. */
  setLocation(loc: ObserverLoc | null): void {
    if (!this.parent) return;

    if (loc) {
      if (!this.group) {
        this.group = this.build();
        this.group.visible = useStore.getState().visibilityMode === 'dome';
        this.parent.add(this.group);
      }
      // surfaceOffset = 0: sit at the surface, level with the dome camera's eye.
      const pos = getObserverECEFPosition(loc.lat, loc.lon, loc.alt, 0);
      this.group.position.copy(pos);
      this.group.quaternion.setFromUnitVectors(LOCAL_UP, pos.clone().normalize());
    } else if (this.group) {
      this.remove();
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

  private build(): THREE.Group {
    const group = new THREE.Group();

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
    group.add(disc);

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
    group.add(ring);

    return group;
  }

  private remove(): void {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.group = null;
  }
}
