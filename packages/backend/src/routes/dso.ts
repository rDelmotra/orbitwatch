import { Router, type Request, type Response } from 'express';
import {
  getDsoRegistryEntry,
  getEnabledDsoRegistryEntries,
} from '../dso/registry/index.js';
import {
  readCurrentDsoSnapshot,
  readDsoCatalog,
  readDsoManifest,
} from '../dso/snapshot/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

function sendNotModifiedIfMatched(req: Request, res: Response, etag: string): boolean {
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }

  return false;
}

router.get('/catalog', async (req: Request, res: Response) => {
  const catalog = await readDsoCatalog();
  if (!catalog) {
    logger.warn('GET /api/dso/catalog: no catalog available yet');
    res.status(503).json({ error: 'DSO catalog not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${catalog.catalogVersion}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', etag);
  res.json(catalog);
});

router.get('/manifest', async (req: Request, res: Response) => {
  const manifest = await readDsoManifest();
  if (!manifest) {
    logger.warn('GET /api/dso/manifest: no manifest available yet');
    res.status(503).json({ error: 'DSO manifest not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${manifest.generatedAt}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('ETag', etag);
  res.json(manifest);
});

router.get('/ephemeris/:dsoId', async (req: Request, res: Response) => {
  const dsoId = req.params.dsoId;
  const entry = getDsoRegistryEntry(dsoId);

  if (!entry || !entry.enabled) {
    res.status(404).json({ error: 'Unknown or disabled DSO.' });
    return;
  }

  const manifest = await readDsoManifest();
  const status = manifest?.objects[entry.dsoId];
  if (!manifest || !status?.currentSnapshotVersion) {
    logger.warn(`GET /api/dso/ephemeris/${entry.dsoId}: no published snapshot available yet`);
    res.status(503).json({ error: 'DSO ephemeris not yet available. Try again shortly.' });
    return;
  }

  const etag = `"${status.currentSnapshotVersion}"`;
  if (sendNotModifiedIfMatched(req, res, etag)) {
    return;
  }

  const snapshot = await readCurrentDsoSnapshot(entry.dsoId, manifest);
  if (!snapshot) {
    logger.warn(`GET /api/dso/ephemeris/${entry.dsoId}: manifest points to missing snapshot`);
    res.status(503).json({ error: 'DSO ephemeris unavailable. Try again shortly.' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', etag);
  res.json(snapshot);
});

export function summarizeDsoHealth(manifest: Awaited<ReturnType<typeof readDsoManifest>>) {
  const enabledEntries = getEnabledDsoRegistryEntries();
  const summary = {
    dsoEnabledCount: enabledEntries.length,
    dsoFreshCount: 0,
    dsoStaleCount: 0,
    dsoDegradedCount: 0,
    dsoUnavailableCount: 0,
    dsoWorkerLastRunAt: manifest?.workerLastRunAt ?? null,
  };

  for (const entry of enabledEntries) {
    const state = manifest?.objects[entry.dsoId]?.freshnessState ?? 'unavailable';
    if (state === 'fresh') summary.dsoFreshCount += 1;
    else if (state === 'stale') summary.dsoStaleCount += 1;
    else if (state === 'degraded') summary.dsoDegradedCount += 1;
    else summary.dsoUnavailableCount += 1;
  }

  return summary;
}

export default router;
