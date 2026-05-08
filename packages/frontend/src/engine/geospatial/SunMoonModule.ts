/**
 * SunMoonModule — astronomically accurate sun/moon direction via astronomy-engine.
 * Implemented in Step 7. This is a stub.
 */
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class SunMoonModule implements GeospatialModule {
  readonly name = 'sun-moon';
  readonly ready = false;
  readonly failed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_ctx: GeospatialContext): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_frame: FrameState): void {}
  dispose(): void {}
}
