import * as THREE from 'three';
import { getObserverScenePosition } from '../../orbital/coordinates';
import { getGAST } from '../../orbital/time';
import type { ObserverState, TwilightPhase, NakedEyeQuality } from '../types';

const SIN_NEG_6  = Math.sin(-6  * Math.PI / 180);
const SIN_NEG_12 = Math.sin(-12 * Math.PI / 180);
const SIN_NEG_18 = Math.sin(-18 * Math.PI / 180);

export function computeObserverState(
  observerLocation: { lat: number; lon: number; alt: number } | null,
  sunDir: THREE.Vector3,
  now: Date,
): ObserverState {
  if (!observerLocation) {
    return { active: false, lat: null, lon: null, twilightPhase: null, nakedEyeQuality: null, localSolarHourAngle: null };
  }

  const { lat, lon, alt } = observerLocation;
  const obsPos = getObserverScenePosition(lat, lon, alt, now);

  // Sun elevation sin = dot(normalize(obsPos), sunDir)
  const obsLen = obsPos.length();
  const sinElev = obsLen > 0
    ? (obsPos.x * sunDir.x + obsPos.y * sunDir.y + obsPos.z * sunDir.z) / obsLen
    : 0;

  let twilightPhase: TwilightPhase;
  if (sinElev >= 0) {
    twilightPhase = 'day';
  } else if (sinElev >= SIN_NEG_6) {
    twilightPhase = 'civil';
  } else if (sinElev >= SIN_NEG_12) {
    twilightPhase = 'nautical';
  } else if (sinElev >= SIN_NEG_18) {
    twilightPhase = 'astronomical';
  } else {
    twilightPhase = 'night';
  }

  let nakedEyeQuality: NakedEyeQuality;
  if (twilightPhase === 'night') {
    nakedEyeQuality = 'good';
  } else if (twilightPhase === 'astronomical') {
    nakedEyeQuality = 'marginal';
  } else {
    nakedEyeQuality = 'poor';
  }

  // Local solar hour angle: GAST + observer longitude (radians) → hours (0–24)
  const gast = getGAST(now);
  const lonRad = lon * Math.PI / 180;
  const lhaRad = ((gast + lonRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const localSolarHourAngle = lhaRad * 12 / Math.PI; // radians → hours

  return { active: true, lat, lon, twilightPhase, nakedEyeQuality, localSolarHourAngle };
}
