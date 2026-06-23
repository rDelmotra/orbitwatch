import * as THREE from 'three';

/** Owns WebGL renderer creation + config. The single render seam — shaped so a
 *  post-processing composer can later replace `render()` internally (reference 05). */
export class Renderer {
  /** Underlying three renderer. Exposed for consumers that need it directly
   *  (EarthRenderer, GPUPicker). Prefer the methods below where possible. */
  readonly instance: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement) {
    this.instance = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.instance.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // false = set the drawing-buffer size only; do NOT write inline style.width/
    // height onto the canvas. With the default (true), three.js pins the canvas to
    // fixed pixels, overriding the CSS `100%`, so it no longer follows its
    // container and the ResizeObserver never fires on window resize.
    this.instance.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.instance.outputColorSpace = THREE.SRGBColorSpace;
    this.instance.toneMapping = THREE.ACESFilmicToneMapping;
    this.instance.toneMappingExposure = 1.0;
  }

  get domElement(): HTMLCanvasElement {
    return this.instance.domElement as HTMLCanvasElement;
  }

  getPixelRatio(): number {
    return this.instance.getPixelRatio();
  }

  getMaxAnisotropy(): number {
    return this.instance.capabilities.getMaxAnisotropy();
  }

  setSize(width: number, height: number): void {
    this.instance.setSize(width, height, false); // false = don't touch canvas CSS size
  }

  /** Render seam. Today: direct render. Later: `if (composer) composer.render() else …`. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.instance.render(scene, camera);
  }

  dispose(): void {
    this.instance.dispose();
  }
}
