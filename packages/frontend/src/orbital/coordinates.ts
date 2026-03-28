import * as THREE from 'three';
import { getGAST } from './time';

const EARTH_RADIUS_KM = 6371;

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
  // THREE.x = ECI.x,  THREE.y = ECI.z (north),  THREE.z = -ECI.y
  return new THREE.Vector3(eciX, eciZ, -eciY);
}

/**
 * Returns an ECEF position in earthRenderer.object local space (Three.js Y-up).
 * No GAST rotation — the marker is parented to the Earth group which already
 * rotates by GAST each frame, keeping it pinned to geography.
 */
export function getObserverECEFPosition(latDeg: number, lonDeg: number): THREE.Vector3 {
  const lat = latDeg * (Math.PI / 180);
  const lon = lonDeg * (Math.PI / 180);
  const r = 1.006; // Slightly above cloud layer (1.004) to avoid z-fighting

  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.cos(lat) * Math.sin(lon);
  const z = r * Math.sin(lat);

  // ECEF -> Three.js local space (Y-up)
  return new THREE.Vector3(x, z, -y);
}
