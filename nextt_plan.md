# JPL Horizons API Integration — Deep-Space Object Tracking

Track Artemis 2 and similar deep-space objects (lunar missions) alongside the existing 30k+ satellite catalog, rendered simultaneously in the same 3D scene.

## Scope & Key Decisions

- **Lunar missions only** — the current camera (`near=0.01, far=1000`) already covers the Moon at ~60 ER. No log-depth migration, no shader changes, no GPU risk
- **Interplanetary is a future feature** requiring a heliocentric scene-scale switch — not a bigger frustum
- Deep-space objects render as `THREE.Points` with a `"deep_space"` category color + distance-aware size multiplier. No extra draw calls

> [!WARNING]
> **JPL Horizons is a public API with no auth key.** The backend proxy + 24-hour cache ensures we never hit it from the browser directly. If Horizons is down, deep-space objects simply won't appear (graceful degradation).

---

## Proposed Changes

### Phase 1: Data Types & Store

#### [MODIFY] [types.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/data/types.ts)

- Add `DeepSpaceObject` interface: `horizonsId`, `noradId?`, `name`, `source: 'horizons'`, metadata (mission, target body)
- Add `TrackedObject = EnrichedTLEObject | DeepSpaceObject` discriminated union via `source: 'tle' | 'horizons'`
- Extend [ObjectCategory](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/data/types.ts#7-8) with `'deep_space'`, [OrbitalRegime](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/data/types.ts#8-9) with `'LUNAR'`
- Add `HorizonsWorkerInMessage` / `HorizonsWorkerOutMessage` types

#### [MODIFY] [useStore.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/store/useStore.ts)

- Add `deepSpaceObjects: DeepSpaceObject[]`, generalize `selectedSatellite` to `TrackedObject | null`

---

### Phase 2: Backend — Horizons Proxy

#### [NEW] [horizons.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/backend/src/services/horizons.ts)

- `fetchHorizonsVectors(commandId, start, stop, step)` → `{ epoch, x, y, z, vx, vy, vz }[]` (km, km/s, J2000 Earth-centered)
- Parses `$$SOE`…`$$EOE` block from Horizons text response

#### [NEW] [horizons-cache.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/backend/src/cache/horizons-cache.ts)

- File-based JSON cache, **24-hour TTL**

#### [NEW] [deep-space-catalog.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/backend/src/services/deep-space-catalog.ts)

- Static config:
  ```ts
  { horizonsId: '-1024', noradId: 99999, name: 'Artemis II (Orion)', category: 'deep_space', regime: 'LUNAR' }
  ```
- Exports `deepSpaceNoradIds: Set<number>` for dedup

> [!IMPORTANT]
> **NORAD ID Deduplication.** Deep-space objects may appear in Space-Track's TLE catalog. If both pipelines ingest the same object, SGP4 produces garbage for the lunar trajectory — two dots, one wrong. The TLE pipeline must **exclude** any NORAD IDs in the deep-space catalog.

#### [MODIFY] TLE pipeline (classifier/enrichment step)

- Filter out NORAD IDs in `deepSpaceNoradIds` before writing to TLE cache

#### [NEW] [horizons.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/backend/src/routes/horizons.ts)

- `GET /api/horizons/catalog` — list of tracked deep-space objects
- `GET /api/horizons/ephemeris/:commandId` — cached vectors for next 24h at 10-min intervals

#### [MODIFY] [index.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/backend/src/index.ts)

- Register `horizonsRouter` at `/api/horizons`

---

### Phase 3: Frontend — Horizons Worker

#### [NEW] [horizons.worker.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/workers/horizons.worker.ts)

1. Receives ephemeris table (`{ epoch, x, y, z, vx, vy, vz }[]`, J2000 frame)
2. **J2000 → TEME conversion:** IAU 1980 precession + nutation rotation matrix (one 3×3 multiply per object per tick). Required because SGP4 outputs TEME — at lunar distance, the J2000/TEME offset is **~2,400 km** (~one Moon-diameter)
3. **Hermite interpolation** using position + velocity as tangents for smooth curved motion between 10-min ephemeris points
4. **Proactive refresh:** Posts `NEEDS_REFRESH` when within 2h of window expiry. Marks invalid if fully outside window
5. Same output format as SGP4 worker: `Float32Array` (Earth radii) + `Uint8Array` valid flags
6. Same double-buffered Transferable pattern

#### [NEW] [HorizonsLoader.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/data/HorizonsLoader.ts)

- Fetches `/api/horizons/catalog` + `/api/horizons/ephemeris/:id`, graceful on 503/error

---

### Phase 4: Renderer & Engine

#### [MODIFY] [Engine.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/Engine.ts)

- Init Horizons worker alongside SGP4 worker in [initWorker()](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/Engine.ts#175-392)
- **Slot allocation:** TLE = indices `0..N-1`, deep-space = `N..N+M-1` in same buffer
- Merge Horizons `POSITIONS` into SatelliteRenderer buffer at deep-space offset
- Extend `GPUPicker` range and `catalogData` to include deep-space objects

#### [MODIFY] [CameraController.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/CameraController.ts)

- `followOffsetDist` clamped to max `2.0` ER — at lunar distance (59 ER) the camera would be glued to the craft. Scale the clamp for deep-space altitudes

#### [MODIFY] [SatelliteRenderer.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/SatelliteRenderer.ts)

- `updateDeepSpacePositions(positions, validFlags, count, startIndex)` — writes into buffer at offset
- `CATEGORY_COLORS.deep_space` (e.g., vivid magenta `[0.9, 0.2, 0.8]`), large size multiplier
- **Visibility filter bypass:** [applyVisibilityAndFilters()](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/SatelliteRenderer.ts#180-271) has a 2000km cutoff + 10° elevation gate that would hide every deep-space object in radio/visual mode. `deep_space` category skips these filters

---

### Phase 5: UI

#### [MODIFY] Info Card — detect `source === 'horizons'`, show mission-specific fields
#### [MODIFY] Search — include deep-space objects in Fuse.js index
#### [MODIFY] Filter Panel — add `deep_space` category + `LUNAR` regime

---

### Phase 6: Orbit Trail

#### [MODIFY] [OrbitTrailRenderer.ts](file:///Users/rehaandelmotra/Projects/orbitwatch/packages/frontend/src/engine/OrbitTrailRenderer.ts)

- `generateFromVectors(points[])` using `THREE.CatmullRomCurve3` for smooth paths from sparse ephemeris

---

## Verification Plan

### Automated Tests

1. **Horizons parser** — mock `$$SOE`…`$$EOE` response, assert correct extraction
2. **Hermite interpolation** — assert midpoint matches analytical formula, test boundary edge cases

### Manual Verification

3. Search "Artemis" → appears in results, info card shows Horizons-specific fields
4. Dot visible in scene at correct distance from Earth
5. Fly-to → camera animates out, Earth visible as small sphere in background
6. No duplicate dot (NORAD dedup working — SGP4 doesn't also render it)
7. Existing 30k satellites unaffected — picking, trails, filters all work
8. Block `/api/horizons/*` → app loads normally, deep-space section simply empty
