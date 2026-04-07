# JPL Horizons Integration — Deep-Space Object Tracking

## Context

Orbitwatch currently tracks ~30k TLE-based satellites via SGP4. The goal is to add **deep-space lunar mission tracking** (starting with Artemis II) using JPL Horizons API ephemeris data, rendered in the same THREE.js scene alongside the existing catalog. This is scoped to lunar-only — the existing camera frustum (`far=1000`) already covers the Moon at ~60 Earth radii.

---

## Implementation Order

### Step 1: Shared Types

**Backend** — `packages/backend/src/types/index.ts`
- Add `'deep_space'` to `ObjectCategory` union (line 115-120)
- Add `'LUNAR'` to `OrbitalRegime` union (line 122)
- Add interfaces: `DeepSpaceCatalogEntry`, `HorizonsEphemerisPoint`, `HorizonsEphemerisResponse`

**Frontend** — `packages/frontend/src/data/types.ts`
- Add `'deep_space'` to `ObjectCategory` (line 7)
- Add `'LUNAR'` to `OrbitalRegime` (line 8)
- Add `DeepSpaceObject` interface with `source: 'horizons'` discriminant
- Add `TrackedObject = (EnrichedTLEObject & { source?: 'tle' }) | DeepSpaceObject`
- Add `HorizonsWorkerInMessage` / `HorizonsWorkerOutMessage` types

### Step 2: Deep-Space Catalog (Backend)

**Create** `packages/backend/src/services/deep-space-catalog.ts`
- Static `DEEP_SPACE_OBJECTS` array — starts with Artemis II (`horizonsId: '-1024'`, `noradId: 99999`)
- Export `deepSpaceNoradIds: Set<number>` for TLE dedup
- Adding future missions = adding one entry here

### Step 3: TLE Pipeline NORAD Dedup

**Modify** `packages/backend/src/cron/tle-updater.ts`
- Import `deepSpaceNoradIds` from deep-space-catalog
- Filter out matching NORAD IDs in both `buildFromSpaceTrack()` and `buildFromCelesTrak()` enrichment loops
- Prevents SGP4 producing garbage trajectories for deep-space objects

### Step 4: Horizons Service + Cache (Backend)

**Create** `packages/backend/src/services/horizons.ts`
- `fetchHorizonsVectors(commandId, start, stop, stepMinutes)` → `HorizonsEphemerisPoint[]`
- Calls `https://ssd.jpl.nasa.gov/api/horizons.api` with `EPHEM_TYPE=VECTORS`, `CENTER='500@399'`, `REF_SYSTEM=J2000`, `STEP_SIZE='10 m'`
- Parses `$$SOE`...`$$EOE` text block (regex on multi-line records)
- **Key decision: Convert J2000→TEME on the backend**, not in the frontend worker. This eliminates complex IAU 1980 precession+nutation math from the worker. The backend runs this once per 24h per object — negligible cost. The worker then receives TEME vectors directly and only does Hermite interpolation.
- 30s fetch timeout, throws on error

**Create** `packages/backend/src/cache/horizons-cache.ts`
- Reuse atomic write pattern from `cache/file-cache.ts`
- `isHorizonsCacheFresh(commandId)`, `readHorizonsCache(commandId)`, `writeHorizonsCache(commandId, data)`
- 24h TTL, files at `data/horizons-{commandId}.json`

### Step 5: Horizons API Routes (Backend)

**Create** `packages/backend/src/routes/horizons.ts`
- `GET /api/horizons/catalog` — returns deep-space catalog array
- `GET /api/horizons/ephemeris/:commandId` — reads from cache only. Returns 503 if cache is missing/stale (never hits JPL on request path). Safe for 10k+ concurrent users — every request reads the same pre-warmed file.

**Create** `packages/backend/src/cron/horizons-updater.ts`
- Runs at startup + every 12h (well within 24h TTL, giving buffer for JPL downtime)
- For each entry in `DEEP_SPACE_OBJECTS`: call `fetchHorizonsVectors()`, write to cache atomically
- On JPL failure: log error, retain stale cache (graceful degradation — stale ephemeris is better than no ephemeris for objects moving slowly at lunar distance)
- Register in `index.ts` alongside the existing TLE updater cron

**Modify** `packages/backend/src/index.ts`
- Register `horizonsRouter` at `/api/horizons` (after TLE route registration, line ~49)

### Step 6: Horizons Worker (Frontend)

**Create** `packages/frontend/src/workers/horizons.worker.ts`
- Same double-buffered Transferable pattern as `sgp4.worker.ts`
- `INIT`: receives TEME ephemeris arrays per object + `startIndex`
- `PROPAGATE`: Hermite cubic interpolation between bracketing 10-min ephemeris points:
  - `h00 = 2t^3 - 3t^2 + 1`, `h10 = t^3 - 2t^2 + t`, `h01 = -2t^3 + 3t^2`, `h11 = t^3 - t^2`
  - Uses velocity as tangent vectors (scaled by dt in seconds)
- Outputs `Float32Array` positions (Earth radii, TEME) + `Uint8Array` validFlags
- Posts `NEEDS_REFRESH` when within 2h of ephemeris window expiry

### Step 7: HorizonsLoader (Frontend)

**Create** `packages/frontend/src/data/HorizonsLoader.ts`
- `fetchDeepSpaceCatalog()` → `DeepSpaceObject[]` (returns `[]` on error)
- `fetchEphemeris(commandId)` → ephemeris response or null
- `fetchAllEphemeris(catalog)` → parallel fetch all, filter failures

### Step 8: Store Changes (Frontend)

