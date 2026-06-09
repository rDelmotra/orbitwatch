import * as THREE from 'three';
import { sourceToScene } from './frames';

const EARTH_RADIUS_KM = 6371;

function toJulianDate(date: Date): number {
  return date.getTime() / 86400000.0 + 2440587.5;
}

function getGAST(date: Date): number {
  const jd = toJulianDate(date);
  const du = jd - 2451545.0;
  const t = du / 36525.0;
  const gmstDeg = 280.46061837
    + 360.98564736629 * du
    + 0.000387933 * t * t
    - t * t * t / 38710000.0;
  return (((gmstDeg % 360) + 360) % 360) * (Math.PI / 180.0);
}

/**
 * Returns the ECI observer position mapped to Three.js scene coordinates.
 * Steps: Geodetic (Lat/Lon) -> ECEF -> ECI (via GAST) -> Scene
 */
export function getObserverScenePosition(
  latDeg: number,
  lonDeg: number,
  altKm: number,
  date: Date
): THREE.Vector3 {
  // 1. Geodetic to ECEF (assuming spherical Earth for simplicity)
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const r = (EARTH_RADIUS_KM + altKm) / EARTH_RADIUS_KM; // Distance in scene units

  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.cos(lat) * Math.sin(lon);
  const z = r * Math.sin(lat);

  // 2. Earth rotates by GAST. ECEF -> ECI
  const theta = getGAST(date);
  const eciX = x * Math.cos(theta) - y * Math.sin(theta);
  const eciY = x * Math.sin(theta) + y * Math.cos(theta);
  const eciZ = z;

  // 3. ECI -> Three.js Y-up world space
  return sourceToScene(eciX, eciY, eciZ);
}

export function getObserverSceneAnchor(
  latDeg: number,
  lonDeg: number,
  altKm: number,
  date: Date,
): { position: THREE.Vector3; up: THREE.Vector3 } {
  const position = getObserverScenePosition(latDeg, lonDeg, altKm, date);
  const up = position.clone().normalize();
  return { position, up };
}

/**
 * Returns an ECEF position in earthRenderer.object local space (Three.js Y-up).
 * No GAST rotation — the marker is parented to the Earth group which already
 * rotates by GAST each frame, keeping it pinned to geography.
 */
export function getObserverECEFPosition(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  surfaceOffsetEr = 0.006,
): THREE.Vector3 {
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const r = ((EARTH_RADIUS_KM + altKm) / EARTH_RADIUS_KM) + surfaceOffsetEr;

  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.cos(lat) * Math.sin(lon);
  const z = r * Math.sin(lat);

  // ECEF -> Three.js local space (Y-up)
  return sourceToScene(x, y, z);
}
