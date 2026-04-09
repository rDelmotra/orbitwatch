# Final Plan: OrbitWatch DSO Pipeline v1

## Summary

Add a fully separate DSO pipeline that ingests ephemeris from JPL Horizons on the
backend, converts it from geocentric J2000/ICRF to TEME during normalization,
publishes versioned JSON snapshots to local disk, and renders DSOs in the frontend
through a dedicated renderer and unified app-layer selection/search flow.

This plan keeps the existing TLE pipeline unchanged. DSOs are operationally separate
from Space-Track/CelesTrak, but appear as first-class tracked objects in the product.

### Core decisions locked for v1

- Separate DSO worker process, not started from Express
- Local-disk cache under `data/dso/`
- Horizons REST only in v1; SPICE-ready provider seam for later
- Backend frame conversion: J2000/ICRF → TEME
- Scene units: Earth radii
- Separate DSO renderer with always-visible labeled markers
- DSOs do **not** use the current TLE catalog shader
- Unified picking/search/store contract across TLE + DSO

---

## Implementation Changes

### 1. Backend contracts and registry

Use the existing DSO scaffold already in the repo and keep the split namespace:

- `packages/backend/src/dso/registry/types.ts`
- `packages/backend/src/dso/providers/types.ts`
- `packages/backend/src/dso/normalize/types.ts`
- `packages/backend/src/dso/snapshot/types.ts`

**Add:**

- `packages/backend/src/dso/registry/entries.ts`

Extend the existing DSO-local types so they fully represent:

- `DsoRegistryEntry`
- `ProviderFetchResult`
- `DsoFreshnessState`
- `DsoSnapshot`
- `DsoCatalogEntry`
- `DsoManifest`
- `DsoObjectStatus`

**Registry contents for v1:**

- **Enabled:** `jwst`, `dscovr`, `lro`
- **Present but disabled:** `artemis-ii`, `chandrayaan3`
  - `artemis-ii` remains disabled until Horizons ID and coverage are verified
  - `chandrayaan3` remains disabled until Horizons coverage is explicitly confirmed

Each registry entry must include:

- `dsoId`, `slug`, `displayName`, `provider`, `providerObjectId`, `enabled`
- `targetBody`, `regime`, `sampleStepSec`, `refreshIntervalSec`
- `validPastWindowSec`, `validFutureWindowSec`
- `mission`, `description`, `launchDate`, `searchAliases`

**Defaults:**

| Field | Value |
|---|---|
| `sampleStepSec` | 600 |
| `refreshIntervalSec` | 21600 |
| `validPastWindowSec` | 21600 |
| `validFutureWindowSec` | 259200 |

---

### 2. Shared utility extraction

**Add:**

- `packages/backend/src/utils/atomic-write.ts`

Implement one generic helper only:

- `atomicWriteJson(path, data)`

Rules:

- Write to `*.tmp`
- Rename atomically
- Create parent directories as needed

> [!IMPORTANT]
> Do **not** modify `packages/backend/src/cache/file-cache.ts` in this phase set.
> TLE cache keeps its own inline write logic.

---

### 3. Horizons provider adapter

**Add:**

- `packages/backend/src/dso/providers/horizons.ts`
- `packages/backend/src/dso/providers/factory.ts`

Use the existing `packages/backend/src/dso/providers/types.ts` for the provider contract:

```ts
fetchEphemeris(entry, windowStart, windowEnd): Promise<ProviderFetchResult>
```

**Horizons adapter behavior:**

- Request geocentric J2000/ICRF state vectors
- One outbound Horizons request at a time across the worker
- Timeout: 30 seconds
- Typed errors:
  - `HorizonsNetworkError`
  - `HorizonsParseError`
  - `HorizonsThrottleError`
  - `HorizonsObjectNotFoundError`
- Output km and km/s in source-native frame with metadata only; **no normalization here**

---

### 4. Backend normalization and validation

**Add:**

- `packages/backend/src/dso/normalize/convert.ts`
- `packages/backend/src/dso/normalize/validate.ts`

**Normalization contract:**

- Input: `ProviderFetchResult`
- Output: `DsoSnapshot`

**Normalization steps:**

