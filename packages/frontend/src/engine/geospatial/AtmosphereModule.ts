/**
 * AtmosphereModule — Bruneton precomputed atmospheric scattering.
 * Implemented in Step 6. This is a stub that satisfies the GeospatialModule interface.
 */
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class AtmosphereModule implements GeospatialModule {
  readonly name = 'atmosphere';
  readonly ready = false;
  readonly failed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_ctx: GeospatialContext): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_frame: FrameState): void {}
  dispose(): void {}
}
