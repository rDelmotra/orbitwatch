/**
 * TileEarthSurface — tile-based LOD Earth via 3d-tiles-renderer.
 * Implemented in Step 8. This is a stub.
 * On success calls fallback.hideSurface().
 */
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class TileEarthSurface implements GeospatialModule {
  readonly name = 'tile-earth';
  readonly ready = false;
  readonly failed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_ctx: GeospatialContext): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_frame: FrameState): void {}
  dispose(): void {}
}
