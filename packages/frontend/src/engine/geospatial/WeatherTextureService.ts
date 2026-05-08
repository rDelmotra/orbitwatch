/**
 * WeatherTextureService — real-time cloud coverage from NASA GIBS (MODIS/GOES).
 * Implemented in Step 9. This is a stub.
 */
import type * as THREE from 'three';

export class WeatherTextureService {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(_renderer: THREE.WebGLRenderer): Promise<void> {}

  getTexture(): null { return null; }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startRefreshLoop(_intervalMs?: number): void {}

  dispose(): void {}
}
