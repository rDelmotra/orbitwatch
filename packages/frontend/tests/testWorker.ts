/**
 * SGP4 Worker smoke test — run via test-worker.html served by Vite (`npm run dev`).
 *
 * Validates:
 *   - Worker initialises and reports the correct object count
 *   - Both objects propagate with valid = 1
 *   - Magnitude (distance from Earth centre in Earth radii) is in expected range
 *       ISS (LEO)  : 1.03 – 1.10  (~420 km orbit)
 *       GEO sat    : 6.50 – 6.70  (~35 786 km orbit)
 *
 * Diagnostic hints:
 *   magnitude = 0          → INIT never arrived, or worker crashed silently
 *   magnitude ≈ 6371       → /6371 scaling step is missing from the worker
 *   magnitude ≈ 0.0001     → divided by 6371 twice, or wrong units somewhere
 */

// ── Types (mirror the worker's exported types locally) ────────────────────────

import type { OMMJsonObject } from 'satellite.js';

interface TLEInput {
    noradId: number;
    omm: OMMJsonObject;
}

type WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | {
          type: 'POSITIONS';
          positions: Float32Array;
          validFlags: Uint8Array;
          startIndex: number;
      };

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(msg: string): void {
    console.log(`✅ PASS  ${msg}`);
}

function fail(msg: string): void {
    console.error(`❌ FAIL  ${msg}`);
}

function check(condition: boolean, passMsg: string, failMsg: string): void {
    condition ? pass(passMsg) : fail(failMsg);
}

// ── Test data ─────────────────────────────────────────────────────────────────

const testTLEs: (TLEInput & { label: string; minMag: number; maxMag: number })[] = [
    {
        label: 'ISS (LEO)',
        noradId: 25544,
        // OMM @ epoch 2024-001 12:00 UTC — valid for ± days around epoch for a smoke test
        omm: {
            OBJECT_NAME: 'ISS (ZARYA)',
            OBJECT_ID: '1998-067A',
            EPOCH: '2024-01-01T12:00:00.000000Z',
            MEAN_MOTION: 15.50377579,
            ECCENTRICITY: 0.0007776,
            INCLINATION: 51.64,
            RA_OF_ASC_NODE: 337.664,
            ARG_OF_PERICENTER: 35.531,
            MEAN_ANOMALY: 330.368,
            EPHEMERIS_TYPE: 0,
            CLASSIFICATION_TYPE: 'U',
            NORAD_CAT_ID: 25544,
            ELEMENT_SET_NO: 999,
            REV_AT_EPOCH: 10001,
            BSTAR: 0.10270e-3,
            MEAN_MOTION_DOT: 0.00016717,
            MEAN_MOTION_DDOT: 0,
        },
        minMag: 1.03,
        maxMag: 1.10,
    },
    {
        label: 'Intelsat 39 (GEO)',
        noradId: 45700,
        omm: {
            OBJECT_NAME: 'INTELSAT 39',
            OBJECT_ID: '2020-041A',
            EPOCH: '2024-01-01T12:00:00.000000Z',
            MEAN_MOTION: 1.00271318,
            ECCENTRICITY: 0.0001765,
            INCLINATION: 0.0152,
            RA_OF_ASC_NODE: 98.6287,
            ARG_OF_PERICENTER: 214.008,
            MEAN_ANOMALY: 228.2349,
            EPHEMERIS_TYPE: 0,
            CLASSIFICATION_TYPE: 'U',
            NORAD_CAT_ID: 45700,
            ELEMENT_SET_NO: 999,
            REV_AT_EPOCH: 13494,
            BSTAR: 0,
            MEAN_MOTION_DOT: -0.00000302,
            MEAN_MOTION_DDOT: 0,
        },
        minMag: 6.50,
        maxMag: 6.70,
    },
];

// ── Create worker ─────────────────────────────────────────────────────────────

const worker = new Worker(
    new URL('../src/workers/sgp4.worker.ts', import.meta.url),
    { type: 'module' }
);

// ── Message handler ───────────────────────────────────────────────────────────

worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
    const msg = e.data;

    if (msg.type === 'READY') {
        console.group('── READY ──────────────────────────────────────');
        check(
            msg.objectCount === testTLEs.length,
            `objectCount = ${msg.objectCount}`,
            `objectCount = ${msg.objectCount}, expected ${testTLEs.length}`
        );
        console.groupEnd();

        // Propagate at the epoch time embedded in the TLEs (2024-001 12:00 UTC)
        const epochTimestamp = Date.UTC(2024, 0, 1, 12, 0, 0);
        worker.postMessage({ type: 'PROPAGATE', timestamp: epochTimestamp });
    }

    if (msg.type === 'POSITIONS') {
        console.group('── POSITIONS ──────────────────────────────────');
        console.log(`startIndex: ${msg.startIndex}`);
        console.log('');

        const pos = msg.positions;
        const valid = msg.validFlags;

        for (let i = 0; i < testTLEs.length; i++) {
            const sat = testTLEs[i];
            const x = pos[i * 3];
            const y = pos[i * 3 + 1];
            const z = pos[i * 3 + 2];
            const magnitude = Math.sqrt(x * x + y * y + z * z);

            console.group(`${sat.label}  (NORAD ${sat.noradId})`);
            check(valid[i] === 1, 'valid = 1', `valid = ${valid[i]}, expected 1`);
            console.log(`  ECEF (Earth radii): x=${x.toFixed(5)}  y=${y.toFixed(5)}  z=${z.toFixed(5)}`);
            console.log(`  magnitude : ${magnitude.toFixed(5)} Earth radii  (expected ${sat.minMag}–${sat.maxMag})`);
            check(
                magnitude >= sat.minMag && magnitude <= sat.maxMag,
                `magnitude ${magnitude.toFixed(5)} in range [${sat.minMag}, ${sat.maxMag}]`,
                `magnitude ${magnitude.toFixed(5)} OUT OF RANGE [${sat.minMag}, ${sat.maxMag}]`
            );
            console.groupEnd();
        }

        console.groupEnd();
        worker.terminate();
        console.log('Worker terminated. Test complete.');
    }
};

worker.onerror = (err) => {
    console.error('❌ Worker error:', err.message);
};

// ── Kick off ──────────────────────────────────────────────────────────────────

worker.postMessage({ type: 'INIT', tles: testTLEs, startIndex: 0 });
