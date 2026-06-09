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
  private readonly initialized = new Set<Layer>();
  private readonly failed = new Set<Layer>();
  private readonly onCriticalError: (err: unknown) => void;

  constructor(callbacks: { onCriticalError: (err: unknown) => void }) {
    this.onCriticalError = callbacks.onCriticalError;
  }

  register(layer: Layer): this {
    this.layers.push(layer);
    return this;
  }

  /**
   * Initialize all layers. **Synchronous** layers complete (and become
   * updatable) within this call, so the caller can rely on their products
   * immediately. Asynchronous layers init in the background and are marked
   * ready when they resolve — `update(frame)` skips them until then.
   */
  init(ctx: LayerContext): void {
    for (const layer of this.layers) {
      try {
        const result = layer.init(ctx);
        if (result instanceof Promise) {
          result
            .then(() => {
              this.initialized.add(layer);
            })
            .catch((err) => {
              this.handleFailure(layer, err, 'init');
            });
        } else {
          this.initialized.add(layer);
        }
      } catch (err) {
        this.handleFailure(layer, err, 'init');
      }
    }
  }

  update(frame: FrameContext): void {
    for (const layer of this.layers) {
      // Skip layers whose (possibly async) init hasn't completed, and failed ones.
      if (!this.initialized.has(layer) || this.failed.has(layer)) continue;
      try {
        layer.update(frame);
      } catch (err) {
        this.handleFailure(layer, err, 'update');
      }
    }
  }

  /**
   * Run a direct (command-style) call on a layer with the SAME failure isolation
   * as `update()`: non-critical failures log + disable the layer; critical ones
   * escalate. Also guards against commands arriving before the layer's init has
   * resolved (returns + warns instead of silently dropping). Use this for any
   * layer method the Engine calls outside the `update(frame)` path.
   */
  runLayerCommand(layer: Layer, label: string, fn: () => void): void {
    if (this.failed.has(layer)) return;
    if (!this.initialized.has(layer)) {
      console.warn(`[world] command "${label}" on "${layer.name}" before init — ignored`);
      return;
    }
    try {
      fn();
    } catch (err) {
      this.handleFailure(layer, err, `command:${label}`);
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
    this.initialized.clear();
    this.failed.clear();
  }

  private handleFailure(layer: Layer, err: unknown, phase: string): void {
    this.failed.add(layer);
    if (layer.critical) {
      console.error(`[world] CRITICAL layer "${layer.name}" failed at ${phase}:`, err);
      this.onCriticalError(err);
    } else {
      console.warn(`[world] layer "${layer.name}" failed at ${phase} (continuing):`, err);
    }
  }
}
