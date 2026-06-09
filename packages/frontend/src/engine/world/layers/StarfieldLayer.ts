import { StarfieldRenderer } from '../../StarfieldRenderer';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Background starfield (5000 stars). Fixed-cost backdrop — no per-frame work. */
export class StarfieldLayer implements Layer {
  readonly name = 'starfield';
  readonly critical = false;

  private renderer: StarfieldRenderer | null = null;
  private scene: LayerContext['scene'] | null = null;

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.renderer = new StarfieldRenderer();
    ctx.scene.add(this.renderer.object);
  }

  update(_frame: FrameContext): void {
    // Static backdrop — nothing to update per frame.
  }

  dispose(): void {
    if (this.renderer) {
      this.scene?.remove(this.renderer.object);
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
  }
}
