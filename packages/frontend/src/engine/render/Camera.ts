import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Owns the perspective camera + OrbitControls and their construction / config /
 *  resize / dispose. The camera *state machine* (free/flying/following/returning)
 *  stays in the orchestrator for now and moves to NavigationController in a later
 *  slice — this is just the infrastructure seam. */
export class Camera {
  readonly instance: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  constructor(canvas: HTMLCanvasElement) {
    const aspect = canvas.clientWidth / canvas.clientHeight;
    this.instance = new THREE.PerspectiveCamera(27, aspect, 0.01, 1000);
    this.instance.position.set(0, 1.5, 3.5);

    this.controls = new OrbitControls(this.instance, canvas);
    this.controls.minDistance = 1.08;
    this.controls.maxDistance = 300; // expanded from 100 to reach JWST (~235 ER)
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
  }

  resize(width: number, height: number): void {
    this.instance.aspect = width / height;
    this.instance.updateProjectionMatrix();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