1. Confirm ascending timestamps
2. Clip to requested validity window
3. Convert J2000/ICRF → TEME per sample timestamp
4. Convert km → earth_radii
5. Convert km/s → earth_radii_per_second
6. Publish `sourceFrame: 'J2000'`, `frame: 'TEME'`

**Frame conversion implementation:**

- Use Vallado-style TEME/ECI transformation with IAU 1976 precession + IAU 1980 nutation
- Port a published/reference formulation exactly; **do not improvise matrix order**
- Invert the published TEME-to-ECI path for J2000 → TEME
- Rotate position with `C(t)`
- Rotate velocity with `C(t) * v + Ċ(t) * r`
- Compute `Ċ(t)` numerically with a small central difference to avoid hand-derived mistakes
- Keep this logic backend-only

**Validation rules:**

- Minimum 2 samples
- Strictly ascending timestamps
- No duplicate timestamps
- No NaN or Infinity
- `validFrom < validTo`
- Cadence matches `sampleStepSec` within tolerance
- Max snapshot size guard: 5 MB
- Reject invalid snapshots before publish

---

### 5. Snapshot store and publish protocol

**Add:**

- `packages/backend/src/dso/snapshot/store.ts`

**Storage layout:**

```
data/dso/
  catalog.json
  manifest.json
  snapshots/
    jwst/
      2026-04-08T120000Z.json
      2026-04-08T060000Z.json
      2026-04-08T000000Z.json    (3 generations retained)
    lro/
      ...
```

**Publish sequence:**

1. Write `snapshots/<dsoId>/<version>.json.tmp`
2. Rename to `.../<version>.json`
3. Build new catalog and manifest in memory
4. Write `catalog.json.tmp`
5. Rename to `catalog.json`
6. Write `manifest.json.tmp`
7. Rename to `manifest.json` (**last**)
8. Prune older snapshots, retaining latest 3 successful generations per DSO

**Manifest rules:**

- Preserve last good snapshot on failure
- Update `lastFailureAt`, `failureCount`, `freshnessState`
- Freshness states: `fresh` → `stale` → `degraded` → `unavailable`

---

### 6. DSO worker process

**Add:**

- `packages/backend/src/dso-worker.ts`

**Modify:**

- `packages/backend/package.json`

Add scripts:

```json
"dso-worker": "tsx watch src/dso-worker.ts",
"dso-worker:start": "node dist/dso-worker.js"
```

**Worker behavior:**

- Load registry
- Read existing manifest if present
- Run immediate reconcile on startup
- Then run periodic reconcile with jitter of ±10% of the shortest active refresh interval
- Process objects sequentially
- Horizons calls remain serialized globally

**Per-object refresh if:**

- No successful snapshot exists
- `lastSuccessAt + refreshIntervalSec <= now`
- Current `validTo` is within one refresh interval of now

**Per-object flow:**

1. Fetch
2. Normalize
3. Validate
4. Publish
5. Update manifest

**On failure:**

- Keep current published snapshot
- Increment failure count
- Recompute freshness
- Continue with the next DSO

---

### 7. Backend API

**Add:**

- `packages/backend/src/routes/dso.ts`

**Modify:**

- `packages/backend/src/index.ts`

**Mount:** `/api/dso`

**Endpoints:**

| Route | Response | Cache-Control | ETag | Error codes |
|---|---|---|---|---|
| `GET /api/dso/catalog` | `catalog.json` | `public, max-age=300` | `catalogVersion` | 503 if never published |
| `GET /api/dso/manifest` | `manifest.json` | `public, max-age=60` | `generatedAt` | 503 if never published |
| `GET /api/dso/ephemeris/:dsoId` | snapshot JSON | `public, max-age=3600` | `snapshotVersion` | 404 unknown/disabled, 503 no snapshot |

Extend `/health` with DSO summary:

- Enabled count
- Fresh/stale/degraded/unavailable counts
- `workerLastRunAt`

> [!IMPORTANT]
> Request paths **never** call Horizons.

---

### 8. Frontend data and store

**Add:**

- `packages/frontend/src/data/dso-types.ts`
- `packages/frontend/src/data/dso-client.ts`
- `packages/frontend/src/data/dso-interpolator.ts`

**Modify:**

