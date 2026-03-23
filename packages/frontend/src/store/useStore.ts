import { create } from 'zustand';
import type { EnrichedTLEObject, ObjectCategory, OrbitalRegime } from '../data/types';

export type LoadingPhase = 'fetching' | 'initializing' | 'propagating' | 'ready';

interface AppState {
  loadingPhase: LoadingPhase;
  loadingError: string | null;
  objectCount: number;
  categoryCounts: Record<ObjectCategory, number>;
  dataVersion: string | null;
  dataTimestamp: number | null;

  catalogData: EnrichedTLEObject[];
  selectByIndex: ((index: number) => void) | null;

  selectedIndex: number | null;
  selectedSatellite: EnrichedTLEObject | null;
  selectedAltitude: number | null;
  showOrbitTrail: boolean;

  hoveredName: string | null;
  hoverScreenX: number;
  hoverScreenY: number;

  clusterItems: { index: number; data: EnrichedTLEObject; altitude: number }[];
  clusterScreenX: number;
  clusterScreenY: number;

  categoryFilters: Record<ObjectCategory, boolean>;
  regimeFilters: Record<OrbitalRegime, boolean>;
  regimeCounts: Record<OrbitalRegime, number>;
  visibleCategoryCounts: Record<ObjectCategory, number>;
  visibleRegimeCounts: Record<OrbitalRegime, number>;

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
}

export const useStore = create<AppState>((set) => ({
  loadingPhase: 'fetching',
  loadingError: null,
  objectCount: 0,
  categoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
  },
  dataVersion: null,
  dataTimestamp: null,

  catalogData: [],
  selectByIndex: null,

  selectedIndex: null,
  selectedSatellite: null,
  selectedAltitude: null,
  showOrbitTrail: false,

  hoveredName: null,
  hoverScreenX: 0,
  hoverScreenY: 0,

  clusterItems: [],
  clusterScreenX: 0,
  clusterScreenY: 0,

  categoryFilters: {
    active_satellite: true,
    inactive_satellite: true,
    rocket_body: true,
    debris: true,
    unknown: true,
  },
  regimeFilters: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true },
  regimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },
  visibleCategoryCounts: {
    active_satellite: 0,
    inactive_satellite: 0,
    rocket_body: 0,
    debris: 0,
    unknown: 0,
  },
  visibleRegimeCounts: { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 },

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
    set({
      selectedIndex: index,
      selectedSatellite: data,
      selectedAltitude: altitude ?? null,
      showOrbitTrail: false,
    }),
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
}));
