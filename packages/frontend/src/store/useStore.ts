import { create } from 'zustand';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '../data/types';
import type { DsoObject, DsoSnapshot } from '../data/dso-types';
import type { VisualListSource, VisualListStatus } from '../data/visualList';
import type { DsoLabelPosition } from '../engine/DsoRenderer';
import { simClock } from '../engine/SimClock';

export type LoadingPhase = 'fetching' | 'initializing' | 'propagating' | 'ready';
export type CameraMode = 'free' | 'flying' | 'following' | 'returning';
export type TrackingStyle = 'follow' | 'joyride';
export type VisibilityMode = 'all' | 'radio' | 'dome';

/** Visibility modes that drive the observer-anchored sky camera (vs the globe view). */
export function isObserverMode(mode: VisibilityMode): boolean {
  return mode === 'dome';
}

/**
 * True only while the camera is actually in the dome observer view — standing on the
 * ground looking up: `free` camera + `dome` mode + a known observer location. Joyride
 * and fly-to flip `cameraMode` away from `free` (the observer rig exits), so this gates
 * the dome **visuals** (gradient sky, hidden Earth surface, compass) off and restores
 * the normal space view — keeping visuals in lockstep with the camera, no race.
 */
export function isDomeView(s: {
  cameraMode: CameraMode;
  visibilityMode: VisibilityMode;
  observerLocation: { lat: number; lon: number; alt: number } | null;
}): boolean {
  return s.cameraMode === 'free' && s.visibilityMode === 'dome' && s.observerLocation !== null;
}

export interface VisualListState {
  status: VisualListStatus;
  version: string | null;
  source: VisualListSource;
  stale: boolean;
  count: number;
  updatedAt: number | null;
  message: string | null;
}

interface AppState {
  loadingPhase: LoadingPhase;
  loadingError: string | null;
  cameraMode: CameraMode;
  trackingStyle: TrackingStyle;
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  dataTimestamp: number | null;

  catalogData: EnrichedTLEObject[];
  selectByIndex: ((index: number) => void) | null;
  triggerFlyTo: ((index: number) => void) | null;
  triggerJoyride: ((index: number) => void) | null;
  triggerResetCamera: (() => void) | null;

  selectedIndex: number | null;
  selectedSatellite: EnrichedTLEObject | null;
  selectedAltitude: number | null;
  showOrbitTrail: boolean;

  // DSO state
  dsoObjects: DsoObject[];
  dsoEphemerisById: Record<string, DsoSnapshot>;
  selectedDso: DsoObject | null;
  dsoLabelPositions: DsoLabelPosition[];
  triggerFlyToDso: ((dsoId: string) => void) | null;
  triggerJoyrideDso: ((dsoId: string) => void) | null;

  hoveredName: string | null;
  hoverScreenX: number;
  hoverScreenY: number;

  clusterItems: { index: number; data: EnrichedTLEObject; altitude: number }[];
  clusterScreenX: number;
  clusterScreenY: number;

  observerLocation: { lat: number; lon: number; alt: number } | null;
  visibilityMode: VisibilityMode;
  /** Dome-mode gaze heading (radians, from North toward East); drives the HUD compass. */
  observerHeadingRad: number;
  visualList: VisualListState;

  categoryFilters: Record<ObjectCategory, boolean>;
  regimeFilters: Record<OrbitalRegime, boolean>;
  regimeCounts: Record<OrbitalRegime, number>;
  visibleCategoryCounts: Record<ObjectCategory, number>;
  visibleRegimeCounts: Record<OrbitalRegime, number>;

