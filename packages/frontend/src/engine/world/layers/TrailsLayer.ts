import { OrbitTrailRenderer } from '../../OrbitTrailRenderer';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/**
 * Orbit trail for the selected object (dual-layer line + glow). The GL lives
 * here; the *when* (which object, on selection/time change) is orchestrated by
 * the Engine via `generate*`/`clear`, because the trail spans both the SGP4 and
 * DSO sides — and layers never import other layers.
 */
export class TrailsLayer implements Layer {
  readonly name = 'trails';
  readonly critical = false;

  private renderer: OrbitTrailRenderer | null = null;

  init(ctx: LayerContext): void {
    this.renderer = new OrbitTrailRenderer(ctx.scene);
  }

  update(frame: FrameContext): void {
    this.renderer?.setJoyrideMode(frame.isJoyrideTracking);
  }

  // ── Engine-driven orchestration (selection / time-jump) ─────────────────────

  generate(line1: string, line2: string, anchorTimeMs: number): void {
    this.renderer?.generate(line1, line2, anchorTimeMs);
  }

  generateFromPositions(positionsTeme: Float32Array): void {
    this.renderer?.generateFromPositions(positionsTeme);
  }

  clear(): void {
    this.renderer?.clear();
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
