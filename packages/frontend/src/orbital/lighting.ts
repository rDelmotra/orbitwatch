import * as THREE from 'three';

const TWILIGHT_SIN = Math.sin(-6 * (Math.PI / 180));

export function isEclipsedFromComponents(
  satX: number,
  satY: number,
  satZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): boolean {
  const dot = satX * sunX + satY * sunY + satZ * sunZ;
  if (dot >= 0) return false;

  const satLenSq = satX * satX + satY * satY + satZ * satZ;
  const distSq = satLenSq - (dot * dot);
  return distSq < 1.0;
}

/**
 * Checks if a satellite is in Earth's cylindrical shadow (umbra).
 * @param satPos - Satellite position in scene units (Earth radius = 1.0)
 * @param sunDir - Sun direction unit vector in scene coordinates
 */
export function isEclipsed(satPos: THREE.Vector3, sunDir: THREE.Vector3): boolean {
  return isEclipsedFromComponents(
    satPos.x,
    satPos.y,
    satPos.z,
    sunDir.x,
    sunDir.y,
    sunDir.z,
  );
}

export function isObserverInDarkFromComponents(
  obsX: number,
  obsY: number,
  obsZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): boolean {
  const obsLen = Math.sqrt(obsX * obsX + obsY * obsY + obsZ * obsZ);
  if (obsLen === 0) {
    return false;
  }

  const invObsLen = 1 / obsLen;
  const sinElev = ((obsX * invObsLen) * sunX) + ((obsY * invObsLen) * sunY) + ((obsZ * invObsLen) * sunZ);
  return sinElev < TWILIGHT_SIN;
}

/**
 * Checks if the observer is in twilight or night (Sun elevation < -6 degrees).
 * @param obsPos - Observer position in scene units
 * @param sunDir - Sun direction unit vector
 */
export function isObserverInDark(obsPos: THREE.Vector3, sunDir: THREE.Vector3): boolean {
  return isObserverInDarkFromComponents(
    obsPos.x,
    obsPos.y,
    obsPos.z,
    sunDir.x,
    sunDir.y,
    sunDir.z,
  );
}

export function getPhaseMultiplierFromComponents(
  satX: number,
  satY: number,
  satZ: number,
  obsX: number,
  obsY: number,
  obsZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
): number {
  const vx = obsX - satX;
  const vy = obsY - satY;
  const vz = obsZ - satZ;
  const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (vLen === 0) {
    return 0.1;
  }

  const invVLen = 1 / vLen;
  const phaseCos = ((vx * invVLen) * sunX) + ((vy * invVLen) * sunY) + ((vz * invVLen) * sunZ);
  return Math.max(0.1, (phaseCos + 0.5) / 1.5);
}

/**
 * Calculates a visual multiplier based on lighting phase angle.
 * @param satPos - Satellite position
 * @param obsPos - Observer position
 * @param sunDir - Sun direction unit vector
 */
export function getPhaseMultiplier(satPos: THREE.Vector3, obsPos: THREE.Vector3, sunDir: THREE.Vector3): number {
  return getPhaseMultiplierFromComponents(
    satPos.x,
    satPos.y,
    satPos.z,
    obsPos.x,
    obsPos.y,
    obsPos.z,
    sunDir.x,
    sunDir.y,
    sunDir.z,
  );
}