  setCameraMode: (mode: CameraMode) => void;
  setTrackingStyle: (style: TrackingStyle) => void;
  setTriggerFlyTo: (fn: (index: number) => void) => void;
  setTriggerJoyride: (fn: (index: number) => void) => void;
  setTriggerResetCamera: (fn: () => void) => void;
  setLoadingPhase: (phase: LoadingPhase) => void;
  setLoadingError: (error: string) => void;
  setCatalogInfo: (info: {
    objectCount: number;
    categoryCounts: Record<ObjectCategory, number>;
    regimeCounts: Record<OrbitalRegime, number>;
  }) => void;
  toggleCategoryFilter: (category: ObjectCategory) => void;
  toggleRegimeFilter: (regime: OrbitalRegime) => void;
  setVisibleCounts: (
    catCounts: Record<ObjectCategory, number>,
    regCounts: Record<OrbitalRegime, number>,
  ) => void;
  setCatalogData: (data: EnrichedTLEObject[]) => void;
  setSelectByIndex: (fn: (index: number) => void) => void;
  setSelectedSatellite: (
    index: number | null,
    data: EnrichedTLEObject | null,
    altitude?: number | null,
  ) => void;
  setShowOrbitTrail: (show: boolean) => void;
  setHover: (name: string | null, screenX?: number, screenY?: number) => void;
  setCluster: (items: { index: number; data: EnrichedTLEObject; altitude: number }[], screenX: number, screenY: number) => void;
  clearCluster: () => void;
  setObserverLocation: (loc: { lat: number; lon: number; alt: number } | null) => void;
  setVisibilityMode: (mode: VisibilityMode) => void;
  setObserverHeadingRad: (rad: number) => void;
  setVisualListState: (state: VisualListState) => void;

  // Simulation clock (UI mirrors — simClock is source of truth)
  simRate: number;
  simTimeMs: number;
  triggerSimTimeJump: (() => void) | null;
  setSimRate: (rate: number) => void;
  setSimTimeMs: (ms: number) => void;
  jumpToSimTime: (date: Date) => void;
  resetSimClock: () => void;
  setTriggerSimTimeJump: (fn: () => void) => void;

  // DSO actions
  setDsoObjects: (objects: DsoObject[]) => void;
  setDsoEphemeris: (dsoId: string, snapshot: DsoSnapshot) => void;
  setSelectedDso: (dso: DsoObject | null) => void;
  clearDsoEphemeris: (dsoId: string) => void;
  setDsoLabelPositions: (positions: DsoLabelPosition[]) => void;
  setTriggerFlyToDso: (fn: (dsoId: string) => void) => void;
  setTriggerJoyrideDso: (fn: (dsoId: string) => void) => void;
}

