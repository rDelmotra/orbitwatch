/**
 * SGP4 Propagation Web Worker
 *
 * Receives TLE data, parses into satrec objects, and on each PROPAGATE tick
 * computes ECI (TEME) positions for every object using satellite.js SGP4/SDP4.
 *
 * Output is raw ECI (TEME) coordinates scaled to Earth radii (6371 km = 1.0).
 * No axis swap — the renderer handles ECI → Three.js conversion.
 *
 * Uses double-buffered Transferable ArrayBuffers for zero-copy transfer.
 */

import * as satellite from 'satellite.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface TLEInput {
    noradId: number;
    line1: string;
    line2: string;
}

type WorkerInMessage =
    | { type: 'INIT'; tles: TLEInput[]; startIndex: number }
    | { type: 'PROPAGATE'; timestamp: number };

type WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | {
        type: 'POSITIONS';
        positions: Float32Array;
        validFlags: Uint8Array;
        startIndex: number;
    };

// ── State ────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

let satrecs: satellite.SatRec[] = [];
let startIndex = 0;
let objectCount = 0;

// Double-buffered output arrays. After a Transferable transfer the buffer is
// detached (length 0), so we keep two sets and alternate.
let bufferSetA: { positions: Float32Array; validFlags: Uint8Array } | null = null;
let bufferSetB: { positions: Float32Array; validFlags: Uint8Array } | null = null;
let useSetA = true;

function allocateBuffers(count: number): void {
    bufferSetA = {
        positions: new Float32Array(count * 3),
        validFlags: new Uint8Array(count),
    };
    bufferSetB = {
        positions: new Float32Array(count * 3),
        validFlags: new Uint8Array(count),
    };
}

/**
 * Return whichever buffer set is currently available (not detached).
 * If the active set was detached by a previous transfer, reallocate it
 * and swap to the other set for next time.
 */
function getActiveBuffers(): { positions: Float32Array; validFlags: Uint8Array } {
    if (useSetA) {
        // If buffer A was detached by a previous Transferable transfer, reallocate
        if (!bufferSetA || bufferSetA.positions.buffer.byteLength === 0) {
            bufferSetA = {
                positions: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = false; // next call uses B
        return bufferSetA;
    } else {
        if (!bufferSetB || bufferSetB.positions.buffer.byteLength === 0) {
            bufferSetB = {
                positions: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = true; // next call uses A
        return bufferSetB;
    }
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
    const msg = e.data;

    switch (msg.type) {
        case 'INIT':
            handleInit(msg.tles, msg.startIndex);
            break;
        case 'PROPAGATE':
            handlePropagate(msg.timestamp);
            break;
    }
};

// ── INIT ─────────────────────────────────────────────────────────────────────

function handleInit(tles: TLEInput[], start: number): void {
    startIndex = start;
    objectCount = tles.length;
    satrecs = new Array(objectCount);

    for (let i = 0; i < objectCount; i++) {
        try {
            satrecs[i] = satellite.twoline2satrec(tles[i].line1, tles[i].line2);
        } catch {
            // If parsing fails, store a placeholder — propagate will flag it invalid
            satrecs[i] = null as unknown as satellite.SatRec;
        }
    }

    allocateBuffers(objectCount);

    const reply: WorkerOutMessage = { type: 'READY', objectCount };
    (self as unknown as Worker).postMessage(reply);
}

// ── PROPAGATE ────────────────────────────────────────────────────────────────

function handlePropagate(timestamp: number): void {
    const date = new Date(timestamp);

    const { positions, validFlags } = getActiveBuffers();

    for (let i = 0; i < objectCount; i++) {
        const rec = satrecs[i];

        // Handle null satrec from failed parse
        if (!rec) {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = 0;
            validFlags[i] = 0;
            continue;
        }

        const result = satellite.propagate(rec, date);
        const posEci = result?.position;

        // propagate returns { position: false } on failure
        if (!posEci || typeof posEci === 'boolean') {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = 0;
            validFlags[i] = 0;
            continue;
        }

        // Scale ECI (TEME) from km to Earth radii (6371 km = 1.0)
        positions[i * 3] = posEci.x / EARTH_RADIUS_KM;
        positions[i * 3 + 1] = posEci.y / EARTH_RADIUS_KM;
        positions[i * 3 + 2] = posEci.z / EARTH_RADIUS_KM;
        validFlags[i] = 1;
    }

    // Transfer ownership (zero-copy). After this, positions.buffer and
    // validFlags.buffer become detached in this worker — length goes to 0.
    // Next tick we'll use the other buffer set (or reallocate if needed).
    const reply: WorkerOutMessage = {
        type: 'POSITIONS',
        positions,
        validFlags,
        startIndex,
    };

    (self as unknown as Worker).postMessage(reply, [
        positions.buffer,
        validFlags.buffer,
    ]);
}