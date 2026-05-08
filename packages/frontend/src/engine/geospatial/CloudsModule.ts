/**
 * CloudsModule — Frostbite-style volumetric clouds with real NASA GIBS weather data.
 * Implemented in Step 9. This is a stub.
 */
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

export class CloudsModule implements GeospatialModule {
  readonly name = 'clouds';
  readonly ready = false;
  readonly failed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_ctx: GeospatialContext): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_frame: FrameState): void {}
  dispose(): void {}
}