- `packages/frontend/src/store/useStore.ts`

**Frontend data model:**

- `TrackedObject = EnrichedTLEObject | DsoObject`
- Discriminator: `source: 'tle' | 'dso'`

**Store additions:**

- `dsoObjects`
- `dsoEphemerisById`
- `selectedObject` as `TrackedObject | null`
- DSO category/filter state

**Client behavior:**

- Fetch `/api/dso/catalog`
- Fetch `/api/dso/ephemeris/:dsoId` for enabled DSOs
- Merge DSO catalog with TLE catalog at the app layer, **not on the backend**

**Interpolation:**

- Binary search bracket
- Linear interpolation between adjacent samples
- Main thread only; no dedicated worker for v1

---

### 9. Frontend DSO renderer and app integration

**Add:**

- `packages/frontend/src/engine/DsoRenderer.ts`
- `packages/frontend/src/shaders/dso.vert.glsl`
- `packages/frontend/src/shaders/dso.frag.glsl`

**Modify:**

- `packages/frontend/src/engine/Engine.ts`
- `packages/frontend/src/engine/CameraController.ts`

**Renderer rules:**

- Separate `THREE.Points` geometry from the TLE cloud
- No TLE distance-fade shader reuse
- Always-visible minimum point size
- Labeled markers for DSOs
- Color: cyan/teal
- Integrate into the same pick ID space as TLE objects using a TLE-count offset

**Engine rules:**

- GPUPicker returns one global object index
- Engine resolves index to TLE or DSO by range
- Search includes TLE + DSO objects in one Fuse index
- Fly-to, selection, info card, and orbit trail dispatch by `source`

**Camera change:**

- `controls.maxDistance`: 100 → 300
- No far-plane change

---

### 10. UI integration

**Modify:**

- `packages/frontend/src/ui/FilterPanel.tsx`
- `packages/frontend/src/ui/InfoCard.tsx`
- `packages/frontend/src/ui/SearchBar.tsx`
- `packages/frontend/src/ui/HUD.tsx`

**UI behavior:**

- Add a Deep Space filter
- DSO info card shows mission/provider/freshness/distance
- Search includes DSO aliases and names
- HUD shows DSO count
- User interaction remains unified even though rendering/data pipelines are separate

---

## Test Plan

### Unit tests

- DSO registry lookup and enabled filtering
- Horizons parser and error classification
- J2000 → TEME conversion against golden/reference vectors
- Round-trip or comparative checks for frame conversion to catch matrix-order/sign bugs
- Normalization, clipping, and unit conversion
- Validation failures: duplicates, NaN, wrong cadence, oversized payload
- Snapshot publish atomicity and 3-generation retention
- Manifest freshness transitions
- Frontend DSO interpolator edge cases

### Integration tests

- Worker startup, first publish, refresh-over-existing, failure preservation, and per-object isolation
- DSO API status codes and ETags

### Manual checks

- JWST visible near ~235 ER
- LRO visible near lunar distance
- Stale data still serves if worker stops
- TLE pipeline remains unaffected
- DSO click/search/info-card flows work end-to-end

---

## Assumptions and Defaults

- Keep the existing backend DSO scaffold and extend it; do not collapse it into flatter file layout
- Do not introduce a database in v1
- Do not modify the current TLE cache module as part of shared utility extraction
- Do not treat J2000 as "close enough" to TEME; backend conversion is required
- Do not implement SPICE in v1, but keep the provider seam ready for it
- DSO v1 ships only after the frame conversion is validated against trusted reference vectors

---

## Frame Conversion

OrbitWatch requests J2000/ICRF geocentric state vectors from Horizons and converts
them to TEME on the backend during normalization (IAU 1976 precession + IAU 1980
nutation, Vallado-style formulation). The frontend receives TEME coordinates — the
same frame SGP4 outputs — so no frame mismatch exists at the rendering layer.

The conversion is performed per-sample in `dso/normalize/convert.ts`:

- Position: `r_TEME = C(t) · r_J2000`
- Velocity: `v_TEME = C(t) · v_J2000 + Ċ(t) · r_J2000`
- `Ċ(t)` computed via central difference (no hand-derived matrix differentiation)
- No external SOFA/ERFA dependency required for the precision level needed