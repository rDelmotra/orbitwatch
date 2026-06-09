import type { FrameContext, Layer, LayerContext } from '../render/Layer';

/**
 * The engine-level layer registry — generalizes `geospatial/EarthGroupManager`.
 *
 * Owns the set of {@link Layer}s, drives their init/update/dispose, and isolates
 * failures: a non-critical layer that throws is logged once, marked failed, and
 * skipped on future frames so the rest of the scene keeps rendering; a CRITICAL
 * layer that throws escalates via `onCriticalError` (Engine wires this to
 * `store.setLoadingError`). Adding a visual system = `world.register(new XLayer())`.
 */
export class World {
  private readonly layers: Layer[] = [];
  private readonly failed = new Set<Layer>();
  private readonly onCriticalError: (err: unknown) => void;

  constructor(callbacks: { onCriticalError: (err: unknown) => void }) {
    this.onCriticalError = callbacks.onCriticalError;
  }

  register(layer: Layer): this {
    this.layers.push(layer);
    return this;
  }

  async init(ctx: LayerContext): Promise<void> {
    for (const layer of this.layers) {
      try {
        await layer.init(ctx);
      } catch (err) {
        this.handleFailure(layer, err, 'init');
      }
    }
  }

  update(frame: FrameContext): void {
    for (const layer of this.layers) {
      if (this.failed.has(layer)) continue;
      try {
        layer.update(frame);
      } catch (err) {
        this.handleFailure(layer, err, 'update');
      }
    }
  }

  /** Placeholder for the future post-processing composer (reference 05). */
  getEffects(): object[] {
    return [];
  }

  dispose(): void {
    for (const layer of this.layers) {
      try {
        layer.dispose();
      } catch (err) {
        console.error(`[world] ${layer.name} dispose failed:`, err);
      }
    }
    this.layers.length = 0;
    this.failed.clear();
  }

  private handleFailure(layer: Layer, err: unknown, phase: 'init' | 'update'): void {
    this.failed.add(layer);
    if (layer.critical) {
      console.error(`[world] CRITICAL layer "${layer.name}" failed at ${phase}:`, err);
      this.onCriticalError(err);
    } else {
      console.warn(`[world] layer "${layer.name}" failed at ${phase} (continuing):`, err);
    }
  }
}