export const useStore = create<AppState>((set) => ({
  loadingPhase: 'fetching',
  loadingError: null,
  cameraMode: 'free',
  trackingStyle: 'follow',
  objectCount: 0,
  categoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  dataTimestamp: null,

  catalogData: [],
  selectByIndex: null,
  triggerFlyTo: null,
  triggerJoyride: null,
  triggerResetCamera: null,

  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  showOrbitTrail: false,

  dsoObjects: [],
  dsoEphemerisById: {},
  selectedDso: null,
  dsoLabelPositions: [],
  triggerFlyToDso: null,
  triggerJoyrideDso: null,

  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,

  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,

  observerLocation: null,
  visibilityMode: 'all',
  observerHeadingRad: 0,
  visualList: {
    status: 'loading',
    version: null,
    source: null,
    stale: false,
    count: 0,
    updatedAt: null,
    message: null,
  },

  categoryFilters: {
    active_satellite: true,
    inactive_satellite: true,
    rocket_body: true,
    debris: true,
    unknown: true,
    deep_space: true,
  },
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
  visibleCategoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },

  setCameraMode: (mode) => set({ cameraMode: mode }),
  setTrackingStyle: (style) => set({ trackingStyle: style }),
  setTriggerFlyTo: (fn) => set({ triggerFlyTo: fn }),
  setTriggerJoyride: (fn) => set({ triggerJoyride: fn }),
  setTriggerResetCamera: (fn) => set({ triggerResetCamera: fn }),
  setLoadingPhase: (phase) => set({ loadingPhase: phase }),
  setLoadingError: (error) => set({ loadingError: error }),
  setCatalogInfo: (info) =>
    set({
      objectCount: info.objectCount,
      categoryCounts: info.categoryCounts,
      regimeCounts: info.regimeCounts,
      visibleCategoryCounts: { ...info.categoryCounts },
      visibleRegimeCounts: { ...info.regimeCounts },
      dataTimestamp: Date.now(),
    }),
  toggleCategoryFilter: (category) =>
    set((state) => ({
      categoryFilters: {
        ...state.categoryFilters,
        [category]: !state.categoryFilters[category],
      },
    })),
  toggleRegimeFilter: (regime) =>
    set((state) => ({
      regimeFilters: {
        ...state.regimeFilters,
        [regime]: !state.regimeFilters[regime],
      },
    })),
  setVisibleCounts: (catCounts, regCounts) =>
    set({ visibleCategoryCounts: catCounts, visibleRegimeCounts: regCounts }),
  setCatalogData: (data) => set({ catalogData: data }),
  setSelectByIndex: (fn) => set({ selectByIndex: fn }),
  setSelectedSatellite: (index, data, altitude) =>
    set((state) => ({
      selectedIndex: index,
      selectedSatellite: data,
      selectedAltitude: altitude ?? null,
      showOrbitTrail: false,
      // Clear DSO selection when selecting a TLE object
      ...(index !== null ? { selectedDso: null } : {}),
      // Deselecting during tracking: smooth return to Earth-centered view
      ...(index === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  setShowOrbitTrail: (show) => set({ showOrbitTrail: show }),
  setHover: (name, screenX, screenY) =>
    set({
      hoveredName: name,
      hoverScreenX: screenX ?? 0,
      hoverScreenY: screenY ?? 0,
    }),
  setCluster: (items, screenX, screenY) =>
    set({
      clusterItems: items,
      clusterScreenX: screenX,
      clusterScreenY: screenY,
    }),
  clearCluster: () => set({ clusterItems: [] }),
  setObserverLocation: (loc) => set({ observerLocation: loc }),
  setVisibilityMode: (mode) => set({ visibilityMode: mode }),
  setObserverHeadingRad: (rad) => set({ observerHeadingRad: rad }),
  setVisualListState: (visualList) => set({ visualList }),

  simRate: 1,
  simTimeMs: Date.now(),
  triggerSimTimeJump: null,
  setSimRate: (rate) =>
    set((state) => {
      simClock.setRate(rate);
      state.triggerSimTimeJump?.();
      return { simRate: rate, simTimeMs: simClock.now() };
    }),
  setSimTimeMs: (ms) => set({ simTimeMs: ms }),
  jumpToSimTime: (date) =>
    set((state) => {
      simClock.jumpTo(date);
      state.triggerSimTimeJump?.();
      return { simTimeMs: simClock.now() };
    }),
  resetSimClock: () =>
    set((state) => {
      simClock.reset();
      state.triggerSimTimeJump?.();
      return { simRate: 1, simTimeMs: simClock.now() };
    }),
  setTriggerSimTimeJump: (fn) => set({ triggerSimTimeJump: fn }),

  setDsoObjects: (objects) =>
    set((state) => ({
      dsoObjects: objects,
      categoryCounts: { ...state.categoryCounts, deep_space: objects.length },
    })),
  setDsoEphemeris: (dsoId, snapshot) =>
    set((state) => ({
      dsoEphemerisById: { ...state.dsoEphemerisById, [dsoId]: snapshot },
    })),
  setSelectedDso: (dso) =>
    set((state) => ({
      selectedDso: dso,
      // Clear TLE selection when selecting a DSO
      ...(dso !== null
        ? { selectedIndex: null, selectedSatellite: null, selectedAltitude: null }
        : {}),
      // Deselecting during tracking: smooth return
      ...(dso === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  clearDsoEphemeris: (dsoId) =>
    set((state) => {
      const next = { ...state.dsoEphemerisById };
      delete next[dsoId];
      return { dsoEphemerisById: next };
    }),
  setDsoLabelPositions: (positions) => set({ dsoLabelPositions: positions }),
  setTriggerFlyToDso: (fn) => set({ triggerFlyToDso: fn }),
  setTriggerJoyrideDso: (fn) => set({ triggerJoyrideDso: fn }),
}));

