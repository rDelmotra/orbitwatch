import * as THREE from 'three';
import { EarthRenderer } from '../../EarthRenderer';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/**
 * Earth globe — the ACTIVE Earth path (inlined GLSL in {@link EarthRenderer};
 * the `geospatial/` tile pipeline is scaffolding, not yet wired). This is the
 * single seam for the Earth model + cloud colour. Non-critical: if it throws,
 * the rest of the scene still renders.
 */
export class EarthLayer implements Layer {
  readonly name = 'earth';
  readonly critical = false;

  private earthRenderer: EarthRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  /**
   * The rotating Earth group (GAST applied to `rotation.y`). Other layers that
   * must rotate with the Earth (e.g. the observer marker) parent to this.
   * Null until {@link init} has run.
   */
  get group(): THREE.Group | null {
    return this.earthRenderer?.object ?? null;
  }

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.earthRenderer = new EarthRenderer(ctx.maxAnisotropy, ctx.renderer, ctx.camera);
    ctx.scene.add(this.earthRenderer.object);
  }

  update(frame: FrameContext): void {
    if (!this.earthRenderer || !this.camera) return;
    this.earthRenderer.sunDirection.copy(frame.sunDirectionECI);
    this.earthRenderer.object.rotation.y = frame.gastRadians;
    this.earthRenderer.update(frame.delta, this.camera);
  }

  dispose(): void {
    if (this.earthRenderer) {
      this.scene?.remove(this.earthRenderer.object);
      this.earthRenderer.dispose();
      this.earthRenderer = null;
    }
    this.scene = null;
    this.camera = null;
  }
}
