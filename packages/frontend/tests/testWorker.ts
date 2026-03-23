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

interface TLEInput {
    noradId: number;
    line1: string;
    line2: string;
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
        // TLE epoch 2024-001 — valid for ± days around epoch for a smoke test
        line1: '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993',
        line2: '2 25544  51.6400 337.6640 0007776  35.5310 330.3680 15.50377579 10001',
        minMag: 1.03,
        maxMag: 1.10,
    },
    {
        label: 'Intelsat 39 (GEO)',
        noradId: 45700,
        line1: '1 45700U 20041A   24001.50000000 -.00000302  00000-0  00000-0 0  9994',
        line2: '2 45700   0.0152  98.6287 0001765 214.0080 228.2349  1.00271318 13494',
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