**Modify** `packages/frontend/src/store/useStore.ts`
- Widen `selectedSatellite` type: `EnrichedTLEObject | null` → `TrackedObject | null`
- Widen `catalogData`, `clusterItems`, `setSelectedSatellite`, `setCluster`, `setCatalogData` to accept `TrackedObject`
- Add `deep_space: true` to `categoryFilters` (line 112-118)
- Add `LUNAR: true` to `regimeFilters` (line 119)
- Add `deep_space: 0` / `LUNAR: 0` to all count records (lines 81-87, 120-128)

### Step 9: Engine Integration (Frontend) — Critical Path

**Modify** `packages/frontend/src/engine/Engine.ts`

1. **Parallel fetch** in `initWorker()`: add `fetchDeepSpaceCatalog()` to existing `Promise.all`
2. **Unified catalog**: `this.catalogData = [...tleObjects, ...deepSpaceObjects]`. Store `this.tleCount` and `this.deepSpaceCount`
3. **New method `initHorizonsWorker(catalog)`**: fetch all ephemeris, spawn worker, send INIT with `startIndex = tleCount`
4. **POSITIONS handler**: call `satelliteRenderer.updateDeepSpacePositions()` at the deep-space buffer offset
5. **NEEDS_REFRESH handler**: re-fetch ephemeris for listed commandIds, send new INIT to worker. Track `refreshInFlight: Set<string>` to avoid duplicates
6. **Orbit trail**: for deep-space indices (>= tleCount), use `OrbitTrailRenderer.generateFromVectors()` instead of `generate(line1, line2)`
7. **Dispose**: terminate horizons worker, clear interval

### Step 10: SatelliteRenderer Changes (Frontend)

**Modify** `packages/frontend/src/engine/SatelliteRenderer.ts`

- Add `CATEGORY_COLORS.deep_space = [0.9, 0.2, 0.8]` (vivid magenta)
- `initFromCatalog()`: accept unified catalog. Apply larger size multiplier (~3.0) for deep-space objects
- New `updateDeepSpacePositions(positions, validFlags, count, startIndex)`: writes only the deep-space slice of the buffer, same axis swap
- `applyVisibilityAndFilters()`: deep-space category **bypasses** 2000km range cutoff + 10-degree elevation gate (these would hide every lunar object in radio/visual mode). Early continue with full multiplier.

### Step 11: CameraController Fix (Frontend)

**Modify** `packages/frontend/src/engine/CameraController.ts`

- In `flyTo()`: for deep-space altitudes (>10 ER), use a smaller proportional offset: `Math.min(altitude * 0.05, 5.0)` instead of the existing clamp at 2.0 ER

### Step 12: UI Updates (Frontend)

**InfoCard** (`ui/InfoCard.tsx`):
- Detect `source === 'horizons'` on selected object
- Show mission-specific fields (Mission, Target Body) instead of TLE fields (Period, Inclination, etc.)
- Keep: Name, Altitude, fly-to/follow buttons, orbit trail toggle

**SearchBar** (`ui/SearchBar.tsx`):
- `catalogData` already drives Fuse.js index — deep-space objects automatically searchable
- Add `deep_space: '#E633CC'` to category color map

**FilterPanel** (`ui/FilterPanel.tsx`):
- Add `{ key: 'deep_space', label: 'Deep Space', color: '#E633CC' }` to categories
- Add `{ key: 'LUNAR', label: 'Lunar' }` to regimes

### Step 13: Orbit Trail from Vectors (Frontend)

**Modify** `packages/frontend/src/engine/OrbitTrailRenderer.ts`

- New `generateFromVectors(points: {x,y,z}[])`: CatmullRomCurve3 from ephemeris points → sample 360 points → **`THREE.Line`** (not LineLoop). Deep-space trajectories are open paths over a 24h window — they don't close on themselves. LineLoop would connect last point back to first, drawing a spurious straight line across the scene. Magenta trail color.

---

## Key Design Decisions

1. **J2000→TEME on backend** — eliminates IAU 1980 nutation math from frontend worker. Backend does it once per 24h.
2. **Separate Horizons worker** — clean separation from SGP4 worker. No hybrid message types.
3. **Unified catalog array** — TLE at [0..N-1], deep-space at [N..N+M-1]. Single index space for picking, search, and selection. MAX_OBJECTS=100k has massive headroom.
4. **Cron-pre-warmed cache** — a dedicated `horizons-updater` cron runs at startup and every 12h. The route handler reads cached files only, never hitting JPL on the request path. Safe for 10k+ concurrent users with no thundering herd on JPL. NEEDS_REFRESH from the frontend worker is now just a signal to display a staleness warning — the cron handles actual refresh.
5. **Graceful degradation** — if Horizons is down, `fetchDeepSpaceCatalog()` returns `[]`, `deepSpaceCount=0`, entire pipeline skipped. TLE unaffected.

---

## Verification

**Automated:**
- Horizons parser: mock `$$SOE`...`$$EOE` response, assert correct vector extraction
- Hermite interpolation: known two-point test, verify midpoint matches formula
- NORAD dedup: verify deep-space NORAD IDs filtered from TLE pipeline

**Manual:**
1. Search "Artemis" → appears with magenta dot
2. Click → InfoCard shows mission fields, not TLE fields
3. Dot visible at ~60 ER from Earth
4. Fly-to → camera animates out, Earth visible as small sphere
5. Follow mode → camera not glued to craft (proper offset scaling)
6. Orbit trail → magenta CatmullRom path renders
7. Toggle deep_space / LUNAR filters → dot appears/disappears
8. Block `/api/horizons/*` → app loads normally, only TLE objects
9. Existing 30k satellites fully unaffected (picking, trails, filters, search)
