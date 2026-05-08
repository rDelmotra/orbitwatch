/**
 * StarsModule — astronomically accurate starfield from Takram.
 * Implemented in Step 7. This is a stub.
 * On success replaces StarfieldRenderer in the scene.
 */
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class StarsModule implements GeospatialModule {
  readonly name = 'stars';
  readonly ready = false;
  readonly failed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_ctx: GeospatialContext): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_frame: FrameState): void {}
  dispose(): void {}
}
