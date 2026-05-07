import { create } from 'zustand';
import type { AwarenessSnapshot } from '../worldmodel/types';

export type { AwarenessSnapshot };

export interface ValidationReport {
  issAltitudeKm: number | null;
  issAltitudeOk: boolean;
  geoAvgMagnitude: number;
  geoCount: number;
  geoOk: boolean;
  insideEarthCount: number;
  insideEarthOk: boolean;
  totalLoaded: number;
  totalValid: number;
  propagationFailures: number;
  workerTickMs: number;
  frameTimeMs: number;
  fps: number;
}

interface DevState {
  visible: boolean;
  report: ValidationReport | null;
  worldModelSnapshot: AwarenessSnapshot | null;
  toggle: () => void;
  setReport: (r: ValidationReport) => void;
  setWorldModelSnapshot: (s: AwarenessSnapshot) => void;
}

export const useDevStore = create<DevState>((set) => ({
  visible: false,
  report: null,
  worldModelSnapshot: null,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setReport: (report) => set({ report }),
  setWorldModelSnapshot: (worldModelSnapshot) => set({ worldModelSnapshot }),
}));
