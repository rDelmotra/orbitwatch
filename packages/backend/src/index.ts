import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import tleRouter from './routes/tle.js';
import dsoRouter, { summarizeDsoHealth } from './routes/dso.js';
import { isCacheFresh, readVersion } from './cache/file-cache.js';
import { scheduleTLEUpdater } from './cron/tle-updater.js';
import { readDsoManifest } from './dso/snapshot/index.js';
import { startDsoWorkerLoop } from './dso/worker/index.js';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Middleware ────────────────────────────────────────────────────────────────

// Security headers — configured to allow the external resources the frontend needs:
//   - blob: workers (Vite bundles Web Workers as blob URLs in production)
//   - ESRI World Imagery tiles (server.arcgisonline.com)
//   - NASA GIBS Black Marble tiles (gibs.earthdata.nasa.gov)
//   - Takram atmosphere LUTs + STBN blue-noise (media.githubusercontent.com)
// CSP extends helmet's defaults for the KTX2/Basis texture pipeline:
//   - worker-src 'self' blob:  → KTX2Loader spawns its transcoder Web Worker from a blob: URL
//   - script-src + 'unsafe-eval' → the Basis transcoder is an Emscripten/embind WASM build that
//     uses `new Function(...)` (craftInvokerFunction) to build its bindings, which needs full
//     'unsafe-eval' (the narrower 'wasm-unsafe-eval' only allows WASM *compilation*). Blob
//     workers inherit the document CSP and can't be given a narrower policy, so this applies
//     app-wide — an accepted tradeoff for a public, auth-less 3D viewer.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://server.arcgisonline.com',
          'https://services.arcgisonline.com',
          'https://gibs.earthdata.nasa.gov',
          'https://media.githubusercontent.com',
        ],
        connectSrc: [
          "'self'",
          'https://server.arcgisonline.com',
          'https://services.arcgisonline.com',
          'https://gibs.earthdata.nasa.gov',
          'https://media.githubusercontent.com',
        ],
        workerSrc: ["'self'", 'blob:'],
        childSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    // Allow cross-origin requests for tile/texture resources embedded via Three.js
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

// CORS — restrict to frontend domain in production, allow all in dev.
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));

// Rate limiting on API routes — prevents abuse of the large TLE payload.
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
}));

// Gzip all JSON responses.  For the full TLE dataset (~4–6 MB uncompressed)
// this reduces payload to ~500 KB–1 MB.
app.use(compression());

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/tle', tleRouter);
app.use('/api/dso', dsoRouter);

// GET /health — used by load balancers and uptime monitors
app.get('/health', async (_req, res) => {
  const version = readVersion();
  const dsoManifest = await readDsoManifest();
  res.json({
    status: 'ok',
    lastUpdate: version?.version ?? null,
    objectCount: version?.count ?? 0,
    uptime: Math.floor(process.uptime()),
    ...summarizeDsoHealth(dsoManifest),
  });
});

// ── Static frontend (production only) ────────────────────────────────────────
if (isProd) {
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  // Long cache for static textures and basis transcoder (unhashed public/ copies — revalidate after 7 days)
  app.use('/textures', express.static(path.join(frontendDist, 'textures'), {
    maxAge: '7d',
  }));
  app.use('/basis', express.static(path.join(frontendDist, 'basis'), {
    maxAge: '7d',
  }));
  // Immutable caching for Vite content-hashed JS/CSS bundles
  app.use('/assets', express.static(path.join(frontendDist, 'assets'), {
    maxAge: '30d',
    immutable: true,
  }));

  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`OrbitWatch backend listening on port ${PORT}`);

  // If the cache is missing or older than the 24h TTL, kick off an immediate fetch.
  // The cron job is always scheduled so subsequent refreshes happen daily at 02:00 UTC.
  const needsImmediateFetch = !isCacheFresh();
  scheduleTLEUpdater(needsImmediateFetch);

  if (!needsImmediateFetch) {
    const version = readVersion();
    logger.info(`Serving cached data: ${version?.count} objects, version=${version?.version}`);
  }

  // ── DSO Worker (in-process) ────────────────────────────────────────────────
  // In dev mode the DSO worker runs as a separate process via `concurrently`.
  // In production we run it in the same process so Railway only needs one service.
  if (isProd) {
    const dsoWorker = startDsoWorkerLoop();
    logger.info('DSO worker started in-process (production mode)');

    const stopDso = (signal: string) => {
      logger.info(`Received ${signal}; stopping DSO worker`);
      dsoWorker.stop();
    };
    process.on('SIGINT', stopDso);
    process.on('SIGTERM', stopDso);

    dsoWorker.run.catch((error) => {
      logger.error('DSO worker exited with an unrecoverable error:', error);
    });
  }
});

export default app;
