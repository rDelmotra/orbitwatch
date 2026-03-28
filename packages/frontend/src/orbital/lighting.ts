import * as THREE from 'three';

/**
 * Checks if a satellite is in Earth's cylindrical shadow (umbra).
 * @param satPos - Satellite position in scene units (Earth radius = 1.0)
 * @param sunDir - Sun direction unit vector in scene coordinates
 */
export function isEclipsed(satPos: THREE.Vector3, sunDir: THREE.Vector3): boolean {
  const dot = satPos.dot(sunDir);
  if (dot >= 0) return false; // Satellite is generally on the day side
  
  const distSq = satPos.lengthSq() - (dot * dot);
  return distSq < 1.0; // Inside the 1.0 radius shadow cylinder
}

/**
 * Checks if the observer is in twilight or night (Sun elevation < -6 degrees).
 * @param obsPos - Observer position in scene units
 * @param sunDir - Sun direction unit vector
 */
export function isObserverInDark(obsPos: THREE.Vector3, sunDir: THREE.Vector3): boolean {
  const normalizedObs = obsPos.clone().normalize();
  const sinElev = normalizedObs.dot(sunDir);
  return sinElev < -0.1045; // sin(-6 degrees)
}

/**
 * Calculates a visual multiplier based on lighting phase angle.
 * @param satPos - Satellite position
 * @param obsPos - Observer position
 * @param sunDir - Sun direction unit vector
 */
export function getPhaseMultiplier(satPos: THREE.Vector3, obsPos: THREE.Vector3, sunDir: THREE.Vector3): number {
  const satToObs = obsPos.clone().sub(satPos).normalize();
  const phaseCos = satToObs.dot(sunDir); // approximation, sun is infinitely far
  return Math.max(0.1, (phaseCos + 0.5) / 1.5);
}
