import { create } from 'zustand';

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
  // Renderer / GPU diagnostics (from WebGLRenderer.info)
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  gpu: string;
}

interface DevState {
  visible: boolean;
  report: ValidationReport | null;
  toggle: () => void;
  setReport: (r: ValidationReport) => void;
}

export const useDevStore = create<DevState>((set) => ({
  visible: false,
  report: null,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setReport: (report) => set({ report }),
}));
