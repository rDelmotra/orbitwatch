const DEG_TO_RAD = Math.PI / 180;

export const VISUAL_ELEVATION_THRESHOLD_DEG = 10;
export const VISUAL_ELEVATION_THRESHOLD_RAD = VISUAL_ELEVATION_THRESHOLD_DEG * DEG_TO_RAD;
export const VISUAL_ELEVATION_THRESHOLD_SIN = Math.sin(VISUAL_ELEVATION_THRESHOLD_RAD);

export const VISUAL_FADING_START_ELEVATION_DEG = 45;
export const VISUAL_FADING_START_ELEVATION_RAD = VISUAL_FADING_START_ELEVATION_DEG * DEG_TO_RAD;
export const VISUAL_FADING_START_SIN = Math.sin(VISUAL_FADING_START_ELEVATION_RAD);

export const VISUAL_RANGE_MAX_KM = 2000;

export type VisualVisibilityReason =
  | 'not_curated'
  | 'below_elevation'
  | 'out_of_range'
  | 'observer_daylight'
  | 'satellite_eclipsed';

export interface VisualVisibilityInput {
  isCurated: boolean;
  elevationSin: number;
  rangeKm: number;
  observerDark: boolean;
  satelliteEclipsed: boolean;
  elevationThresholdSin?: number;
  rangeMaxKm?: number;
}

export interface VisualVisibilityResult {
  visible: boolean;
  reason: VisualVisibilityReason | null;
}

export function evaluateVisualVisibility(input: VisualVisibilityInput): VisualVisibilityResult {
  const elevationThresholdSin = input.elevationThresholdSin ?? VISUAL_ELEVATION_THRESHOLD_SIN;
  const rangeMaxKm = input.rangeMaxKm ?? VISUAL_RANGE_MAX_KM;

  if (!input.isCurated) {
    return { visible: false, reason: 'not_curated' };
  }

  if (input.elevationSin < elevationThresholdSin) {
    return { visible: false, reason: 'below_elevation' };
  }

  if (input.rangeKm > rangeMaxKm) {
    return { visible: false, reason: 'out_of_range' };
  }

  if (!input.observerDark) {
    return { visible: false, reason: 'observer_daylight' };
  }

  if (input.satelliteEclipsed) {
    return { visible: false, reason: 'satellite_eclipsed' };
  }

  return { visible: true, reason: null };
}
