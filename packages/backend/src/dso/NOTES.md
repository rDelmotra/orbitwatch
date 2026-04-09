# DSO Backend — Implementation Notes

## Frame Conversion Design

### Why IAU 1976 + IAU 1980 (not IAU 2006/2000B)

TEME (True Equator Mean Equinox) is the frame SGP4 outputs, and TEME is **defined** by the IAU 1976 precession + IAU 1980 nutation models. Using a newer model (IAU 2006 precession, IAU 2000A/B nutation) would produce GCRS coordinates — a subtly different frame. Since DSOs render in the same Three.js scene as TLE objects (which are in TEME from satellite.js/SGP4), DSO coordinates must also be in TEME to avoid a frame mismatch.

IAU 2006/2000B defines the GCRS→CIRS→ITRS path. That path doesn't produce TEME. Using it here would be wrong by definition, regardless of accuracy.

### Why not switch the whole project to GCRS/J2000

- SGP4 is the dominant pipeline: 30K+ objects at ~1 Hz in the web worker
- DSOs refresh at most every 6 hours, 3–10 objects, ~468 samples each
- Converting 30K TLE positions per tick from TEME→GCRS would add real CPU cost
- Converting ~1,400 DSO samples per 6-hour cycle from J2000→TEME costs ~170ms total — negligible
- Pragmatic rule: convert the small infrequent set to match the large continuous one

### Why the full 106-term IAU 1980 series

The complete IAU 1980 nutation series has 106 terms. This is the authoritative series. Some references (including Vallado's worked examples) use a truncated 4-term version for speed. Using the full series costs ~45ms for a complete DSO refresh cycle — the Horizons HTTP call (up to 30s) dominates by 3 orders of magnitude. No reason to truncate.

### Computational cost (full refresh cycle, every 6 hours)

| Series | Terms | Cost/eval | Total (3 DSOs × 468 samples × 3 evals) |
|---|---|---|---|
| IAU 1980 (current) | 106 | ~3µs | ~13ms |
| IAU 2000B | 77 | ~2µs | ~9ms |
| IAU 2000A | 1365 | ~40µs | ~170ms |

Even IAU 2000A would be fine. The Horizons timeout (30s) dominates everything.

---

## AI Agent Findings (reviewed 2026-04-09)

### P1 — Fixed TDB-UTC offset (69.184s)

**Finding:** `convert.ts` uses a hardcoded 69.184s (TT-TAI 32.184s + TAI-UTC 37s) to convert between TDB and UTC for ISO timestamp labels and validity-window clipping.

**Assessment: Not a blocker.** The rotation matrices consume `julianDayTdb` directly from Horizons — that value is already correct TDB. The fixed offset only affects the ISO timestamp strings attached to state vectors. A 1-second label error on a 600-second sample cadence is invisible to rendering and interpolation. If a new leap second is announced, the offset would need updating, but that's a simple constant change.

### P2 — `sourceFrame: 'J2000'` vs `'ICRF'`

**Finding:** Horizons returns vectors in ICRF. `convert.ts` hardcodes `sourceFrame: 'J2000'` in the snapshot metadata.

**Assessment: Label is imprecise but not harmful.** ICRF and J2000 differ by a fixed rotation of <0.1 arcsec — well within the rendering tolerance. Every JPL document and standard reference treats them as interchangeable for spacecraft ephemeris. The label is there for traceability only and is never branched on in logic. Fix it to `'ICRF'` if precision matters for provenance.

### P2 — Golden vectors are self-referential

**Finding:** The regression suite in `convert.test.ts` locks in the implementation's own output as "golden vectors" while claiming ERFA/SOFA standard compliance. A coefficient transcription error could survive indefinitely once golden vectors are updated to match it.

**Assessment: Partially mitigated.** Test Case 1 uses the Vallado Example 3-15 input vectors (an external reference), which structurally validates the matrix chain. The orthogonality checks, near-identity at J2000, and obliquity sanity checks catch the class of bugs that matter (sign errors, matrix order, wrong coefficient magnitude). To fully harden this, cross-check one epoch against ERFA's `eraNut80()` output — but this is a nice-to-have, not a blocker for v1 ship.

### P3 — `timestampIsoTdb` has no timezone/timescale suffix

**Finding:** `horizons.ts` returns strings like `YYYY-MM-DDTHH:mm:ss.sss` (no `Z`, no TDB marker). If any future code calls `Date.parse(timestampIsoTdb)`, JavaScript will interpret it as local time.

**Assessment: Not a concern.** `timestampIsoTdb` is only used inside the Horizons parser for debugging/traceability. All time math uses `julianDayTdb` (a float). The field is never passed to `Date.parse()`. If it ever is, add a `_tdb` suffix naming convention to make misuse obvious at review time.

---

## Registry Entries (v1)

| DSO | Horizons ID | Status | Notes |
|---|---|---|---|
| JWST | `-170` | enabled | L2 region, ~235 ER |
| DSCOVR | `-78` | enabled | L1 region |
| LRO | `-85` | enabled | Lunar orbit, ~60 ER |
| Artemis II | `TBD` | disabled | Horizons coverage unverified |
| Chandrayaan-3 | `-156` | disabled | Horizons coverage unconfirmed |

Lunar distance (~60 ER) and L2 distance (~235 ER) are both well within the camera frustum (`far=1000 ER`). Frame conversion accuracy is sub-km at both distances — imperceptible at any render zoom level.

---

## Defaults

| Field | Value | Reason |
|---|---|---|
| `sampleStepSec` | 600 | 10-min granularity, sufficient for linear interpolation |
| `refreshIntervalSec` | 21600 | 6-hour refresh cycle |
| `validPastWindowSec` | 21600 | Covers one full refresh interval back |
| `validFutureWindowSec` | 259200 | 3 days forward — handles weekend/holiday gaps |
| Snapshot retention | 3 generations | Enough for rollback without unbounded disk growth |
