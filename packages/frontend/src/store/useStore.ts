import { create } from 'zustand';
import type { EnrichedTLEObject, DeepSpaceObject, ObjectCategory, OrbitalRegime } from '../data/types';

export type LoadingPhase = 'fetching' | 'initializing' | 'propagating' | 'ready';
export type CameraMode = 'free' | 'flying' | 'following' | 'returning';
export type VisibilityMode = 'all' | 'radio' | 'visual';

interface AppState {
  loadingPhase: LoadingPhase;
  loadingError: string | null;
  cameraMode: CameraMode;
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  dataVersion: string | null;
  dataTimestamp: number | null;

  catalogData: EnrichedTLEObject[];
  selectByIndex: ((index: number) => void) | null;
  triggerFlyTo: ((index: number) => void) | null;
  triggerResetCamera: (() => void) | null;

  selectedIndex: number | null;
  selectedSatellite: EnrichedTLEObject | null;
  selectedAltitude: number | null;
  showOrbitTrail: boolean;

  // Deep-space object selection (separate from TLE selection)
  dsoData: DeepSpaceObject[];
  selectedDSOIndex: number | null;
  selectedDSO: DeepSpaceObject | null;
  selectedDSOAltitude: number | null;
  selectDSOByIndex: ((index: number) => void) | null;
  triggerFlyToDSO: ((index: number) => void) | null;

  hoveredName: string | null;
  hoverScreenX: number;
  hoverScreenY: number;

  clusterItems: { index: number; data: EnrichedTLEObject; altitude: number }[];
  clusterScreenX: number;
  clusterScreenY: number;

  observerLocation: { lat: number; lon: number; alt: number } | null;
  visibilityMode: VisibilityMode;

  categoryFilters: Record<ObjectCategory, boolean>;
  regimeFilters: Record<OrbitalRegime, boolean>;
  regimeCounts: Record<OrbitalRegime, number>;
  visibleCategoryCounts: Record<ObjectCategory, number>;
  visibleRegimeCounts: Record<OrbitalRegime, number>;

  setCameraMode: (mode: CameraMode) => void;
  setTriggerFlyTo: (fn: (index: number) => void) => void;
  setTriggerResetCamera: (fn: () => void) => void;
  setLoadingPhase: (phase: LoadingPhase) => void;
  setLoadingError: (error: string) => void;
  setCatalogInfo: (info: {
    objectCount: number;
    categoryCounts: Record<ObjectCategory, number>;
    regimeCounts: Record<OrbitalRegime, number>;
    version: string;
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
  setDSOData: (data: DeepSpaceObject[]) => void;
  setSelectDSOByIndex: (fn: (index: number) => void) => void;
  setSelectedDSO: (index: number | null, data: DeepSpaceObject | null, altitude?: number | null) => void;
  setTriggerFlyToDSO: (fn: (index: number) => void) => void;
}

export const useStore = create<AppState>((set) => ({
  loadingPhase: 'fetching',
  loadingError: null,
  cameraMode: 'free',
  objectCount: 0,
  categoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  dataVersion: null,
  dataTimestamp: null,

  catalogData: [],
  selectByIndex: null,
  triggerFlyTo: null,
  triggerResetCamera: null,

  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  showOrbitTrail: false,

  dsoData: [],
  selectedDSOIndex: null,
  selectedDSO: null,
  selectedDSOAltitude: null,
  selectDSOByIndex: null,
  triggerFlyToDSO: null,

  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,

  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,

  observerLocation: null,
  visibilityMode: 'all',

  categoryFilters: {
    active_satellite: true,
    inactive_satellite: true,
    rocket_body: true,
    debris: true,
    unknown: true,
    deep_space: true,
  },
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true, LUNAR: true },
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0, LUNAR: 0 },
  visibleCategoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
    deep_space: 0,
  },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0, LUNAR: 0 },

  setCameraMode: (mode) => set({ cameraMode: mode }),
  setTriggerFlyTo: (fn) => set({ triggerFlyTo: fn }),
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
      dataVersion: info.version,
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
      // Clear DSO selection when selecting a TLE satellite
      ...(index !== null ? { selectedDSOIndex: null, selectedDSO: null, selectedDSOAltitude: null } : {}),
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
  setDSOData: (data) => set({ dsoData: data }),
  setSelectDSOByIndex: (fn) => set({ selectDSOByIndex: fn }),
  setSelectedDSO: (index, data, altitude) =>
    set((state) => ({
      selectedDSOIndex: index,
      selectedDSO: data,
      selectedDSOAltitude: altitude ?? null,
      showOrbitTrail: false,
      // Clear TLE selection when selecting a DSO
      ...(index !== null ? { selectedIndex: null, selectedSatellite: null, selectedAltitude: null } : {}),
      // Deselecting DSO during tracking: smooth return
      ...(index === null && (state.cameraMode === 'flying' || state.cameraMode === 'following')
        ? { cameraMode: 'returning' as CameraMode }
        : {}),
    })),
  setTriggerFlyToDSO: (fn) => set({ triggerFlyToDSO: fn }),
}));
