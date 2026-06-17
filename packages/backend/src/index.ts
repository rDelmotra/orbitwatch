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
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Middleware ────────────────────────────────────────────────────────────────

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc.)
// CSP extends helmet's defaults for the KTX2/Basis texture pipeline:
//   - worker-src 'self' blob:  → KTX2Loader spawns its transcoder Web Worker from a blob: URL
//   - script-src + 'wasm-unsafe-eval' → the Basis transcoder is WebAssembly (Chrome requires
//     this directive to compile WASM). Same-origin .ktx2/.wasm fetches stay under default-src.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'worker-src': ["'self'", 'blob:'],
    },
  },
}));

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
  app.use(express.static(frontendDist, {
    setHeaders: (res, filePath) => {
      // Long-cache the static GPU textures + Basis transcoder. Filenames are not
      // content-hashed, so cache-bust by renaming when a texture is swapped.
      if (filePath.includes('/textures/') || filePath.includes('/basis/')) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  }));
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
});

export default app;
